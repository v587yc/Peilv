import { NextRequest, NextResponse } from "next/server";
import { createAdminUser, isAdminRole, listAdminUsers } from "@/lib/auth/admin-accounts";
import { requireAdminCapability } from "@/lib/auth/admin-capabilities";
import { validateAdminPassword } from "@/lib/auth/password";
import { logServerError, requestIdFor, safeErrorResponse } from "@/lib/api/safe-error-response";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: NextRequest) {
  const requestId = requestIdFor(request);
  const auth = await requireAdminCapability(request, "admin:manage");
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status, headers });
  try {
    return NextResponse.json(
      { success: true, users: await listAdminUsers() },
      { headers: { ...headers, "x-request-id": requestId } },
    );
  } catch (error) {
    logServerError("admin.user.list", error, { requestId, actorId: auth.principal.actorId });
    return safeErrorResponse({ requestId, errorCode: "ADMIN_LIST_FAILED", message: "管理员列表加载失败", status: 500 });
  }
}
export async function POST(request: NextRequest) {
  const requestId = requestIdFor(request);
  const auth = await requireAdminCapability(request, "admin:manage");
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status, headers });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (!isAdminRole(body.role)) return safeErrorResponse({ requestId, errorCode: "INVALID_ROLE", message: "角色无效", status: 400 });
  const passwordError = validateAdminPassword(body.password);
  if (passwordError) return safeErrorResponse({ requestId, errorCode: "INVALID_PASSWORD", message: passwordError, status: 400 });
  try {
    const user = await createAdminUser({
      username: body.username,
      displayName: body.displayName,
      password: body.password as string,
      role: body.role,
      actorId: auth.principal.actorId,
      requestId,
    });
    return NextResponse.json({ success: true, user }, { status: 201, headers: { ...headers, "x-request-id": requestId } });
  } catch (error) {
    logServerError("admin.user.create", error, { requestId, actorId: auth.principal.actorId });
    if (error instanceof Error && error.message === "账号需为 3-64 位字母、数字、点、下划线或短横线") return safeErrorResponse({ requestId, errorCode: "INVALID_USERNAME", message: error.message, status: 400 });
    if (error instanceof Error && error.message === "管理员账号已存在") return safeErrorResponse({ requestId, errorCode: "ADMIN_ALREADY_EXISTS", message: error.message, status: 409 });
    return safeErrorResponse({ requestId, errorCode: "ADMIN_CREATE_FAILED", message: "管理员创建失败", status: 500 });
  }
}
