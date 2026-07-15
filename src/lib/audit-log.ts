import { getSupabaseClient } from "@/storage/database/supabase-client";

export interface AuditLogEntry {
  actorId?: string | null;
  actorType: "admin" | "internal" | "system" | "deployment-admin";
  action: string;
  objectType: string;
  objectId?: string | null;
  requestId?: string | null;
  idempotencyKey?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEY = /(?:token|secret|password|authorization|cookie|api[_-]?key|webhook)/i;

export function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeAuditValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeAuditValue(child, depth + 1);
  }
  return output;
}

export async function writeAuditLog(entry: AuditLogEntry): Promise<boolean> {
  try {
    const { error } = await getSupabaseClient().from("audit_logs").insert({
      actor_id: entry.actorId || null,
      actor_type: entry.actorType,
      action: entry.action,
      object_type: entry.objectType,
      object_id: entry.objectId || null,
      request_id: entry.requestId || null,
      idempotency_key: entry.idempotencyKey || null,
      old_value: entry.oldValue === undefined ? null : sanitizeAuditValue(entry.oldValue),
      new_value: entry.newValue === undefined ? null : sanitizeAuditValue(entry.newValue),
      metadata: sanitizeAuditValue(entry.metadata || {}),
    });
    if (error) {
      console.error("[Audit] Failed to write audit log:", error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[Audit] Failed to write audit log:", error instanceof Error ? error.message : error);
    return false;
  }
}
