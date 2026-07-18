import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AdminRole } from "@/lib/auth/admin-accounts";
import { getInternalApiSecret } from "@/lib/internal-secret";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { getInternalRoutePurpose } from "@/lib/api-protection";

export const ADMIN_SESSION_COOKIE = "admin_session";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const LEGACY_SESSION_VERSION = "v1";
const LEGACY_SESSION_CONTEXT = "single-team-admin";

export type AdminActor = { actorId: string; actorType: "admin" | "internal"; role?: AdminRole; username?: string };
export type AdminAuthorization = { ok: true; actor: AdminActor } | { ok: false; status: 401 | 403 | 503; error: string };

export function timingSafeSecretEqual(actual: string, expected: string): boolean {
  const a = createHash("sha256").update(actual, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function legacySignature(payload: string, token: string): string {
  return createHmac("sha256", token).update(`${LEGACY_SESSION_CONTEXT}:${payload}`).digest("base64url");
}

function readCookie(header: string | null, name: string): string | null {
  for (const part of header?.split(";") || []) {
    const index = part.indexOf("=");
    if (index >= 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function isAdminTokenConfigured(): boolean { return Boolean(process.env.ADMIN_API_TOKEN); }
export function verifyAdminToken(candidate: unknown): boolean {
  const expected = process.env.ADMIN_API_TOKEN;
  return typeof candidate === "string" && Boolean(expected) && timingSafeSecretEqual(candidate, expected!);
}

/** Legacy helper retained for migration tests only; legacy cookies are no longer authorized. */
export function createAdminSession(now = Date.now()): string {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) throw new Error("ADMIN_API_TOKEN 未配置");
  const payload = `${LEGACY_SESSION_VERSION}.${Math.floor(now / 1000)}.${randomBytes(18).toString("base64url")}`;
  return `${payload}.${legacySignature(payload, token)}`;
}

export function verifyAdminSession(session: string | null | undefined, now = Date.now()): boolean {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token || !session) return false;
  const parts = session.split(".");
  if (parts.length !== 4 || parts[0] !== LEGACY_SESSION_VERSION) return false;
  const issuedAt = Number(parts[1]); const nowSeconds = Math.floor(now / 1000);
  if (!Number.isInteger(issuedAt) || issuedAt > nowSeconds + 60 || nowSeconds - issuedAt > ADMIN_SESSION_MAX_AGE_SECONDS) return false;
  const payload = parts.slice(0, 3).join(".");
  return timingSafeSecretEqual(parts[3], legacySignature(payload, token));
}

export function sessionTokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }

export async function createPersistentAdminSession(input: { userId?: string; role: AdminRole; username: string }): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const { error } = await getSupabaseClient().from("admin_sessions").insert({
    token_hash: sessionTokenHash(token), admin_user_id: input.userId || null, role: input.role, username: input.username,
    expires_at: new Date(now.getTime() + ADMIN_SESSION_MAX_AGE_SECONDS * 1000).toISOString(), created_at: now.toISOString(), last_seen_at: now.toISOString(),
  });
  if (error) throw new Error("无法创建管理员会话");
  return token;
}

export async function revokeAdminSession(token: string | null | undefined): Promise<void> {
  if (!token) return;
  const { error } = await getSupabaseClient().from("admin_sessions").update({ revoked_at: new Date().toISOString() }).eq("token_hash", sessionTokenHash(token)).is("revoked_at", null);
  if (error) throw new Error("无法撤销管理员会话");
}

function verifyInternalSecret(request: Request): boolean {
  const candidate = request.headers.get("x-internal-api-secret");
  if (!candidate) return false;
  try { return timingSafeSecretEqual(candidate, getInternalApiSecret()); } catch { return false; }
}

export async function authorizeAdminRequest(request: Request): Promise<AdminAuthorization> {
  if (verifyInternalSecret(request)) {
    const pathname = new URL(request.url).pathname;
    if (!getInternalRoutePurpose(pathname, request.method)) {
      return { ok: false, status: 403, error: "内部任务无权访问此接口" };
    }
    return { ok: true, actor: { actorId: "internal-task", actorType: "internal" } };
  }
  const session = readCookie(request.headers.get("cookie"), ADMIN_SESSION_COOKIE);
  if (!session) return { ok: false, status: 401, error: "需要管理员登录" };
  try {
    const { data, error } = await getSupabaseClient().from("admin_sessions")
      .select("admin_user_id,role,username,expires_at,revoked_at,admin_users(is_active,role,username)")
      .eq("token_hash", sessionTokenHash(session)).maybeSingle();
    if (error) return { ok: false, status: 503, error: "管理员认证暂时不可用" };
    const user = Array.isArray(data?.admin_users) ? data?.admin_users[0] : data?.admin_users;
    const active = data && data.admin_user_id && !data.revoked_at && Date.parse(data.expires_at) > Date.now() && user?.is_active;
    if (!active) return { ok: false, status: 401, error: "管理员会话已失效" };
    return { ok: true, actor: { actorId: data.admin_user_id, actorType: "admin", role: user.role as AdminRole, username: user.username } };
  } catch {
    return { ok: false, status: 503, error: "管理员认证暂时不可用" };
  }
}

export function adminSessionFromRequest(request: Request): string | null { return readCookie(request.headers.get("cookie"), ADMIN_SESSION_COOKIE); }

function loopback(host: string): boolean { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host); }
export function isSameOriginMutation(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;
  const source = request.headers.get("origin") || request.headers.get("referer"); if (!source) return false;
  try {
    const actual = new URL(source); const expected = new URL(request.url);
    if (actual.origin === expected.origin) return true;
    const host = request.headers.get("host"); const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || expected.protocol.replace(":", "");
    const forwarded = host ? new URL(`${protocol}://${host}`) : expected;
    return actual.origin === forwarded.origin || (actual.protocol === forwarded.protocol && actual.port === forwarded.port && loopback(actual.hostname) && loopback(forwarded.hostname));
  } catch { return false; }
}
