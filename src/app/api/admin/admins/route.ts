import { NextRequest, NextResponse } from "next/server";
import { listAdminUsers } from "@/lib/auth/admin-accounts";
import { requireAdminCapability } from "@/lib/auth/admin-capabilities";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: NextRequest) {
  const auth = await requireAdminCapability(request, "admin:manage");
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status, headers });
  const users = await listAdminUsers();
  return NextResponse.json({ success: true, admins: users.map(user => ({ id: user.id, name: user.displayName, username: user.username, roleIds: [user.role], roleNames: [{ super_admin: "超级管理员", operator: "运营管理员", auditor: "只读审计员" }[user.role]], status: user.isActive ? "active" : "disabled", lastActiveAt: user.lastLoginAt })) }, { headers });
}
