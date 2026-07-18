import { createHash } from "node:crypto";
import { findManagementDescriptor } from "./registry";
import type { AdminPrincipal } from "@/lib/auth/admin-capabilities";
import { hasAdminCapability } from "@/lib/auth/admin-capabilities";
import { sanitizeAuditValue } from "@/lib/audit-log";

export type AdminCommand<T> = { targetId: string; reason: string; idempotencyKey: string; confirmation?: string; payload: T };
export type CommandStatus = "accepted" | "effect_started" | "effect_succeeded" | "audit_pending" | "completed" | "failed" | "executing" | "succeeded";
export type CommandReceipt = { status: CommandStatus; request_hash: string; result_reference: unknown; safe_error: string | null; audit_context?: Record<string, unknown> | null };
export type CommandRepository = {
  begin(action: string, command: AdminCommand<unknown>, hash: string, actorId: string, requestId: string | null): Promise<{ created: boolean; receipt: CommandReceipt }>;
  transition(action: string, key: string, from: readonly CommandStatus[], to: CommandStatus, result?: unknown): Promise<void>;
  succeed(action: string, key: string, result: unknown): Promise<void>;
  fail(action: string, key: string, safeError: string): Promise<void>;
  recordEffectResult(action: string, key: string, result: unknown): Promise<void>;
};
export type CommandAudit = (entry: { actorId: string; actorType: "admin"; action: string; objectType: string; objectId: string; requestId: string | null; idempotencyKey: string; newValue?: unknown; metadata: Record<string, unknown> }) => Promise<boolean>;

export class CommandConflictError extends Error { status = 409 as const; }
export class AuditPersistenceError extends Error { status = 503 as const; }
export class CommandInputError extends Error { status = 400 as const; }

