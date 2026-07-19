import { NextRequest, NextResponse } from "next/server";
import { bootstrapFirstAdmin } from "@/lib/auth/admin-accounts";
import { isSameOriginMutation, timingSafeSecretEqual, verifyAdminToken } from "@/lib/admin-auth";
import { validateAdminPassword } from "@/lib/auth/password";
import { writeAuditLog } from "@/lib/audit-log";

const headers = { "Cache-Control": "no-store" };
function validBootstrapSecret(candidate: unknown): boolean {
  const configured = process.env.ADMIN_BOOTSTRAP_TOKEN;
  const legacyRecoveryEnabled = process.env.ADMIN_LEGACY_BOOTSTRAP_ENABLED === "true";
  return typeof candidate === "string" && Boolean(
    (configured && timingSafeSecretEqual(candidate, configured)) ||
    (legacyRecoveryEnabled && verifyAdminToken(candidate)),
  );
}

export async function POST(request: NextRequest) {
  if (!isSameOriginMutation(request)) return NextResponse.json({ success: false, error: "跨站请求校验失败" }, { status: 403, headers });
  const body = await request.json().catch(() => ({})) as { bootstrapToken?: unknown; username?: unknown; displayName?: unknown; password?: unknown };
  if (!validBootstrapSecret(body.bootstrapToken)) return NextResponse.json({ success: false, error: "初始化凭据无效" }, { status: 401, headers });
  const passwordError = validateAdminPassword(body.password);
  if (passwordError) return NextResponse.json({ success: false, error: passwordError }, { status: 400, headers });
  try {
    const user = await bootstrapFirstAdmin({ username: body.username, displayName: body.displayName, password: body.password as string });
    await writeAuditLog({ actorId: user.id, actorType: "admin", action: "admin.bootstrap", objectType: "admin_user", objectId: user.id, newValue: { username: user.username, role: user.role } });
    return NextResponse.json({ success: true }, { status: 201, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "初始化失败";
    return NextResponse.json({ success: false, error: message }, { status: message === "管理员已初始化" ? 409 : 400, headers });
  }
}
