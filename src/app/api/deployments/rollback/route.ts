import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit-log";
import { authorizeDeploymentRequest } from "@/lib/deployment-auth";
import { dispatchRollback, listOperations } from "@/lib/github/github-actions-adapter";
import { getDeploymentOverview } from "@/lib/release-control/service";

const releaseIdSchema = z.string().regex(/^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/);
const inputSchema = z.object({
  targetReleaseId: releaseIdSchema,
  expectedCurrentReleaseId: releaseIdSchema,
  confirmation: releaseIdSchema,
  reason: z.string().trim().min(10).max(300),
}).strict();

function response(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  const actor = authorizeDeploymentRequest(request);
  if (!actor) return response({ success: false, error: "需要部署控制台登录" }, 401);
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.confirmation !== parsed.data.targetReleaseId) {
    return response({ success: false, error: "必须输入完整目标 release ID 确认回退" }, 400);
  }
  const input = parsed.data;
  if (input.targetReleaseId === input.expectedCurrentReleaseId) {
    return response({ success: false, error: "回退目标不能是当前版本" }, 400);
  }
  const supplied = request.headers.get("x-request-id");
  const requestId = supplied && z.string().uuid().safeParse(supplied).success ? supplied : randomUUID();

  try {
    const [overview, operations] = await Promise.all([getDeploymentOverview(), listOperations()]);
    if (overview.currentRelease !== input.expectedCurrentReleaseId) {
      return response({ success: false, error: "当前生产版本已变化，请刷新后重试" }, 409);
    }
    if ([...operations.deploy, ...operations.rollback].some(value => value.status !== "completed")) {
      return response({ success: false, error: "已有部署或回退正在执行" }, 409);
    }
    // Installed legacy releases without structured deployment history are deliberately absent.
    // The server remains authoritative and rejects missing/invalid manifests and all unsafe migrations.
    const knownTarget = overview.candidates.some(value => value.releaseId === input.targetReleaseId) ||
      overview.operations.some(value => value.kind === "deploy" && value.title.includes(input.targetReleaseId) && value.status === "succeeded");
    if (!knownTarget) return response({ success: false, error: "目标版本元数据不足，需要人工介入" }, 409);

    await dispatchRollback({
      targetReleaseId: input.targetReleaseId,
      expectedCurrentReleaseId: input.expectedCurrentReleaseId,
      requestId,
      reason: input.reason,
    });
    await writeAuditLog({
      actorId: actor.actorId,
      actorType: actor.actorType,
      action: "deployment_rollback_dispatch",
      objectType: "release",
      objectId: input.targetReleaseId,
      requestId,
      idempotencyKey: `deployment-rollback:${requestId}`,
      oldValue: { currentReleaseId: input.expectedCurrentReleaseId },
      newValue: { targetReleaseId: input.targetReleaseId },
      metadata: { username: actor.username, reason: input.reason, databaseRestore: false },
    });
    return response({ success: true, requestId }, 202);
  } catch {
    return response({ success: false, error: "无法验证或触发代码回退" }, 503);
  }
}
