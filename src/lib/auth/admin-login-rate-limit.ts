import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export type LoginReservation = { reservationKey: string; allowed: boolean; retryAfterSeconds: number };
type MetricName = "reserved" | "rejected" | "failed" | "succeeded" | "service_error";
const metrics: Record<MetricName, number> = { reserved: 0, rejected: 0, failed: 0, succeeded: 0, service_error: 0 };

function secret(): string {
  const value = process.env.ADMIN_LOGIN_RATE_LIMIT_SECRET;
  if (!value || value.length < 32) throw new Error("管理员登录限流未配置");
  return value;
}
function digest(key: string, kind: string, value: string): string {
  return createHmac("sha256", key).update(`${kind}:v3:${value}`).digest("hex");
}
function shouldEmit(count: number): boolean {
  return count === 1 || (count & (count - 1)) === 0 || count % 100 === 0;
}
export function recordAdminLoginMetric(name: MetricName): void {
  const count = ++metrics[name];
  if (shouldEmit(count)) console.info(JSON.stringify({ event: "admin_login_admission", metric: name, count }));
}
export function trustedLoginSourceIp(request: Request): string | null {
  if (process.env.ADMIN_TRUST_PROXY !== "true") return null;
  const candidate = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("forwarded")?.match(/(?:^|;)\s*for="?([^;,\"]+)/i)?.[1]?.replace(/^\[|\]$/g, "")
    || "";
  return isIP(candidate) ? candidate : null;
}
export function loginAdmissionKeys(request: Request): { globalKey: string; sourceKey: string | null } {
  const key = secret();
  const source = trustedLoginSourceIp(request);
  return { globalKey: digest(key, "global", "all"), sourceKey: source ? digest(key, "source", source) : null };
}
export async function reserveAdminLoginAttempt(keys: ReturnType<typeof loginAdmissionKeys>): Promise<LoginReservation> {
  const reservationKey = randomBytes(32).toString("hex");
  const { data, error } = await getSupabaseClient().rpc("reserve_admin_login_attempt_v2", {
    p_reservation_key: reservationKey, p_global_key: keys.globalKey, p_source_key: keys.sourceKey,
  });
  if (error) { recordAdminLoginMetric("service_error"); throw new Error("管理员登录限流服务不可用"); }
  const row = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean; retry_after_seconds?: number } | null;
  if (!row || typeof row.allowed !== "boolean") { recordAdminLoginMetric("service_error"); throw new Error("管理员登录限流服务异常"); }
  recordAdminLoginMetric(row.allowed ? "reserved" : "rejected");
  return { reservationKey, allowed: row.allowed, retryAfterSeconds: Math.max(0, Number(row.retry_after_seconds || 0)) };
}
export async function settleAdminLoginAttempt(reservationKey: string, succeeded: boolean | null): Promise<{ settled: boolean; auditFailure: boolean }> {
  const { data, error } = await getSupabaseClient().rpc("settle_admin_login_attempt_v2", { p_reservation_key: reservationKey, p_succeeded: succeeded });
  if (error) { recordAdminLoginMetric("service_error"); throw new Error("管理员登录限流服务不可用"); }
  const row = (Array.isArray(data) ? data[0] : data) as { settled?: boolean; audit_failure?: boolean } | null;
  if (!row?.settled) { recordAdminLoginMetric("service_error"); throw new Error("管理员登录限流结算失败"); }
  if (succeeded === true) recordAdminLoginMetric("succeeded");
  else if (succeeded === false) recordAdminLoginMetric("failed");
  return { settled: true, auditFailure: row.audit_failure === true };
}
