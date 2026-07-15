"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { navigationLabel } from "./admin-nav";

export function AdminHeader() {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/session", { method: "DELETE" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
      <SidebarTrigger aria-label="切换侧栏" />
      <Breadcrumb className="flex-1">
        <BreadcrumbList>
          <BreadcrumbItem>
            {pathname === "/admin" ? <BreadcrumbPage>管理控制台</BreadcrumbPage> : (
              <BreadcrumbLink asChild><Link href="/admin">管理控制台</Link></BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {pathname !== "/admin" ? (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbPage>{navigationLabel(pathname)}</BreadcrumbPage></BreadcrumbItem>
            </>
          ) : null}
        </BreadcrumbList>
      </Breadcrumb>
      <Button variant="outline" size="sm" onClick={logout}>
        <LogOut aria-hidden="true" />退出
      </Button>
    </header>
  );
}
