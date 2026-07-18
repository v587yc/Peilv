import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin, countAdminUsers } from "@/lib/auth/admin-accounts";
import {
  ADMIN_SESSION_COOKIE, ADMIN_SESSION_MAX_AGE_SECONDS, adminSessionFromRequest, authorizeAdminRequest,
  createPersistentAdminSession, isAdminTokenConfigured, isSameOriginMutation, revokeAdminSession,
} from "@/lib/admin-auth";
import { writeAuditLog } from "@/lib/audit-log";
import { loginAdmissionKeys, reserveAdminLoginAttempt, settleAdminLoginAttempt } from "@/lib/auth/admin-login-rate-limit";

const noStoreHeaders = { "Cache-Control": "no-store" };
function isSecureRequest(request: NextRequest): boolean {
  return (request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || request.nextUrl.protocol.replace(":", "")) === "https";
}
function clientMetadata(request: NextRequest) {
  return { userAgent: request.headers.get("user-agent")?.slice(0, 300) || null };
}
function rateLimited(retryAfterSeconds: number) {
  const retry = Math.max(1, Math.ceil(retryAfterSeconds));
  return NextResponse.json({ success: false, error: "账号或密码无效，请稍后重试" }, { status: 429, headers: { ...noStoreHeaders, "Retry-After": String(retry) } });
}
function setSessionCookie(response: NextResponse, request: NextRequest, value: string, maxAge = ADMIN_SESSION_MAX_AGE_SECONDS) {
  response.cookies.set({ name: ADMIN_SESSION_COOKIE, value, httpOnly: true, sameSite: "strict", secure: isSecureRequest(request), path: "/", maxAge });
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminRequest(request);
  if (!authorization.ok && authorization.status !== 401) {
    return NextResponse.json({ authenticated: false, user: null, error: authorization.error }, { status: authorization.status, headers: noStoreHeaders });
  }
  let initialized: boolean;
  try { initialized = await countAdminUsers() > 0; }
  catch { return NextResponse.json({ authenticated: false, user: null, error: "管理员会话服务暂时不可用" }, { status: 503, headers: noStoreHeaders }); }
  return NextResponse.json({
    configured: initialized || isAdminTokenConfigured(), initialized, authenticated: authorization.ok,
    actorType: authorization.ok ? authorization.actor.actorType : null,
    user: authorization.ok && authorization.actor.actorType === "admin" ? { id: authorization.actor.actorId, username: authorization.actor.username, role: authorization.actor.role } : null,
  }, { status: 200, headers: noStoreHeaders });
}

export async function POST(request: NextRequest) {
  if (!isSameOriginMutation(request)) return NextResponse.json({ success: false, error: "跨站请求校验失败" }, { status: 403, headers: noStoreHeaders });
  const body = await request.json().catch(() => ({})) as { username?: unknown; password?: unknown };
  let reservation;
  try {
    reservation = await reserveAdminLoginAttempt(loginAdmissionKeys(request));
    if (!reservation.allowed) return rateLimited(reservation.retryAfterSeconds);
  } catch {
    return NextResponse.json({ success: false, error: "管理员认证暂时不可用" }, { status: 503, headers: noStoreHeaders });
  }
  let user;
  try { user = await authenticateAdmin(body.username, body.password); }
  catch {
    try { await settleAdminLoginAttempt(reservation.reservationKey, null); } catch { /* fail closed below */ }
    return NextResponse.json({ success: false, error: "管理员认证暂时不可用" }, { status: 503, headers: noStoreHeaders });
  }
  if (!user) {
    let settlement;
    try { settlement = await settleAdminLoginAttempt(reservation.reservationKey, false); }
    catch { return NextResponse.json({ success: false, error: "管理员认证暂时不可用" }, { status: 503, headers: noStoreHeaders }); }
    if (settlement.auditFailure) await writeAuditLog({ actorType: "system", action: "admin.login_failed", objectType: "admin_session", metadata: clientMetadata(request) });
    return NextResponse.json({ success: false, error: "账号或密码无效" }, { status: 401, headers: noStoreHeaders });
  }
  try { await settleAdminLoginAttempt(reservation.reservationKey, true); }
  catch { return NextResponse.json({ success: false, error: "管理员认证暂时不可用" }, { status: 503, headers: noStoreHeaders }); }
  let session: string;
  try {
    session = await createPersistentAdminSession({ userId: user.id, role: user.role, username: user.username });
  } catch {
    return NextResponse.json({ success: false, error: "管理员认证暂时不可用" }, { status: 503, headers: noStoreHeaders });
  }
  await writeAuditLog({ actorId: user.id, actorType: "admin", action: "admin.login", objectType: "admin_session", metadata: { method: "password", ...clientMetadata(request) } });
  const response = NextResponse.json({ success: true, user: { id: user.id, username: user.username, role: user.role } }, { headers: noStoreHeaders });
  setSessionCookie(response, request, session);
  return response;
}

export async function DELETE(request: NextRequest) {
  if (!isSameOriginMutation(request)) return NextResponse.json({ success: false, error: "跨站请求校验失败" }, { status: 403, headers: noStoreHeaders });
  const authorization = await authorizeAdminRequest(request);
  try { await revokeAdminSession(adminSessionFromRequest(request)); }
  catch { return NextResponse.json({ success: false, error: "退出失败，请重试" }, { status: 503, headers: noStoreHeaders }); }
  if (authorization.ok && authorization.actor.actorType === "admin") {
    await writeAuditLog({ actorId: authorization.actor.actorId, actorType: "admin", action: "admin.logout", objectType: "admin_session", metadata: clientMetadata(request) });
  }
  const response = NextResponse.json({ success: true }, { headers: noStoreHeaders });
  setSessionCookie(response, request, "", 0);
  return response;
}
