"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, RotateCcw, Rocket } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { DeploymentOperation, DeploymentOverview } from "@/lib/release-control/types";
import { adminApiRequest, isAdminFeatureUnavailable } from "./admin-api-client";

const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
const activeStatuses = new Set(["queued", "running", "waiting_approval"]);
const failedStatuses = new Set(["blocked", "failed", "cancelled"]);

export function VersionUpdateView() {
  const [overview, setOverview] = useState<DeploymentOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [reason, setReason] = useState("例行版本更新");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setUnavailable(false);
    try {
      const result = await adminApiRequest<{ overview?: DeploymentOverview; error?: string }>(
        "/api/admin/deployments/overview",
        { cache: "no-store" },
        "检测更新失败",
      );
      if (!result.overview) throw new Error(result.error || "检测更新失败");
      setOverview(result.overview);
    } catch (cause) {
      if (isAdminFeatureUnavailable(cause)) {
        setOverview(null);
        setUnavailable(true);
      } else setError(cause instanceof Error ? cause.message : "检测更新失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const candidate = useMemo(
    () => overview?.candidates.find(item => item.status === "ready" && item.releaseId !== overview.currentRelease) || null,
    [overview],
  );
  const active = overview?.operations.find(item => activeStatuses.has(item.status));
  const previous = overview?.previousRelease || null;

  async function command(url: string, body: Record<string, unknown>) {
    const result = await adminApiRequest<{ success?: boolean; error?: string }>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, "操作失败");
    if (!result.success) throw new Error(result.error || "操作失败");
  }

  async function update() {
    if (!candidate || candidate.artifactId === null) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await command("/api/admin/deployments/preflight", {
        runId: candidate.runId,
        runAttempt: candidate.runAttempt,
        artifactId: candidate.artifactId,
        releaseId: candidate.releaseId,
        reason: reason.trim(),
        idempotencyKey: `version-preflight:${candidate.releaseId}`,
      });

      let passed: DeploymentOperation | undefined;
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await wait(4000);
        const result = await adminApiRequest<{ overview?: DeploymentOverview; error?: string }>(
          "/api/admin/deployments/overview",
          { cache: "no-store" },
          "预检状态读取失败",
        );
        if (!result.overview) throw new Error(result.error || "预检状态读取失败");
        setOverview(result.overview);
        const preflight = result.overview.operations.filter(item => item.kind === "preflight" && item.title.includes(candidate.releaseId));
        passed = preflight.find(item => item.status === "passed");
        if (preflight.some(item => failedStatuses.has(item.status))) throw new Error("版本预检未通过");
        if (passed) break;
      }
      if (!passed) throw new Error("版本预检等待超时");

      await command("/api/admin/deployments/deploy", {
        preflightRunId: passed.runId,
        releaseId: candidate.releaseId,
        confirmation: candidate.releaseId,
        reason: reason.trim(),
        idempotencyKey: `version-update:${candidate.releaseId}`,
      });
      setSuccess(`版本 ${candidate.releaseId} 已提交更新`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function rollback() {
    if (!previous || !overview?.currentRelease) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await command("/api/admin/deployments/rollback", {
        targetReleaseId: previous,
        expectedCurrentReleaseId: overview.currentRelease,
        confirmation: previous,
        reason: "管理员从版本更新页恢复到先前版本",
        idempotencyKey: `version-rollback:${overview.currentRelease}:${previous}`,
      });
      setSuccess(`已提交恢复到 ${previous}`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复失败");
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-5 pb-8">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div><h1 className="text-2xl font-semibold tracking-tight">版本更新</h1><p className="mt-1 text-sm text-muted-foreground">检测并安装由 CI 生成的不可变版本包；更新过程会短暂重启服务。</p></div>
      <Button className="w-full sm:w-auto" variant="outline" onClick={() => void load()} disabled={loading || busy}><RefreshCw className={loading ? "animate-spin" : ""} />检测更新</Button>
    </div>
    {error ? <div role="alert" className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"><AlertTriangle className="size-4 shrink-0" />{error}</div> : null}
    {success ? <div role="status" className="flex gap-2 rounded-lg border border-success/30 bg-success/8 p-3 text-sm text-success"><CheckCircle2 className="size-4 shrink-0" />{success}</div> : null}
    {unavailable ? <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">当前环境未启用版本更新服务，其他后台功能不受影响。</CardContent></Card> : null}
    {loading && !overview && !unavailable ? <Card><CardContent className="flex items-center gap-2 p-8 text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在检测可用版本…</CardContent></Card> : null}
    {overview ? <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <VersionCard label="当前版本" value={overview.currentRelease || "未知"} />
        <VersionCard label="可用更新" value={candidate?.releaseId || "已是最新"} />
        <VersionCard label="状态" value={active ? "正在执行" : "空闲"} />
      </div>
      <Card><CardHeader><CardTitle>更新控制</CardTitle><CardDescription>自动完成预检、制品下载与校验、安装、切换和健康检查。</CardDescription></CardHeader><CardContent className="space-y-4">
        <Input aria-label="更新原因" value={reason} onChange={event => setReason(event.target.value)} placeholder="更新原因" maxLength={300} />
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <AlertDialog><AlertDialogTrigger asChild><Button className="w-full sm:w-auto" disabled={!candidate || busy || Boolean(active) || reason.trim().length < 3}>{busy ? <Loader2 className="animate-spin" /> : <Rocket />}立即更新{candidate ? `到 ${candidate.releaseId}` : ""}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>立即更新应用版本？</AlertDialogTitle><AlertDialogDescription>服务会在版本切换期间短暂重启。系统将自动绑定并复核目标版本、预检结果与当前版本；数据库迁移不会自动回滚。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><Button onClick={() => void update()}>确认更新</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
          {previous ? <AlertDialog><AlertDialogTrigger asChild><Button className="w-full sm:w-auto" variant="outline" disabled={busy || Boolean(active)}><RotateCcw />恢复到 {previous}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>恢复到先前版本？</AlertDialogTitle><AlertDialogDescription>此操作会切换应用制品，但不会自动回滚数据库迁移。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><Button variant="destructive" onClick={() => void rollback()}>确认恢复</Button></AlertDialogFooter></AlertDialogContent></AlertDialog> : null}
        </div>
        {!candidate && !active ? <div className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="size-4" />当前已是最新可用版本</div> : null}
        {active ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{active.title}<Badge variant="outline">{active.status}</Badge></div> : null}
      </CardContent></Card>
    </> : null}
  </div>;
}

function VersionCard({ label, value }: { label: string; value: string }) {
  return <Card><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="break-all font-mono text-base">{value}</CardTitle></CardHeader></Card>;
}
