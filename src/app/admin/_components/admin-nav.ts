import type { LucideIcon } from "lucide-react";
import { Activity, Database, FileClock, Gauge, RefreshCcw, Settings2 } from "lucide-react";
import type { AdminCapability } from "@/lib/auth/admin-capabilities";

export type AdminNavigationItem = {
  label: string;
  href?: string;
  icon: LucideIcon;
  capability: AdminCapability;
  available: boolean;
};

export type AdminNavigationGroup = {
  label: string;
  items: readonly AdminNavigationItem[];
};

export const adminNavigation: readonly AdminNavigationGroup[] = [
  {
    label: "总览",
    items: [{ label: "控制台总览", href: "/admin", icon: Gauge, capability: "admin:view", available: true }],
  },
  {
    label: "业务治理",
    items: [
      { label: "设置与数据源", icon: Settings2, capability: "admin:configure", available: false },
      { label: "自动化与策略", icon: Activity, capability: "admin:execute", available: false },
      { label: "回测管理", icon: Database, capability: "admin:execute", available: false },
    ],
  },
  {
    label: "可观测性",
    items: [{ label: "审计日志", href: "/admin/audit", icon: FileClock, capability: "admin:view", available: true }],
  },
  {
    label: "发布运维",
    items: [{ label: "版本更新", icon: RefreshCcw, capability: "admin:dangerous", available: false }],
  },
];

export function navigationLabel(pathname: string): string {
  const item = adminNavigation.flatMap(group => group.items).find(candidate => candidate.href === pathname);
  return item?.label || "管理控制台";
}
