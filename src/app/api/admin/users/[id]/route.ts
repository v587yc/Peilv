import { NextRequest, NextResponse } from "next/server";
import { AdminUserUpdateConflictError, getAdminUser, isAdminRole, updateAdminUser } from "@/lib/auth/admin-accounts";
import { requireAdminCapability } from "@/lib/auth/admin-capabilities";
import { validateAdminPassword } from "@/lib/auth/password";
import { logServerError, requestIdFor, safeErrorResponse } from "@/lib/api/safe-error-response";
const headers = { "Cache-Control": "private, no-store" };
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(request);
  const auth = await requireAdminCapability(request, "admin:manage");
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status, headers });
  const { id } = await context.params; const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  let current;
  try { current = await getAdminUser(id); }
  catch (error) { logServerError("admin.user.read-before-update", error, { requestId, actorId: auth.principal.actorId }); return safeErrorResponse({ requestId, errorCode: "ADMIN_UPDATE_FAILED", message: "管理员更新失败", status: 500 }); }
  if (!current) return safeErrorResponse({ requestId, errorCode: "ADMIN_NOT_FOUND", message: "管理员状态已变化，请刷新后重试", status: 409 });
  const role = body.role === undefined ? undefined : isAdminRole(body.role) ? body.role : null;
  if (role === null) return safeErrorResponse({ requestId, errorCode: "INVALID_ROLE", message: "角色无效", status: 400 });
  const password = typeof body.password === "string" && body.password ? body.password : undefined;
  const passwordError = password === undefined ? null : validateAdminPassword(password);
  if (passwordError) return safeErrorResponse({ requestId, errorCode: "INVALID_PASSWORD", message: passwordError, status: 400 });
  const expectedUpdatedAt = typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : "";
  if (!expectedUpdatedAt || Number.isNaN(Date.parse(expectedUpdatedAt))) return safeErrorResponse({ requestId, errorCode: "INVALID_ADMIN_VERSION", message: "缺少有效的管理员数据版本", status: 400 });
  if (id === auth.principal.actorId && body.isActive === false) return safeErrorResponse({ requestId, errorCode: "SELF_DISABLE_CONFLICT", message: "不能停用当前登录账号", status: 409 });
  try {
    const user = await updateAdminUser(
      id,
      expectedUpdatedAt,
      {
        displayName: typeof body.displayName === "string" ? body.displayName : undefined,
        role: role || undefined,
        isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
        password,
      },
      { actorId: auth.principal.actorId, requestId },
    );
    return NextResponse.json({ success: true, user }, { headers: { ...headers, "x-request-id": requestId } });
  } catch (error) {
    logServerError("admin.user.update", error, { requestId, actorId: auth.principal.actorId, objectId: id });
    if (error instanceof AdminUserUpdateConflictError) {
      return safeErrorResponse({ requestId, errorCode: "ADMIN_UPDATE_CONFLICT", message: "管理员数据已被其他操作更新，请刷新后重试", status: 409 });
    }
    if (error instanceof Error && error.message === "不能停用或降级最后一个超级管理员") return safeErrorResponse({ requestId, errorCode: "LAST_ACTIVE_SUPER_ADMIN", message: error.message, status: 409 });
    return safeErrorResponse({ requestId, errorCode: "ADMIN_UPDATE_FAILED", message: "管理员更新失败", status: 500 });
  }
}
