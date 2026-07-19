import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit-log";
import { requireAdminCapability } from "@/lib/auth/admin-capabilities";
import { dispatchRollback, listOperations } from "@/lib/github/github-actions-adapter";
import { getDeploymentOverview } from "@/lib/release-control/service";
import { CommandConflictError } from "@/features/management/commands";
import { createSupabaseCommandRepository } from "@/features/management/command-repository";
import { executeDeploymentDispatch } from "@/lib/release-control/dispatch-command";
import { auditDeploymentRejection } from "@/lib/release-control/audit";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const releaseIdSchema = z.string().regex(/^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/);
const inputSchema = z.object({
  targetReleaseId: releaseIdSchema,
  expectedCurrentReleaseId: releaseIdSchema,
  confirmation: releaseIdSchema,
  reason: z.string().trim().min(10).max(300),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

function response(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  const authorization = await requireAdminCapability(request, "admin:dangerous");
  if (!authorization.ok) return response({ success: false, error: authorization.error }, authorization.status);
  const actor = authorization.principal;
  const supplied = request.headers.get("x-request-id");
  const requestId = supplied && z.string().uuid().safeParse(supplied).success ? supplied : randomUUID();
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.confirmation !== parsed.data.targetReleaseId) {
    const error = "必须输入完整目标 release ID 确认回退";
    const audited = await auditDeploymentRejection({ action: "deployment.rollback", principal: actor, requestId, error });
    return response({ success: false, error: audited ? error : "审计记录写入失败" }, audited ? 400 : 503);
  }
  const input = parsed.data;
  if (input.targetReleaseId === input.expectedCurrentReleaseId) {
    const error = "回退目标不能是当前版本";
    const audited = await auditDeploymentRejection({ action: "deployment.rollback", principal: actor, requestId, error });
    return response({ success: false, error: audited ? error : "审计记录写入失败" }, audited ? 400 : 503);
  }

  try {
    const execution = await executeDeploymentDispatch({
      action: "deployment.rollback",
      command: { idempotencyKey: input.idempotencyKey, reason: input.reason, payload: {
        targetReleaseId: input.targetReleaseId,
        expectedCurrentReleaseId: input.expectedCurrentReleaseId,
        confirmation: input.confirmation,
      } },
      principal: actor,
      requestId,
      repository: createSupabaseCommandRepository(getSupabaseClient()),
      audit: writeAuditLog,
      execute: async () => {
        const [overview, operations] = await Promise.all([getDeploymentOverview(), listOperations()]);
    if (overview.currentRelease !== input.expectedCurrentReleaseId) {
      throw new CommandConflictError("当前生产版本已变化，请刷新后重试");
    }
    if ([...operations.deploy, ...operations.rollback].some(value => value.status !== "completed")) {
      throw new CommandConflictError("已有部署或回退正在执行");
    }
    // Installed legacy releases without structured deployment history are deliberately absent.
    // The server remains authoritative and rejects missing/invalid manifests and all unsafe migrations.
    if (overview.previousRelease !== input.targetReleaseId) {
      throw new CommandConflictError("目标版本未确认安装、manifest 无效或 schema 不兼容");
    }

    await dispatchRollback({
      targetReleaseId: input.targetReleaseId,
      expectedCurrentReleaseId: input.expectedCurrentReleaseId,
      requestId,
      reason: input.reason,
    });
        return { requestId, targetReleaseId: input.targetReleaseId };
      },
    });
    return response({ success: true, ...execution.result, replayed: execution.replayed }, execution.replayed ? 200 : 202);
  } catch (error) {
    if (error instanceof CommandConflictError) return response({ success: false, error: error.message }, 409);
    return response({ success: false, error: "无法验证或触发代码回退" }, 503);
  }
}
