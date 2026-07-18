"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { AuditLogDto, AuditPage } from "@/features/audit/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adminApiRequest, isAdminFeatureUnavailable } from "./admin-api-client";
import { AdminEmptyState, AdminLoadingState, RawDiagnostics } from "./admin-ui";

type ApiResult = AuditPage & { success: true };

function AuditDetails({ item }: { item: AuditLogDto }) {
  return (
    <div className="grid gap-3 text-sm">
      <div className="grid gap-3 rounded-xl border border-white/8 bg-white/[0.025] p-4 sm:grid-cols-2">
        <AuditDetail label="动作" value={item.action} />
        <AuditDetail label="对象" value={`${item.objectType}${item.objectId ? ` · ${item.objectId}` : ""}`} />
        <AuditDetail label="操作者" value={`${item.actorType}${item.actorId ? ` · ${item.actorId}` : ""}`} />
        <AuditDetail label="请求 ID" value={item.requestId || "—"} mono />
      </div>
      <RawDiagnostics value={item.oldValue} label="变更前数据" />
      <RawDiagnostics value={item.newValue} label="变更后数据" />
      <RawDiagnostics value={item.metadata} label="请求诊断元数据" />
    </div>
  );
}

function AuditDetail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className={mono ? "mt-1 truncate font-mono text-xs" : "mt-1 truncate font-medium"}>{value}</p></div>;
}

export function AuditLogView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [page, setPage] = useState<AuditPage>({ items: [], nextCursor: null, previousCursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<AuditLogDto | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError("");
    setUnavailable(false);
    try {
      const result = await adminApiRequest<Partial<ApiResult> & { error?: string }>(`/api/admin/audit?${searchParams.toString()}`, { cache: "no-store", signal }, "审计日志加载失败");
      if (!result.success || !Array.isArray(result.items)) throw new Error(result.error || "审计日志加载失败");
      setPage({ items: result.items, nextCursor: result.nextCursor || null, previousCursor: result.previousCursor || null });
    } catch (caught) {
      if (isAdminFeatureUnavailable(caught)) setUnavailable(true);
      else if ((caught as { name?: string }).name !== "AbortError") setError(caught instanceof Error ? caught.message : "审计日志加载失败");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [searchParams]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    for (const key of ["actorId", "actorType", "action", "objectType", "objectId", "requestId", "from", "to"]) {
      const value = data.get(key);
      if (typeof value === "string" && value.trim()) next.set(key, value.trim());
    }
    router.push(`${pathname}?${next.toString()}`);
  }

  function navigate(cursor: string, direction: "before" | "after") {
    const next = new URLSearchParams(searchParams);
    next.delete("before");
    next.delete("after");
    next.set(direction, cursor);
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <Card className="overflow-hidden border-white/8 bg-card/70 shadow-xl shadow-black/10">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <form onSubmit={submit} className="grid gap-2 md:grid-cols-4 xl:grid-cols-8" aria-label="审计日志筛选">
          <Input name="actorId" aria-label="Actor ID" placeholder="Actor ID" defaultValue={searchParams.get("actorId") || ""} />
          <Input name="actorType" aria-label="Actor 类型" placeholder="Actor 类型" defaultValue={searchParams.get("actorType") || ""} />
          <Input name="action" aria-label="动作" placeholder="动作" defaultValue={searchParams.get("action") || ""} />
          <Input name="objectType" aria-label="对象类型" placeholder="对象类型" defaultValue={searchParams.get("objectType") || ""} />
          <Input name="objectId" aria-label="对象 ID" placeholder="对象 ID" defaultValue={searchParams.get("objectId") || ""} />
          <Input name="requestId" aria-label="Request ID" placeholder="Request ID" defaultValue={searchParams.get("requestId") || ""} />
          <Input name="from" aria-label="开始时间" type="datetime-local" defaultValue={searchParams.get("from") || ""} />
          <Input name="to" aria-label="结束时间" type="datetime-local" defaultValue={searchParams.get("to") || ""} />
          <div className="flex gap-2 md:col-span-4 xl:col-span-8">
            <Button type="submit">应用筛选</Button>
            <Button type="button" variant="outline" onClick={() => router.push(pathname)}>清除</Button>
          </div>
        </form>

        {loading ? <AdminLoadingState label="正在查询审计记录" rows={5} /> : null}
        {!loading && error ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div> : null}
        {!loading && unavailable ? <AdminEmptyState title="审计服务尚未启用" description="其他后台功能不受影响；服务启用后，受保护操作会显示在这里。" /> : null}
        {!loading && !error && !unavailable && page.items.length === 0 ? <AdminEmptyState title="没有符合条件的审计记录" description="请调整筛选条件或清除过滤后重试。" /> : null}
        {!loading && !error && page.items.length ? (
          <><div className="grid gap-3 md:hidden">{page.items.map(item => <article key={item.id} className="rounded-xl border border-white/8 bg-background/30 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-medium">{item.action}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString("zh-CN")}</p></div><Badge variant="outline">{item.actorType}</Badge></div><p className="mt-4 truncate text-xs text-muted-foreground">{item.objectType} · {item.objectId || "—"}</p><Button className="mt-4 w-full" size="sm" variant="outline" onClick={() => setSelected(item)}>查看详情</Button></article>)}</div><div className="hidden overflow-x-auto md:block"><Table>
            <TableHeader><TableRow><TableHead>时间</TableHead><TableHead>Actor</TableHead><TableHead>动作</TableHead><TableHead>对象</TableHead><TableHead>Request ID</TableHead><TableHead className="text-right">详情</TableHead></TableRow></TableHeader>
            <TableBody>{page.items.map(item => (
              <TableRow key={item.id}>
                <TableCell className="font-mono text-xs">{new Date(item.createdAt).toLocaleString("zh-CN")}</TableCell>
                <TableCell><Badge variant="outline">{item.actorType}</Badge><div className="mt-1 max-w-48 truncate text-xs text-muted-foreground">{item.actorId || "—"}</div></TableCell>
                <TableCell className="font-medium">{item.action}</TableCell>
                <TableCell>{item.objectType}<div className="max-w-52 truncate text-xs text-muted-foreground">{item.objectId || "—"}</div></TableCell>
                <TableCell className="max-w-52 truncate font-mono text-xs">{item.requestId || "—"}</TableCell>
                <TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => setSelected(item)}>查看详情</Button></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table></div></>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={!page.previousCursor || loading} onClick={() => page.previousCursor && navigate(page.previousCursor, "after")}>上一页</Button>
          <Button variant="outline" disabled={!page.nextCursor || loading} onClick={() => page.nextCursor && navigate(page.nextCursor, "before")}>下一页</Button>
        </div>
      </CardContent>
      <Dialog open={Boolean(selected)} onOpenChange={open => !open && setSelected(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader><DialogTitle>审计详情</DialogTitle><DialogDescription>所有值均由服务端再次递归脱敏。</DialogDescription></DialogHeader>
          {selected ? <AuditDetails item={selected} /> : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
