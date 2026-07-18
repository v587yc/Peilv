import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit-log";
import { requireAdminCapability } from "@/lib/auth/admin-capabilities";
import { CommandConflictError } from "@/features/management/commands";
import { createSupabaseCommandRepository } from "@/features/management/command-repository";
import { executeDeploymentDispatch } from "@/lib/release-control/dispatch-command";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { validateCandidateBinding } from "@/lib/release-control/validation";
import { auditDeploymentRejection } from "@/lib/release-control/audit";
import {
  dispatchPreflight,
  getRun,
  listOperations,
  listRunArtifacts,
} from "@/lib/github/github-actions-adapter";

const inputSchema = z.object({
  runId: z.number().int().positive(),
  runAttempt: z.number().int().positive(),
  artifactId: z.number().int().positive(),
  releaseId: z.string().regex(/^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/),
  reason: z.string().trim().min(3).max(300),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

function response(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: NextRequest) {
  const authorization = await requireAdminCapability(request, "admin:dangerous");
  if (!authorization.ok) return response({ success: false, error: authorization.error }, authorization.status);
  const actor = authorization.principal;

  const suppliedRequestId = request.headers.get("x-request-id");
  const requestId = suppliedRequestId && z.string().uuid().safeParse(suppliedRequestId).success
    ? suppliedRequestId
    : randomUUID();
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const audited = await auditDeploymentRejection({ action: "deployment.preflight", principal: actor, requestId, error: "候选参数无效" });
    return response({ success: false, error: audited ? "候选参数无效" : "审计记录写入失败" }, audited ? 400 : 503);
  }

  const input = parsed.data;
  try {
    const execution = await executeDeploymentDispatch({
      action: "deployment.preflight",
      command: { idempotencyKey: input.idempotencyKey, reason: input.reason, payload: {
        runId: input.runId, runAttempt: input.runAttempt, artifactId: input.artifactId, releaseId: input.releaseId,
      } },
      principal: actor,
      requestId,
      repository: createSupabaseCommandRepository(getSupabaseClient()),
      audit: writeAuditLog,
      execute: async () => {
        const [run, artifacts, operations] = await Promise.all([
      getRun(input.runId),
      listRunArtifacts(input.runId),
      listOperations(),
        ]);
        const expectedReleaseId = `r${run.id}-a${run.run_attempt}-${run.head_sha.slice(0, 12)}`;
        const artifact = artifacts.find(value => value.id === input.artifactId);
        const hasActiveProductionOperation = [...operations.deploy, ...operations.rollback]
          .some(value => value.status !== "completed");
        if (hasActiveProductionOperation || validateCandidateBinding({ run, artifact, runAttempt: input.runAttempt, artifactId: input.artifactId, releaseId: input.releaseId })) {
          throw new CommandConflictError("候选已变化、过期或不再满足预检条件");
        }
        if (!artifact) throw new CommandConflictError("候选制品不存在");

        await dispatchPreflight({
      sourceRunId: run.id,
      sourceRunAttempt: run.run_attempt,
      sourceArtifactId: artifact.id,
      commitSha: run.head_sha,
      releaseId: expectedReleaseId,
      requestId,
        });

        return { requestId, releaseId: expectedReleaseId };
      },
    });

    return response({ success: true, ...execution.result, replayed: execution.replayed }, execution.replayed ? 200 : 202);
  } catch (error) {
    if (error instanceof CommandConflictError) return response({ success: false, error: error.message }, 409);
    return response({ success: false, error: "无法验证候选或触发生产预检" }, 503);
  }
}