export async function requireAuditPersistence(audit: CommandAudit, entry: Parameters<CommandAudit>[0]): Promise<void> {
  try {
    if (!await audit(entry)) throw new AuditPersistenceError("审计记录写入失败");
  } catch (error) {
    if (error instanceof AuditPersistenceError) throw error;
    throw new AuditPersistenceError("审计记录写入失败");
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

export function canonicalCommandHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function validateAdminCommand<T>(value: unknown): AdminCommand<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommandInputError("管理命令格式无效");
  const command = value as Record<string, unknown>;
  if (typeof command.targetId !== "string" || !command.targetId.trim()) throw new CommandInputError("缺少管理目标");
  if (typeof command.reason !== "string" || command.reason.trim().length < 3 || command.reason.length > 500) throw new CommandInputError("操作原因格式无效");
  if (typeof command.idempotencyKey !== "string" || command.idempotencyKey.trim().length < 8 || command.idempotencyKey.length > 200) throw new CommandInputError("幂等键格式无效");
  return { targetId: command.targetId.trim(), reason: command.reason.trim(), idempotencyKey: command.idempotencyKey.trim(), confirmation: typeof command.confirmation === "string" ? command.confirmation : undefined, payload: (command.payload ?? {}) as T };
}

export async function executeAdminCommand<TPayload, TResult>(input: {
  action: string;
  rawCommand: unknown;
  principal: AdminPrincipal;
  requestId: string | null;
  repository: CommandRepository;
  audit: CommandAudit;
  execute: (command: AdminCommand<TPayload>) => Promise<TResult>;
}): Promise<{ replayed: boolean; result: TResult; commandStatus: CommandStatus | "receipt_persistence_uncertain" }> {
  let command: AdminCommand<TPayload>;
  try {
    command = validateAdminCommand<TPayload>(input.rawCommand);
  } catch (error) {
    await auditRejected(input, null, error);
    throw error;
  }
  const descriptor = findManagementDescriptor(command.targetId);
  try {
    if (!descriptor || !descriptor.writeCapability) throw new Error("未知或只读管理对象");
    if (!hasAdminCapability(input.principal, descriptor.writeCapability)) throw new Error("权限不足");
    if (descriptor.confirmation?.required) {
      const expected = descriptor.confirmation.phrase === "target-id" ? command.targetId : descriptor.confirmation.fixedValue;
      if (!expected || command.confirmation !== expected) throw new Error("确认短语不匹配");
    }
  } catch (error) {
    await auditRejected(input, command, error);
    throw error;
  }
  const hash = canonicalCommandHash({ targetId: command.targetId, reason: command.reason, confirmation: command.confirmation, payload: command.payload });
  const begun = await input.repository.begin(input.action, command as AdminCommand<unknown>, hash, input.principal.actorId, input.requestId);
  if (!begun.created) {
    if (begun.receipt.request_hash !== hash) throw new CommandConflictError("幂等键已用于不同请求");
    if (["completed", "succeeded"].includes(begun.receipt.status)) return { replayed: true, result: begun.receipt.result_reference as TResult, commandStatus: "completed" };
    if (["effect_succeeded", "audit_pending"].includes(begun.receipt.status) || recoverableEffectStarted(begun.receipt)) {
      const sanitized = begun.receipt.result_reference;
      try {
        if (begun.receipt.status === "effect_started") await input.repository.transition(input.action, command.idempotencyKey, ["effect_started"], "effect_succeeded", sanitized);
        if (begun.receipt.status !== "audit_pending") await input.repository.transition(input.action, command.idempotencyKey, ["effect_succeeded"], "audit_pending", sanitized);
        await requireAuditPersistence(input.audit, commandSucceededAudit(input, command, descriptor.category, sanitized));
        await input.repository.succeed(input.action, command.idempotencyKey, sanitized);
        return { replayed: true, result: sanitized as TResult, commandStatus: "completed" };
      } catch {
        return { replayed: true, result: sanitized as TResult, commandStatus: "audit_pending" };
      }
    }
    if (["accepted", "executing", "effect_started", "effect_succeeded", "audit_pending"].includes(begun.receipt.status)) {
      return { replayed: true, result: begun.receipt.result_reference as TResult, commandStatus: begun.receipt.status === "executing" ? "accepted" : begun.receipt.status };
    }
    throw new CommandConflictError(begun.receipt.safe_error || "相同命令此前执行失败，请使用新的幂等键重试");
  }
  const auditBase = { actorId: input.principal.actorId, actorType: "admin" as const, objectType: descriptor.category, objectId: command.targetId, requestId: input.requestId, idempotencyKey: command.idempotencyKey };
  try {
    await requireAuditPersistence(input.audit, { ...auditBase, action: `${input.action}.requested`, newValue: sanitizeAuditValue(command.payload), metadata: { reason: command.reason, status: "pending" } });
    await input.repository.transition(input.action, command.idempotencyKey, ["accepted", "executing"], "effect_started");
  } catch (error) {
    await input.repository.fail(input.action, command.idempotencyKey, "审计服务暂时不可用");
    throw error;
  }
  let effectOccurred = false;
  let effectResult: TResult | undefined;
  try {
    const result = await input.execute(command);
    effectOccurred = true;
    effectResult = result;
    const sanitized = sanitizeAuditValue(result);
    try {
      await input.repository.transition(input.action, command.idempotencyKey, ["effect_started"], "effect_succeeded", sanitized);
    } catch {
      try { await input.repository.recordEffectResult(input.action, command.idempotencyKey, sanitized); } catch { /* durable state is unknown to this process */ }
      return { replayed: false, result, commandStatus: "receipt_persistence_uncertain" };
    }
    try {
      await input.repository.transition(input.action, command.idempotencyKey, ["effect_succeeded"], "audit_pending", sanitized);
      await requireAuditPersistence(input.audit, commandSucceededAudit(input, command, descriptor.category, sanitized));
      await input.repository.succeed(input.action, command.idempotencyKey, sanitized);
      return { replayed: false, result, commandStatus: "completed" };
    } catch {
      return { replayed: false, result, commandStatus: "audit_pending" };
    }
  } catch (error) {
    if (effectOccurred) {
      try { await input.repository.recordEffectResult(input.action, command.idempotencyKey, sanitizeAuditValue(effectResult)); } catch { /* reconciler may observe the successful CAS */ }
      return { replayed: false, result: effectResult as TResult, commandStatus: "receipt_persistence_uncertain" };
    }
    const safeError = error instanceof CommandConflictError ? error.message.slice(0, 500) : "管理命令执行失败";
    await input.repository.fail(input.action, command.idempotencyKey, safeError);
    if (!(error instanceof AuditPersistenceError)) {
      await requireAuditPersistence(input.audit, { ...auditBase, action: `${input.action}.failed`, metadata: { reason: command.reason, status: "failed", errorCode: error instanceof CommandConflictError ? "COMMAND_CONFLICT" : "COMMAND_EXECUTION_FAILED" } });
    }
    throw error;
  }
}

function recoverableEffectStarted(receipt: CommandReceipt): boolean {
  return receipt.status === "effect_started" && receipt.result_reference !== null && receipt.result_reference !== undefined && receipt.audit_context?.effectSucceeded === true;
}

function commandSucceededAudit<TPayload, TResult>(input: Parameters<typeof executeAdminCommand<TPayload, TResult>>[0], command: AdminCommand<TPayload>, objectType: string, result: unknown): Parameters<CommandAudit>[0] {
  return { actorId: input.principal.actorId, actorType: "admin", action: `${input.action}.succeeded`, objectType, objectId: command.targetId, requestId: input.requestId, idempotencyKey: command.idempotencyKey, newValue: result, metadata: { reason: command.reason, status: "succeeded" } };
}

async function auditRejected<TPayload, TResult>(
  input: Parameters<typeof executeAdminCommand<TPayload, TResult>>[0],
  command: AdminCommand<TPayload> | null,
  error: unknown,
): Promise<void> {
  const raw = input.rawCommand && typeof input.rawCommand === "object" && !Array.isArray(input.rawCommand)
    ? input.rawCommand as Record<string, unknown>
    : {};
  const targetId = command?.targetId || (typeof raw.targetId === "string" ? raw.targetId.slice(0, 200) : "invalid-command");
  const descriptor = findManagementDescriptor(targetId);
  const reason = command?.reason || (typeof raw.reason === "string" ? raw.reason.slice(0, 500) : "invalid-command");
  const idempotencyKey = command?.idempotencyKey || (typeof raw.idempotencyKey === "string" ? raw.idempotencyKey.slice(0, 200) : "not-provided");
  const safeError = error instanceof CommandInputError || error instanceof CommandConflictError ? error.message.slice(0, 500) : "命令被拒绝";
  await requireAuditPersistence(input.audit, {
    actorId: input.principal.actorId,
    actorType: "admin",
    action: `${input.action}.rejected`,
    objectType: descriptor?.category || "management",
    objectId: targetId,
    requestId: input.requestId,
    idempotencyKey,
    metadata: { reason, error: safeError },
  });
}
