import { writeAuditLog } from "@/lib/audit-log";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { createSupabaseCommandRepository } from "./command-repository";
import { findManagementDescriptor } from "./registry";

export async function reconcilePendingCommandAudits(limit = 25): Promise<{ scanned: number; completed: number }> {
  const bounded = Math.max(1, Math.min(limit, 100));
  const client = getSupabaseClient();
  const { data, error } = await client.from("management_command_receipts")
    .select("action,idempotency_key,status,result_reference,actor_id,request_id,audit_context")
    .in("status", ["effect_started", "effect_succeeded", "audit_pending"]).order("updated_at", { ascending: true }).limit(bounded);
  if (error) throw new Error("无法读取待恢复管理命令");
  const repository = createSupabaseCommandRepository(client);
  let completed = 0;
  for (const row of data || []) {
    const context = row.audit_context && typeof row.audit_context === "object" ? row.audit_context as Record<string, unknown> : {};
    const targetId = typeof context.targetId === "string" ? context.targetId : row.action;
    const descriptor = findManagementDescriptor(targetId);
    if (!descriptor) continue;
    const effectRecorded = row.status !== "effect_started" || (context.effectSucceeded === true && row.result_reference !== null && row.result_reference !== undefined);
    if (!effectRecorded) continue;
    try {
      if (row.status === "effect_started") await repository.transition(row.action, row.idempotency_key, ["effect_started"], "effect_succeeded", row.result_reference);
      if (row.status === "effect_succeeded") await repository.transition(row.action, row.idempotency_key, ["effect_succeeded"], "audit_pending", row.result_reference);
      if (row.status === "effect_started") await repository.transition(row.action, row.idempotency_key, ["effect_succeeded"], "audit_pending", row.result_reference);
      const ok = await writeAuditLog({ actorId: row.actor_id, actorType: "admin", action: `${row.action}.succeeded`, objectType: descriptor.category, objectId: targetId, requestId: row.request_id, idempotencyKey: row.idempotency_key, newValue: row.result_reference, metadata: { reason: typeof context.reason === "string" ? context.reason : "reconciled", status: "succeeded", reconciled: true } });
      if (!ok) continue;
      await repository.succeed(row.action, row.idempotency_key, row.result_reference);
      completed++;
    } catch { /* bounded reconciler retries on the next run */ }
  }
  return { scanned: data?.length || 0, completed };
}
