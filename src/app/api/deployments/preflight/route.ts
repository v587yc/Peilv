import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit-log";
import { authorizeDeploymentRequest } from "@/lib/deployment-auth";
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
}).strict();

function response(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: NextRequest) {
  const actor = authorizeDeploymentRequest(request);
  if (!actor) return response({ success: false, error: "需要部署控制台登录" }, 401);

  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return response({ success: false, error: "候选参数无效" }, 400);

  const input = parsed.data;
  const suppliedRequestId = request.headers.get("x-request-id");
  const requestId = suppliedRequestId && z.string().uuid().safeParse(suppliedRequestId).success
    ? suppliedRequestId
    : randomUUID();
  try {
    const [run, artifacts, operations] = await Promise.all([
      getRun(input.runId),
      listRunArtifacts(input.runId),
      listOperations(),
    ]);
    const expectedReleaseId = `r${run.id}-a${run.run_attempt}-${run.head_sha.slice(0, 12)}`;
    const artifact = artifacts.find(value => value.id === input.artifactId);
    const hasActiveProductionOperation = [...operations.deploy, ...operations.rollback]
      .some(value => value.status !== "completed");
    if (
      run.event !== "push" ||
      run.head_branch !== "main" ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      run.run_attempt !== input.runAttempt ||
      input.releaseId !== expectedReleaseId ||
      hasActiveProductionOperation ||
      !artifact ||
      artifact.expired ||
      artifact.name !== `peilv-candidate-${run.id}-${run.run_attempt}` ||
      (artifact.workflow_run && (artifact.workflow_run.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha))
    ) {
      return response({ success: false, error: "候选已变化、过期或不再满足预检条件" }, 409);
    }

    await dispatchPreflight({
      sourceRunId: run.id,
      sourceRunAttempt: run.run_attempt,
      sourceArtifactId: artifact.id,
      commitSha: run.head_sha,
      releaseId: expectedReleaseId,
      requestId,
    });

    await writeAuditLog({
      actorId: actor.actorId,
      actorType: actor.actorType,
      action: "deployment_preflight_dispatch",
      objectType: "release_candidate",
      objectId: expectedReleaseId,
      requestId,
      idempotencyKey: `deployment-preflight:${requestId}`,
      newValue: {
        sourceRunId: run.id,
        sourceRunAttempt: run.run_attempt,
        sourceArtifactId: artifact.id,
        commitSha: run.head_sha,
      },
      metadata: { username: actor.username },
    });

    return response({ success: true, requestId }, 202);
  } catch {
    return response({ success: false, error: "无法验证候选或触发生产预检" }, 503);
  }
}
