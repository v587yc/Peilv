import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit-log";
import { requireAdminCapability } from "@/lib/auth/admin-capabilities";
import { CommandConflictError } from "@/features/management/commands";
import { createSupabaseCommandRepository } from "@/features/management/command-repository";
import { executeDeploymentDispatch } from "@/lib/release-control/dispatch-command";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { validateCandidateBinding, validatePreflightBinding } from "@/lib/release-control/validation";
import { auditDeploymentRejection } from "@/lib/release-control/audit";
import {
  dispatchDeploy,
  getRun,
  listOperations,
  listRunArtifacts,
} from "@/lib/github/github-actions-adapter";

const releaseIdSchema = z.string().regex(/^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/);
const inputSchema = z.object({
  preflightRunId: z.number().int().positive(),
  releaseId: releaseIdSchema,
  confirmation: releaseIdSchema,
  reason: z.string().trim().min(3).max(300),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

function response(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function parseRequestId(request: Request) {
  const supplied = request.headers.get("x-request-id");
  return supplied && z.string().uuid().safeParse(supplied).success ? supplied : randomUUID();
}

export async function POST(request: NextRequest) {
  const authorization = await requireAdminCapability(request, "admin:dangerous");
  if (!authorization.ok) return response({ success: false, error: authorization.error }, authorization.status);
  const actor = authorization.principal;
  const requestId = parseRequestId(request);
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.confirmation !== parsed.data.releaseId) {
    const error = "必须输入完整 release ID 确认部署";
    const audited = await auditDeploymentRejection({ action: "deployment.deploy", principal: actor, requestId, error });
    return response({ success: false, error: audited ? error : "审计记录写入失败" }, audited ? 400 : 503);
  }

  const input = parsed.data;
  try {
    const execution = await executeDeploymentDispatch({
      action: "deployment.deploy",
      command: { idempotencyKey: input.idempotencyKey, reason: input.reason, payload: {
        preflightRunId: input.preflightRunId, releaseId: input.releaseId, confirmation: input.confirmation,
      } },
      principal: actor,
      requestId,
      repository: createSupabaseCommandRepository(getSupabaseClient()),
      audit: writeAuditLog,
      execute: async () => {
        const [preflightRun, artifacts, operations] = await Promise.all([
      getRun(input.preflightRunId),
      listRunArtifacts(input.preflightRunId),
      listOperations(),
        ]);
    if ([...operations.deploy, ...operations.rollback].some(value => value.status !== "completed")) {
      throw new CommandConflictError("已有部署或回退正在执行");
    }

    const resultArtifact = artifacts.find(value => value.name.startsWith("preflight-result-") && !value.expired);
    const preflightError = validatePreflightBinding({ run: preflightRun, artifact: resultArtifact, releaseId: input.releaseId });
    if (preflightError) throw new CommandConflictError(preflightError);
    if (!resultArtifact) throw new CommandConflictError("预检结果制品不存在");

    const candidateMatch = /^r([1-9][0-9]*)-a([1-9][0-9]*)-([0-9a-f]{12})$/.exec(input.releaseId);
    if (!candidateMatch) throw new CommandConflictError("release ID 无效");
    const sourceRunId = Number(candidateMatch[1]);
    const sourceRunAttempt = Number(candidateMatch[2]);
    const [sourceRun, sourceArtifacts] = await Promise.all([
      getRun(sourceRunId),
      listRunArtifacts(sourceRunId),
    ]);
    const sourceArtifact = sourceArtifacts.find(value =>
      value.name === `peilv-candidate-${sourceRunId}-${sourceRunAttempt}` && !value.expired,
    );
    if (validateCandidateBinding({ run: sourceRun, artifact: sourceArtifact, runAttempt: sourceRunAttempt, releaseId: input.releaseId })) {
      throw new CommandConflictError("源候选已变化或过期");
    }
    if (!sourceArtifact) throw new CommandConflictError("源候选制品不存在");

    await dispatchDeploy({
      sourceRunId,
      sourceRunAttempt,
      sourceArtifactId: sourceArtifact.id,
      preflightRunId: preflightRun.id,
      preflightArtifactId: resultArtifact.id,
      commitSha: sourceRun.head_sha,
      releaseId: input.releaseId,
      requestId,
    });
        return { requestId, releaseId: input.releaseId };
      },
    });
    return response({ success: true, ...execution.result, replayed: execution.replayed }, execution.replayed ? 200 : 202);
  } catch (error) {
    if (error instanceof CommandConflictError) return response({ success: false, error: error.message }, 409);
    return response({ success: false, error: "无法验证预检与候选绑定" }, 503);
  }
}
