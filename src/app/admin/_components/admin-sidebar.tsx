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
import { adminNavigation } from "./admin-nav";

export function AdminSidebar() {
  const pathname = usePathname();
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <div className="flex h-10 items-center gap-2 px-2 font-semibold">
          <ShieldCheck aria-hidden="true" className="size-5 text-primary" />
          <span className="group-data-[collapsible=icon]:hidden">统一管理控制台</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {adminNavigation.map(group => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map(item => {
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.label}>
                      {item.available && item.href ? (
                        <SidebarMenuButton asChild isActive={pathname === item.href} tooltip={item.label}>
                          <Link href={item.href}>
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
