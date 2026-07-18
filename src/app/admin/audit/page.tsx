import { Suspense } from "react";
import { FileClock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { AuditLogView } from "../_components/audit-log-view";
import { AdminCapabilityGate } from "../_components/admin-capability-gate";
import { ADMIN_PAGE_CAPABILITIES } from "../_components/admin-page-access";
import { AdminLoadingState, AdminPageHeader } from "../_components/admin-ui";

export default function AuditPage() {
  return <AdminCapabilityGate required={ADMIN_PAGE_CAPABILITIES["/admin/audit"]}>
    <div className="space-y-5">
      <AdminPageHeader eyebrow="Security trail" icon={FileClock} title="审计日志" description="按管理员、动作、对象、请求与时间定位受保护操作。原始变更值默认折叠并由服务端脱敏。" />
      <Suspense fallback={<Card className="overflow-hidden border-white/8 bg-card/70"><AdminLoadingState label="正在加载审计日志" rows={5} /></Card>}>
        <AuditLogView />
      </Suspense>
    </div>
  </AdminCapabilityGate>;
}
