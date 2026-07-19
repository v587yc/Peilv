import type { AdminRole } from "@/lib/auth/admin-accounts";
import { ROLE_CAPABILITIES, type AdminCapability } from "@/lib/auth/admin-capabilities";

export const ADMIN_PAGE_CAPABILITIES = {
  "/admin": "admin:view",
  "/admin/settings": "admin:configure",
  "/admin/sources": "admin:view",
  "/admin/automation": "admin:execute",
  "/admin/strategies": "admin:configure",
  "/admin/strategies/lab": "admin:view",
  "/admin/backtests": "admin:execute",
  "/admin/audit": "admin:view",
  "/admin/deployments": "admin:dangerous",
  "/admin/admins": "admin:manage",
  "/admin/roles": "admin:manage",
} as const satisfies Record<string, AdminCapability>;

export type AdminPagePath = keyof typeof ADMIN_PAGE_CAPABILITIES;

export function canRoleAccessAdminPage(role: AdminRole, path: AdminPagePath): boolean {
  return ROLE_CAPABILITIES[role].includes(ADMIN_PAGE_CAPABILITIES[path]);
}
