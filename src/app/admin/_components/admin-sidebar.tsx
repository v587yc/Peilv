"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { visibleAdminNavigation } from "./admin-nav";
import { useAdminSession } from "./admin-session-context";

export function AdminSidebar() {
  const pathname = usePathname();
  const { loading, capabilities } = useAdminSession();
  const visibleGroups = visibleAdminNavigation(loading ? ["admin:view"] : capabilities);
  return (
    <Sidebar collapsible="icon" variant="inset" className="border-r border-white/7">
      <SidebarHeader className="border-b border-white/7 p-3">
        <div className="flex h-11 items-center gap-3 px-1 font-semibold">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><ShieldCheck aria-hidden="true" className="size-5" /></span>
          <span className="min-w-0 group-data-[collapsible=icon]:hidden"><span className="block truncate text-sm">运营管理中心</span><span className="mt-0.5 block text-[10px] font-normal uppercase tracking-[0.16em] text-muted-foreground">Control center</span></span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {visibleGroups.map(group => (
          <SidebarGroup key={group.label} className="px-2 py-2">
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map(item => {
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.label}>
                      {item.available && item.href ? (
                        <SidebarMenuButton asChild isActive={pathname === item.href || (item.href !== "/admin" && pathname.startsWith(`${item.href}/`))} tooltip={item.label} className="h-9 transition-colors">
                          <Link href={item.href} prefetch={pathname.startsWith("/admin/strategies/lab") ? false : undefined}>
                            <Icon aria-hidden="true" />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      ) : (
                        <SidebarMenuButton disabled aria-label={`${item.label}，后续阶段`} tooltip={`${item.label}（后续阶段）`}>
                          <Icon aria-hidden="true" />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      )}
                      {!item.available ? <SidebarMenuBadge>后续阶段</SidebarMenuBadge> : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
