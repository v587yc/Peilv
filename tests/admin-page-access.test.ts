import { describe, expect, it } from "vitest";
import { ADMIN_PAGE_CAPABILITIES, canRoleAccessAdminPage, type AdminPagePath } from "@/app/admin/_components/admin-page-access";
import { adminNavigation, visibleAdminNavigation } from "@/app/admin/_components/admin-nav";
import { ROLE_CAPABILITIES } from "@/lib/auth/admin-capabilities";
import type { AdminRole } from "@/lib/auth/admin-accounts";

const roles: AdminRole[] = ["super_admin", "operator", "auditor"];
const expected: Record<AdminRole, Record<AdminPagePath, boolean>> = {
  super_admin: Object.fromEntries(Object.keys(ADMIN_PAGE_CAPABILITIES).map(path => [path, true])) as Record<AdminPagePath, boolean>,
  operator: {
    "/admin": true, "/admin/settings": true, "/admin/sources": true, "/admin/automation": true, "/admin/strategies": true,
    "/admin/backtests": true, "/admin/audit": true, "/admin/deployments": false, "/admin/admins": false, "/admin/roles": false, "/admin/strategies/lab": true,
  },
  auditor: {
    "/admin": true, "/admin/settings": false, "/admin/sources": true, "/admin/automation": false, "/admin/strategies": false,
    "/admin/backtests": false, "/admin/audit": true, "/admin/deployments": false, "/admin/admins": false, "/admin/roles": false, "/admin/strategies/lab": true,
  },
};

describe("administrator App Router page access", () => {
  it.each(roles)("enforces direct URL capability matrix for %s", role => {
    for (const path of Object.keys(ADMIN_PAGE_CAPABILITIES) as AdminPagePath[]) {
      expect(canRoleAccessAdminPage(role, path), `${role} ${path}`).toBe(expected[role][path]);
    }
  });

  it("keeps navigation capabilities aligned with direct URL gates", () => {
    const navigation = new Map(adminNavigation.flatMap(group => group.items).filter(item => item.href).map(item => [item.href, item.capability]));
    for (const [path, capability] of Object.entries(ADMIN_PAGE_CAPABILITIES)) if(path!=="/admin/strategies/lab") expect(navigation.get(path)).toBe(capability);
  });

  it.each(roles)("shows only authorized navigation destinations for %s", role => {
    const visible = visibleAdminNavigation(ROLE_CAPABILITIES[role]).flatMap(group => group.items).map(item => item.href);
    for (const path of Object.keys(ADMIN_PAGE_CAPABILITIES) as AdminPagePath[]) {
      if(path!=="/admin/strategies/lab") expect(visible.includes(path), `${role} navigation ${path}`).toBe(expected[role][path]);
    }
  });
});
