import { describe, expect, it } from "vitest";
import { ADMIN_PAGE_CAPABILITIES, type AdminPagePath } from "@/app/admin/_components/admin-page-access";
import OverviewPage from "@/app/admin/page";
import SettingsPage from "@/app/admin/settings/page";
import SourcesPage from "@/app/admin/sources/page";
import AutomationPage from "@/app/admin/automation/page";
import StrategiesPage from "@/app/admin/strategies/page";
import BacktestsPage from "@/app/admin/backtests/page";
import AuditPage from "@/app/admin/audit/page";
import DeploymentsPage from "@/app/admin/deployments/page";
import AdminsPage from "@/app/admin/admins/page";
import RolesPage from "@/app/admin/roles/page";
import StrategyLabPage from "@/app/admin/strategies/lab/page";

const pages: Record<AdminPagePath, () => React.ReactElement> = {
  "/admin": OverviewPage,
  "/admin/settings": SettingsPage,
  "/admin/sources": SourcesPage,
  "/admin/automation": AutomationPage,
  "/admin/strategies": StrategiesPage,
  "/admin/backtests": BacktestsPage,
  "/admin/audit": AuditPage,
  "/admin/deployments": DeploymentsPage,
  "/admin/admins": AdminsPage,
  "/admin/roles": RolesPage,
  "/admin/strategies/lab": StrategyLabPage,
};

describe("administrator App Router gates", () => {
  it.each(Object.entries(pages) as Array<[AdminPagePath, () => React.ReactElement]>)
  ("wires $0 to its required server capability", (path, page) => {
    expect((page().props as { required: string }).required).toBe(ADMIN_PAGE_CAPABILITIES[path]);
  });
});
