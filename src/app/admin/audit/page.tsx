import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { AuditLogView } from "../_components/audit-log-view";

export default function AuditPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">审计日志</h1>
        <p className="mt-1 text-sm text-muted-foreground">按管理员、动作、对象、请求与时间定位受保护操作。</p>
      </div>
      <Suspense fallback={<Skeleton className="h-80 w-full" aria-label="正在加载审计日志" />}>
        <AuditLogView />
      </Suspense>
    </div>
  );
}
