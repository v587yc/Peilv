import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminCommand, CommandReceipt, CommandRepository } from "./commands";

export function createSupabaseCommandRepository(client: SupabaseClient): CommandRepository {
  return {
    async begin(action, command: AdminCommand<unknown>, hash, actorId, requestId) {
      const payload = command.payload && typeof command.payload === "object" ? command.payload as Record<string, unknown> : {};
      const inferredTarget = command.targetId || [payload.releaseId, payload.targetReleaseId, payload.strategyId, payload.jobId].find(value => typeof value === "string");
      const auditContext = { targetId: inferredTarget || action, reason: command.reason };
      const { data, error } = await client.from("management_command_receipts").insert({ action, idempotency_key: command.idempotencyKey, request_hash: hash, status: "accepted", actor_id: actorId, request_id: requestId, audit_context: auditContext }).select("status,request_hash,result_reference,safe_error,audit_context").maybeSingle();
      if (!error && data) return { created: true, receipt: data as CommandReceipt };
      const existing = await client.from("management_command_receipts").select("status,request_hash,result_reference,safe_error,audit_context").eq("action", action).eq("idempotency_key", command.idempotencyKey).maybeSingle();
      if (existing.error || !existing.data) throw new Error("无法持久化管理命令收据");
      return { created: false, receipt: existing.data as CommandReceipt };
    },
    async transition(action, key, from, to, result) {
      const changes: Record<string, unknown> = { status: to, updated_at: new Date().toISOString() };
      if (result !== undefined) changes.result_reference = result;
      const { data, error } = await client.from("management_command_receipts").update(changes).eq("action", action).eq("idempotency_key", key).in("status", [...from]).select("status").maybeSingle();
      if (error || !data) throw new Error("无法推进管理命令状态");
    },
    async succeed(action, key, result) {
      const { data, error } = await client.from("management_command_receipts").update({ status: "completed", result_reference: result, safe_error: null, updated_at: new Date().toISOString() }).eq("action", action).eq("idempotency_key", key).eq("status", "audit_pending").select("status").maybeSingle();
      if (error || !data) throw new Error("无法完成管理命令收据");
    },
    async fail(action, key, safeError) {
      const { error } = await client.from("management_command_receipts").update({ status: "failed", safe_error: safeError, updated_at: new Date().toISOString() }).eq("action", action).eq("idempotency_key", key).in("status", ["accepted", "executing", "effect_started"]);
      if (error) throw new Error("无法完成管理命令收据");
    },
    async recordEffectResult(action, key, result) {
      const { data, error } = await client.rpc("record_management_command_effect_result", { p_action: action, p_idempotency_key: key, p_result: result });
      if (error || data !== true) throw new Error("无法持久化命令效果结果");
    },
  };
}
