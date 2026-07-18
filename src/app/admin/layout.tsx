import type { Metadata } from "next";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AdminHeader } from "./_components/admin-header";
import { AdminSidebar } from "./_components/admin-sidebar";
import { AdminSessionProvider } from "./_components/admin-session-context";

export const metadata: Metadata = {
  title: "统一管理控制台",
};

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <AdminSessionProvider>
      <SidebarProvider className="dark bg-[#080b12]">
        <AdminSidebar />
        <SidebarInset>
          <AdminHeader />
          <main className="mx-auto w-full max-w-[1600px] flex-1 p-4 md:p-6 lg:p-8">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </AdminSessionProvider>
  );
}
