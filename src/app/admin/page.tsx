import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ADMIN_CAPABILITIES } from "@/lib/auth/admin-capabilities";

export default function AdminOverviewPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">控制台总览</h1>
        <p className="mt-1 text-sm text-muted-foreground">统一认证、能力授权和审计基础设施已启用。</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">认证状态</CardTitle>
            <CardDescription>当前统一管理员会话</CardDescription>
          </CardHeader>
          <CardContent><Badge variant="secondary">已认证：single-team-admin</Badge></CardContent>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">服务端能力</CardTitle>
            <CardDescription>所有管理 API 仍会独立校验所需能力</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {ADMIN_CAPABILITIES.map(capability => <Badge key={capability} variant="outline">{capability}</Badge>)}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">阶段状态</CardTitle>
          <CardDescription>总览和审计日志现已可用；业务治理与版本更新将在后续阶段启用。</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
