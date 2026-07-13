import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/lib/audit-log";
import {
  authorizeDeploymentRequest,
  clearDeploymentLoginFailures,
  createDeploymentCsrfToken,
  createDeploymentSession,
  DEPLOYMENT_SESSION_MAX_AGE_SECONDS,
  deploymentSessionCookieName,
  getTrustedDeploymentClientIp,
  isDeploymentCredentialConfigured,
  isDeploymentLoginBlocked,
  isSameOriginDeploymentMutation,
  isSecureDeploymentRequest,
  normalizeDeploymentUsername,
  recordDeploymentLoginFailure,
  verifyDeploymentCredentials,
  verifyDeploymentCsrfToken,
} from "@/lib/deployment-auth";

const noStore = { "Cache-Control": "no-store" };
const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
}).strict();

function auditLogin(requestId: string, success: boolean, clientIp: string, reason: string, username?: string): void {
  void writeAuditLog({
    actorId: success && username ? `local:${username}` : "deployment-login",
    actorType: "deployment-admin",
    action: success ? "deployment_login_succeeded" : "deployment_login_failed",
    objectType: "deployment_session",
    requestId,
    metadata: { clientIp, reason },
  });
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  if (!isSameOriginDeploymentMutation(request)) {
    return NextResponse.json({ success: false, error: "跨站请求校验失败" }, { status: 403, headers: noStore });
  }
  if (!isDeploymentCredentialConfigured()) {
    auditLogin(requestId, false, getTrustedDeploymentClientIp(request), "configuration_error");
    return NextResponse.json({ success: false, error: "部署控制台登录尚未配置" }, { status: 503, headers: noStore });
  }

  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  const username = parsed.success ? parsed.data.username : "";
  const password = parsed.success ? parsed.data.password : "";
  const normalizedUsername = normalizeDeploymentUsername(username);
  const clientIp = getTrustedDeploymentClientIp(request);
  const blocked = isDeploymentLoginBlocked(username, clientIp);
  const result = blocked ? "invalid" : await verifyDeploymentCredentials(username, password);

  if (!parsed.success || result !== "valid") {
    if (!blocked) recordDeploymentLoginFailure(username, clientIp);
    auditLogin(requestId, false, clientIp, blocked ? "throttled" : "invalid_credentials");
    return NextResponse.json({ success: false, error: "用户名或密码错误" }, { status: 401, headers: noStore });
  }

  clearDeploymentLoginFailures(username, clientIp);
  const secure = isSecureDeploymentRequest(request);
  const response = NextResponse.json({ success: true }, { headers: noStore });
  response.cookies.set({
    name: deploymentSessionCookieName(secure),
    value: createDeploymentSession(normalizedUsername),
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: DEPLOYMENT_SESSION_MAX_AGE_SECONDS,
  });
  auditLogin(requestId, true, clientIp, "authenticated", normalizedUsername);
  return response;
}

export async function GET(request: NextRequest) {
  const actor = authorizeDeploymentRequest(request);
  if (!actor) {
    return NextResponse.json({ authenticated: false }, { status: 401, headers: noStore });
  }
  return NextResponse.json({
    authenticated: true,
    actor: { username: actor.username },
    csrf: {
      preflight: createDeploymentCsrfToken(actor, "preflight"),
      deploy: createDeploymentCsrfToken(actor, "deploy"),
      rollback: createDeploymentCsrfToken(actor, "rollback"),
      logout: createDeploymentCsrfToken(actor, "logout"),
    },
  }, { headers: noStore });
}

export async function DELETE(request: NextRequest) {
  const actor = authorizeDeploymentRequest(request);
  if (!actor) return NextResponse.json({ success: false, error: "需要部署控制台登录" }, { status: 401, headers: noStore });
  if (!isSameOriginDeploymentMutation(request)) return NextResponse.json({ success: false, error: "跨站请求校验失败" }, { status: 403, headers: noStore });
  if (!verifyDeploymentCsrfToken(actor, "logout", request.headers.get("x-csrf-token"))) {
    return NextResponse.json({ success: false, error: "CSRF 校验失败" }, { status: 403, headers: noStore });
  }

  const secure = isSecureDeploymentRequest(request);
  const response = NextResponse.json({ success: true }, { headers: noStore });
  response.cookies.set({
    name: deploymentSessionCookieName(secure),
    value: "",
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
