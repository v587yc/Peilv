import type { Metadata } from "next";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AdminHeader } from "./_components/admin-header";
import { AdminSidebar } from "./_components/admin-sidebar";

export const metadata: Metadata = {
  title: "统一管理控制台",
};

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <SidebarProvider>
      <AdminSidebar />
      <SidebarInset>
        <AdminHeader />
        <div className="mx-auto w-full max-w-[1600px] flex-1 p-4 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
