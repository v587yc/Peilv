import { hasAdminCapability, type AdminPrincipal } from "@/lib/auth/admin-capabilities";
import { sanitizeAuditValue } from "@/lib/audit-log";
import { AuditPersistenceError, canonicalCommandHash, CommandConflictError, requireAuditPersistence, type CommandAudit, type CommandRepository } from "@/features/management/commands";
import { findManagementDescriptor } from "@/features/management/registry";

export type DeploymentDispatchCommand<T> = {
  idempotencyKey: string;
  reason: string;
  payload: T;
};

export async function executeDeploymentDispatch<TPayload, TResult>(input: {
  action: string;
  command: DeploymentDispatchCommand<TPayload>;
  principal: AdminPrincipal;
  requestId: string;
  repository: CommandRepository;
  audit: CommandAudit;
  execute: () => Promise<TResult>;
}): Promise<{ replayed: boolean; result: TResult; commandStatus: "accepted" | "effect_started" | "audit_pending" | "completed" | "receipt_persistence_uncertain" }> {
  const descriptor = findManagementDescriptor(input.action);
  if (!descriptor || descriptor.category !== "deployment" || !descriptor.writeCapability) {
    const error = new Error("未知部署管理命令");
    await auditDeployment(input, "rejected", error);
    throw error;
  }
  if (!hasAdminCapability(input.principal, descriptor.writeCapability)) {
    const error = new Error("权限不足");
    await auditDeployment(input, "rejected", error);
    throw error;
  }
  const canonicalPayload = { reason: input.command.reason, payload: input.command.payload };
  const hash = canonicalCommandHash(canonicalPayload);
  const receiptCommand = {
    targetId: input.action,
    reason: input.command.reason,
    idempotencyKey: input.command.idempotencyKey,
    payload: input.command.payload,
  };
  const begun = await input.repository.begin(
    input.action,
    receiptCommand,
    hash,
    input.principal.actorId,
    input.requestId,
  );
  if (!begun.created) {
    if (begun.receipt.request_hash !== hash) throw new CommandConflictError("幂等键已用于不同部署请求");
    if (["completed", "succeeded"].includes(begun.receipt.status)) {
      return { replayed: true, result: begun.receipt.result_reference as TResult, commandStatus: "completed" };
    }
    const recoverableStarted = begun.receipt.status === "effect_started" && begun.receipt.result_reference !== null && begun.receipt.result_reference !== undefined && begun.receipt.audit_context?.effectSucceeded === true;
    if (["effect_succeeded", "audit_pending"].includes(begun.receipt.status) || recoverableStarted) {
      const result = begun.receipt.result_reference as TResult;
      try {
        if (begun.receipt.status === "effect_started") await input.repository.transition(input.action, input.command.idempotencyKey, ["effect_started"], "effect_succeeded", result);
        if (begun.receipt.status !== "audit_pending") await input.repository.transition(input.action, input.command.idempotencyKey, ["effect_succeeded"], "audit_pending", result);
        await requireAuditPersistence(input.audit, deploymentSucceededAudit(input, result));
        await input.repository.succeed(input.action, input.command.idempotencyKey, result);
        return { replayed: true, result, commandStatus: "completed" };
      } catch {
        return { replayed: true, result, commandStatus: "audit_pending" };
      }
    }
    if (["accepted", "executing", "effect_started", "effect_succeeded", "audit_pending"].includes(begun.receipt.status)) {
      return { replayed: true, result: begun.receipt.result_reference as TResult, commandStatus: begun.receipt.status === "audit_pending" ? "audit_pending" : begun.receipt.status === "effect_started" || begun.receipt.status === "effect_succeeded" ? "effect_started" : "accepted" };
    }
    throw new CommandConflictError(begun.receipt.safe_error || "相同部署请求此前失败，请使用新的幂等键重试");
  }

  let effectOccurred = false;
  let effectResult: TResult | undefined;
  try {
    await requireAuditPersistence(input.audit, {
      actorId: input.principal.actorId,
      actorType: "admin",
      action: `${input.action}.requested`,
      objectType: "deployment",
      objectId: deploymentObjectId(input.command.payload, input.action),
      requestId: input.requestId,
      idempotencyKey: input.command.idempotencyKey,
      metadata: { reason: input.command.reason.slice(0, 500) },
    });
    await input.repository.transition(input.action, input.command.idempotencyKey, ["accepted", "executing"], "effect_started");
    const result = await input.execute();
    effectOccurred = true;
    effectResult = result;
    const sanitized = sanitizeAuditValue(result);
    try {
      await input.repository.transition(input.action, input.command.idempotencyKey, ["effect_started"], "effect_succeeded", sanitized);
    } catch {
      try { await input.repository.recordEffectResult(input.action, input.command.idempotencyKey, sanitized); } catch { /* caller receives an explicit durable-unknown outcome */ }
      return { replayed: false, result, commandStatus: "receipt_persistence_uncertain" };
    }
    try {
      await input.repository.transition(input.action, input.command.idempotencyKey, ["effect_succeeded"], "audit_pending", sanitized);
      await requireAuditPersistence(input.audit, deploymentSucceededAudit(input, sanitized));
      await input.repository.succeed(input.action, input.command.idempotencyKey, sanitized);
      return { replayed: false, result, commandStatus: "completed" };
    } catch {
      return { replayed: false, result, commandStatus: "audit_pending" };
    }
  } catch (error) {
    if (effectOccurred) {
      try { await input.repository.recordEffectResult(input.action, input.command.idempotencyKey, sanitizeAuditValue(effectResult)); } catch { /* receipt may already have advanced */ }
      return { replayed: false, result: effectResult as TResult, commandStatus: "receipt_persistence_uncertain" };
    }
    const safeError = error instanceof Error ? error.message.slice(0, 500) : "部署请求失败";
    await input.repository.fail(input.action, input.command.idempotencyKey, safeError);
    if (!(error instanceof AuditPersistenceError)) await auditDeployment(input, "failed", error);
    throw error;
  }
}

function deploymentSucceededAudit<TPayload, TResult>(input: Parameters<typeof executeDeploymentDispatch<TPayload, TResult>>[0], result: unknown): Parameters<CommandAudit>[0] {
  return { actorId: input.principal.actorId, actorType: "admin", action: `${input.action}.succeeded`, objectType: "deployment", objectId: deploymentObjectId(input.command.payload, input.action), requestId: input.requestId, idempotencyKey: input.command.idempotencyKey, newValue: result, metadata: { reason: input.command.reason, status: "succeeded" } };
}

async function auditDeployment<TPayload, TResult>(
  input: Parameters<typeof executeDeploymentDispatch<TPayload, TResult>>[0],
  outcome: "rejected" | "failed",
  error: unknown,
): Promise<void> {
  await requireAuditPersistence(input.audit, {
    actorId: input.principal.actorId,
    actorType: "admin",
    action: `${input.action}.${outcome}`,
    objectType: "deployment",
    objectId: deploymentObjectId(input.command.payload, input.action),
    requestId: input.requestId,
    idempotencyKey: input.command.idempotencyKey,
    metadata: {
      reason: input.command.reason.slice(0, 500),
      error: error instanceof Error ? error.message.slice(0, 500) : "部署命令失败",
    },
  });
}

function deploymentObjectId(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fallback;
  const value = payload as Record<string, unknown>;
  for (const key of ["releaseId", "targetReleaseId", "expectedCurrentReleaseId"]) {
    if (typeof value[key] === "string") return String(value[key]).slice(0, 200);
  }
  return fallback;
}
