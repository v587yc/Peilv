"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertCircle, Loader2, LogOut, ShieldCheck } from "lucide-react";
import { useState } from "react";
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
import { ADMIN_ROLE_LABELS, useAdminSession } from "./admin-session-context";

export function AdminHeader() {
  const pathname = usePathname();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const { user, loading } = useAdminSession();
  const isStrategyLab = pathname.startsWith("/admin/strategies/lab");

  async function logout() {
    setLoggingOut(true);
    setLogoutError("");
    try {
      const response = await fetch("/api/auth/session", { method: "DELETE" });
      if (!response.ok) throw new Error("退出失败");
      window.location.replace("/login");
    } catch {
      setLogoutError("退出失败，请重试");
      setLoggingOut(false);
    }
  }

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-white/7 bg-background/80 px-4 backdrop-blur-xl md:px-6">
      <SidebarTrigger aria-label="切换侧栏" />
      <Breadcrumb className="flex-1">
        <BreadcrumbList>
          <BreadcrumbItem>
            {pathname === "/admin" ? <BreadcrumbPage>管理控制台</BreadcrumbPage> : (
              <BreadcrumbLink asChild><Link href="/admin" prefetch={isStrategyLab ? false : undefined}>管理控制台</Link></BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {pathname !== "/admin" ? (
            <>
              <BreadcrumbSeparator />
              {isStrategyLab ? <><BreadcrumbItem><BreadcrumbLink asChild><Link href="/admin/strategies" prefetch={false}>策略治理</Link></BreadcrumbLink></BreadcrumbItem><BreadcrumbSeparator /></> : null}
              <BreadcrumbItem><BreadcrumbPage>{navigationLabel(pathname)}</BreadcrumbPage></BreadcrumbItem>
            </>
          ) : null}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="hidden items-center gap-2 rounded-full border border-success/15 bg-success/6 px-3 py-1.5 text-xs text-muted-foreground sm:flex"><ShieldCheck className="size-3.5 text-success" /><span>{loading ? "正在确认权限" : user ? ADMIN_ROLE_LABELS[user.role] : "安全会话"}</span></div>
      {logoutError ? <span role="alert" className="hidden items-center gap-1 text-xs text-destructive md:flex"><AlertCircle className="size-3.5" />{logoutError}</span> : null}
      <Button variant="outline" size="sm" onClick={logout} disabled={loggingOut} className="bg-card/50">
        {loggingOut ? <Loader2 aria-hidden="true" className="animate-spin" /> : <LogOut aria-hidden="true" />}{loggingOut ? "退出中" : "退出"}
      </Button>
    </header>
  );
}
