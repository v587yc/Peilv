"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { AuditLogDto, AuditPage } from "@/features/audit/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type ApiResult = AuditPage & { success: true };

function AuditDetails({ item }: { item: AuditLogDto }) {
  return (
    <div className="grid gap-3 text-sm">
      {(["oldValue", "newValue", "metadata"] as const).map(key => (
        <section key={key}>
          <h3 className="mb-1 font-medium">{key}</h3>
          <pre className="max-h-52 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-all">
            {JSON.stringify(item[key], null, 2)}
          </pre>
        </section>
      ))}
    </div>
  );
}

export function AuditLogView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [page, setPage] = useState<AuditPage>({ items: [], nextCursor: null, previousCursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<AuditLogDto | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/audit?${searchParams.toString()}`, { cache: "no-store", signal });
      const result = await response.json().catch(() => ({})) as Partial<ApiResult> & { error?: string };
      if (!response.ok || !result.success || !Array.isArray(result.items)) throw new Error(result.error || "审计日志加载失败");
      setPage({ items: result.items, nextCursor: result.nextCursor || null, previousCursor: result.previousCursor || null });
    } catch (caught) {
      if ((caught as { name?: string }).name !== "AbortError") setError(caught instanceof Error ? caught.message : "审计日志加载失败");
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
    <Card>
      <CardContent className="space-y-4 pt-6">
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

        {loading ? <div className="space-y-2" aria-label="正在加载"><Skeleton className="h-10 w-full" /><Skeleton className="h-32 w-full" /></div> : null}
        {!loading && error ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div> : null}
        {!loading && !error && page.items.length === 0 ? <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">没有符合条件的审计记录</div> : null}
        {!loading && !error && page.items.length ? (
          <Table>
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
          </Table>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={!page.previousCursor || loading} onClick={() => page.previousCursor && navigate(page.previousCursor, "after")}>上一页</Button>
          <Button variant="outline" disabled={!page.nextCursor || loading} onClick={() => page.nextCursor && navigate(page.nextCursor, "before")}>下一页</Button>
        </div>
      </CardContent>
      <Dialog open={Boolean(selected)} onOpenChange={open => !open && setSelected(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader><DialogTitle>审计详情</DialogTitle><DialogDescription>所有值均由服务端再次递归脱敏。</DialogDescription></DialogHeader>
          {selected ? <AuditDetails item={selected} /> : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
