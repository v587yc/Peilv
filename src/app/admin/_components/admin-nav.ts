import type { LucideIcon } from "lucide-react";
import { Activity, Database, FileClock, Gauge, RefreshCcw, Settings2, Shield, Users } from "lucide-react";
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
    label: "访问控制",
    items: [
      { label: "管理员", href: "/admin/admins", icon: Users, capability: "admin:manage", available: true },
      { label: "角色权限", href: "/admin/roles", icon: Shield, capability: "admin:manage", available: true },
    ],
  },
  {
    label: "总览",
    items: [{ label: "控制台总览", href: "/admin", icon: Gauge, capability: "admin:view", available: true }],
  },
  {
    label: "业务治理",
    items: [
      { label: "业务设置", href: "/admin/settings", icon: Settings2, capability: "admin:configure", available: true },
      { label: "数据源", href: "/admin/sources", icon: Database, capability: "admin:view", available: true },
      { label: "自动化治理", href: "/admin/automation", icon: Activity, capability: "admin:execute", available: true },
      { label: "策略治理", href: "/admin/strategies", icon: Gauge, capability: "admin:configure", available: true },
      { label: "回测管理", href: "/admin/backtests", icon: Database, capability: "admin:execute", available: true },
    ],
  },
  {
    label: "可观测性",
    items: [{ label: "审计日志", href: "/admin/audit", icon: FileClock, capability: "admin:view", available: true }],
  },
  {
    label: "发布运维",
    items: [{ label: "版本更新", href: "/admin/deployments", icon: RefreshCcw, capability: "admin:dangerous", available: true }],
  },
];

export function navigationLabel(pathname: string): string {
  if (pathname.startsWith("/admin/strategies/lab")) return "策略实验室";
  const item = adminNavigation.flatMap(group => group.items).filter(candidate => candidate.href && (candidate.href === pathname || pathname.startsWith(`${candidate.href}/`))).sort((a,b)=>(b.href?.length||0)-(a.href?.length||0))[0];
  return item?.label || "管理控制台";
}

export function visibleAdminNavigation(capabilities: readonly AdminCapability[]) {
  return adminNavigation
    .map(group => ({ ...group, items: group.items.filter(item => capabilities.includes(item.capability)) }))
    .filter(group => group.items.length > 0);
}
