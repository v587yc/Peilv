import Link from "next/link";
import { headers } from "next/headers";
import { ArrowLeft, LockKeyhole, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { requireAdminCapability, type AdminCapability, type AdminPrincipal } from "@/lib/auth/admin-capabilities";

export type AdminCapabilityGateProps = {
  required: AdminCapability;
  children: React.ReactNode | ((principal: AdminPrincipal) => React.ReactNode);
};

export async function AdminCapabilityGate({ required, children }: AdminCapabilityGateProps) {
  const requestHeaders = await headers();
  const request = new Request("http://admin.internal/page", { headers: new Headers(requestHeaders) });
  const authorization = await requireAdminCapability(request, required);

  if (!authorization.ok) {
    return <AdminForbidden required={required} authenticated={authorization.status === 403} />;
  }

  return <>{typeof children === "function" ? children(authorization.principal) : children}</>;
}

export function AdminForbidden({ required, authenticated = true }: { required: AdminCapability; authenticated?: boolean }) {
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-10rem)] max-w-xl items-center">
      <Card className="w-full border-white/8 bg-card/70 shadow-2xl shadow-black/20">
        <CardContent className="flex flex-col items-center px-6 py-12 text-center sm:px-10">
          <span className="mb-5 flex size-14 items-center justify-center rounded-2xl border border-warning/20 bg-warning/8 text-warning shadow-lg shadow-warning/5">
            {authenticated ? <ShieldAlert className="size-6" /> : <LockKeyhole className="size-6" />}
          </span>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-warning">403 · Access restricted</p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">没有此页面的访问权限</h1>
          <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
            当前管理会话不具备 <code className="rounded bg-background/70 px-1.5 py-0.5 text-foreground">{required}</code> 能力。页面业务组件未加载，也不会发起对应数据或写操作请求。
          </p>
          <Button asChild className="mt-7" variant="outline"><Link href="/admin"><ArrowLeft />返回控制台总览</Link></Button>
        </CardContent>
      </Card>
    </div>
  );
}
