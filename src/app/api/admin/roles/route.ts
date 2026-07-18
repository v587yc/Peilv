import { NextRequest, NextResponse } from "next/server";
import { listAdminUsers } from "@/lib/auth/admin-accounts";
import { ROLE_CAPABILITIES, requireAdminCapability } from "@/lib/auth/admin-capabilities";
const headers = { "Cache-Control": "private, no-store" };
const definitions = [
  { id: "super_admin", name: "超级管理员", description: "全部管理、配置、执行和高危发布权限" },
  { id: "operator", name: "运营管理员", description: "日常查看、配置和任务执行权限" },
  { id: "auditor", name: "只读审计员", description: "只读查看后台与审计记录" },
] as const;
export async function GET(request: NextRequest) {
  const auth = await requireAdminCapability(request, "admin:manage");
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status, headers });
  const users = await listAdminUsers();
  return NextResponse.json({ success: true, roles: definitions.map(role => ({ ...role, capabilities: ROLE_CAPABILITIES[role.id], memberCount: users.filter(user => user.role === role.id).length, system: true })) }, { headers });
}
