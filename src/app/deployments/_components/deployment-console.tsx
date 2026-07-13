"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Clock3,
  ExternalLink,
  GitBranch,
  Loader2,
  LogOut,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  Rocket,
  ServerCog,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CandidateStatus, DeploymentOperation, DeploymentOverview, OperationStatus } from "@/lib/release-control/types";

type Session = {
  actor: { username: string };
  csrf: { preflight: string; deploy: string; rollback: string; logout: string };
};

const candidateLabels: Record<CandidateStatus, string> = {
  building: "构建中",
  ready: "可预检",
  ci_failed: "CI 失败",
  artifact_expired: "制品已过期",
};
const operationLabels: Record<OperationStatus, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_approval: "等待审批",
  passed: "预检通过",
  blocked: "检查未通过",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
};

function StatusBadge({ status }: { status: CandidateStatus | OperationStatus }) {
  const success = status === "ready" || status === "passed" || status === "succeeded";
  const danger = status === "ci_failed" || status === "blocked" || status === "failed" || status === "artifact_expired";
  const pending = status === "building" || status === "running" || status === "queued" || status === "waiting_approval";
  const Icon = success ? CheckCircle2 : danger ? XCircle : pending ? Clock3 : CircleDot;
  const label = status in candidateLabels ? candidateLabels[status as CandidateStatus] : operationLabels[status as OperationStatus];
  return (
    <Badge variant={danger ? "destructive" : success ? "default" : "secondary"} className="gap-1.5">
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  );
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatSize(value: number | null) {
  if (value === null) return "—";
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function OperationItem({ operation }: { operation: DeploymentOperation }) {
  const kind = operation.kind === "preflight" ? "生产预检" : operation.kind === "deploy" ? "生产部署" : "代码回退";
  return (
    <li className="grid gap-3 border-b border-border py-4 last:border-0 md:grid-cols-[120px_1fr_auto] md:items-center">
      <div className="flex items-center gap-2 text-sm font-medium">
        {operation.kind === "rollback" ? <RotateCcw aria-hidden="true" className="size-4 text-warning" /> : <ServerCog aria-hidden="true" className="size-4 text-info" />}
        {kind}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground">{operation.title}</p>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {operation.commitSha.slice(0, 12)} · {operation.actor || "GitHub Actions"} · {formatDate(operation.createdAt)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge status={operation.status} />
        <Button asChild size="icon" variant="ghost" className="size-10 cursor-pointer" aria-label={`查看 ${kind} GitHub 运行`}>
          <a href={operation.url} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" /></a>
        </Button>
      </div>
    </li>
  );
}

export function DeploymentConsole() {
  const [overview, setOverview] = useState<DeploymentOverview | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [preflightRunId, setPreflightRunId] = useState<number | null>(null);
  const [deployingRunId, setDeployingRunId] = useState<number | null>(null);
  const [deployConfirmation, setDeployConfirmation] = useState("");
  const [rollbackTarget, setRollbackTarget] = useState<DeploymentOverview["candidates"][number] | null>(null);
  const [rollbackConfirmation, setRollbackConfirmation] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");
  const [rollingBack, setRollingBack] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [overviewResponse, sessionResponse] = await Promise.all([
        fetch("/api/deployments/overview", { cache: "no-store" }),
        fetch("/api/deployment-auth/session", { cache: "no-store" }),
      ]);
      const overviewResult = await overviewResponse.json() as { success: boolean; overview?: DeploymentOverview; error?: string };
      if (!overviewResponse.ok || !overviewResult.overview) throw new Error(overviewResult.error || "无法读取发布状态");
      setOverview(overviewResult.overview);
      if (sessionResponse.ok) setSession(await sessionResponse.json() as Session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取发布状态");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!overview?.operations.some(item => ["queued", "running", "waiting_approval"].includes(item.status))) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load, overview?.operations]);

  const latestReady = useMemo(() => overview?.candidates.find(item => item.status === "ready") ?? null, [overview]);
  const activeOperation = overview?.operations.find(item => ["queued", "running", "waiting_approval"].includes(item.status));
  const passedPreflight = overview?.operations.find(item => item.kind === "preflight" && item.status === "passed") ?? null;
  const deployCandidate = passedPreflight
    ? overview?.candidates.find(candidate => passedPreflight.title.includes(candidate.releaseId) && candidate.status === "ready") ?? null
    : null;

  async function runPreflight(candidate: DeploymentOverview["candidates"][number]) {
    if (!session || candidate.artifactId === null) return;
    setPreflightRunId(candidate.runId);
    setError("");
    try {
      const response = await fetch("/api/deployments/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": session.csrf.preflight },
        body: JSON.stringify({
          runId: candidate.runId,
          runAttempt: candidate.runAttempt,
          artifactId: candidate.artifactId,
          releaseId: candidate.releaseId,
        }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!response.ok || !result.success) throw new Error(result.error || "无法触发生产预检");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法触发生产预检");
    } finally {
      setPreflightRunId(null);
    }
  }

  async function deploy() {
    if (!session || !passedPreflight || !deployCandidate || deployConfirmation !== deployCandidate.releaseId) return;
    setDeployingRunId(passedPreflight.runId);
    setError("");
    try {
      const response = await fetch("/api/deployments/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": session.csrf.deploy },
        body: JSON.stringify({
          preflightRunId: passedPreflight.runId,
          releaseId: deployCandidate.releaseId,
          confirmation: deployConfirmation,
        }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!response.ok || !result.success) throw new Error(result.error || "无法触发生产部署");
      setDeployConfirmation("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法触发生产部署");
    } finally {
      setDeployingRunId(null);
    }
  }

  async function rollback() {
    if (!session || !rollbackTarget || !overview?.currentRelease || rollbackConfirmation !== rollbackTarget.releaseId) return;
    setRollingBack(true);
    setError("");
    try {
      const response = await fetch("/api/deployments/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": session.csrf.rollback },
        body: JSON.stringify({
          targetReleaseId: rollbackTarget.releaseId,
          expectedCurrentReleaseId: overview.currentRelease,
          confirmation: rollbackConfirmation,
          reason: rollbackReason,
        }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!response.ok || !result.success) throw new Error(result.error || "无法触发代码回退");
      setRollbackTarget(null);
      setRollbackConfirmation("");
      setRollbackReason("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法触发代码回退");
    } finally {
      setRollingBack(false);
    }
  }

  async function logout() {
    if (!session) return;
    await fetch("/api/deployment-auth/session", { method: "DELETE", headers: { "x-csrf-token": session.csrf.logout } });
    window.location.assign("/deployment-login");
  }

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto max-w-[1600px] space-y-6 px-4 py-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-border pb-5 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/15">
              <ShieldCheck aria-hidden="true" className="size-6" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">版本管理与部署控制台</h1>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">固定仓库 · build once · 人工审批 · 原子发布 · code-only rollback</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {session ? <Badge variant="outline" className="h-9 gap-2 px-3"><ShieldCheck aria-hidden="true" />{session.actor.username}</Badge> : null}
            <Button variant="outline" className="h-10 cursor-pointer" onClick={() => void load()} disabled={loading}>
              <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} />刷新状态
            </Button>
            <Button variant="ghost" className="h-10 cursor-pointer" onClick={() => void logout()} disabled={!session}>
              <LogOut aria-hidden="true" />退出
            </Button>
          </div>
        </header>

        {error ? (
          <div role="alert" className="flex items-start justify-between gap-4 rounded-xl border border-destructive/40 bg-destructive/10 p-4">
            <div className="flex gap-3"><AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" /><div><p className="font-medium">GitHub 发布状态暂不可用</p><p className="mt-1 text-sm text-muted-foreground">{error}。为避免误操作，部署和回退入口已禁用。</p></div></div>
            <Button variant="outline" className="cursor-pointer" onClick={() => void load()}>重试</Button>
          </div>
        ) : null}

        <section aria-label="生产发布摘要" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Card><CardHeader className="pb-3"><CardDescription>固定仓库</CardDescription><CardTitle className="font-mono text-base">{overview?.repository || "—"}</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">仅允许 main 与预定义 Actions workflow</CardContent></Card>
          <Card><CardHeader className="pb-3"><CardDescription>当前生产版本</CardDescription><CardTitle className="font-mono text-base">{overview?.currentRelease || "等待结构化部署结果"}</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">服务器 expected-current 会再次校验</CardContent></Card>
          <Card><CardHeader className="pb-3"><CardDescription>最新可用候选</CardDescription><CardTitle className="font-mono text-base">{latestReady?.releaseId || "暂无"}</CardTitle></CardHeader><CardContent className="flex items-center gap-2 text-sm text-muted-foreground"><PackageCheck aria-hidden="true" className="size-4" />{latestReady ? "CI 与候选制品已就绪" : "等待 main CI 成功"}</CardContent></Card>
          <Card><CardHeader className="pb-3"><CardDescription>生产操作状态</CardDescription><CardTitle className="text-base">{activeOperation ? operationLabels[activeOperation.status] : "空闲"}</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">部署与回退共享生产并发锁</CardContent></Card>
        </section>

        <div className="grid gap-6 2xl:grid-cols-[minmax(0,1.65fr)_minmax(380px,0.75fr)]">
          <Card className="min-w-0">
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div><CardTitle>发布候选</CardTitle><CardDescription className="mt-1">来自成功 main push 的唯一 CI 制品；预检前仍会交叉验证 manifest。</CardDescription></div>
              <Badge variant="secondary">{overview?.candidates.length ?? 0} 个</Badge>
            </CardHeader>
            <CardContent>
              {loading && !overview ? <div className="flex min-h-56 items-center justify-center text-muted-foreground"><Loader2 aria-hidden="true" className="mr-2 size-5 animate-spin" />正在读取 GitHub Actions</div> : null}
              {!loading && overview?.candidates.length === 0 ? <div className="rounded-xl border border-dashed border-border p-10 text-center text-muted-foreground">main 分支尚无可展示的 CI 候选。</div> : null}
              {overview?.candidates.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>Release / Commit</TableHead><TableHead>状态</TableHead><TableHead>构建</TableHead><TableHead>制品</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                  <TableBody>{overview.candidates.map(candidate => (
                    <TableRow key={candidate.runId}>
                      <TableCell className="min-w-[300px]"><p className="font-mono text-sm font-medium">{candidate.releaseId}</p><p className="mt-1 max-w-[520px] truncate text-xs text-muted-foreground">{candidate.commitTitle}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{candidate.commitSha.slice(0, 12)} · {candidate.author}</p></TableCell>
                      <TableCell><StatusBadge status={candidate.status} /></TableCell>
                      <TableCell><p className="text-sm">Attempt {candidate.runAttempt}</p><p className="mt-1 text-xs text-muted-foreground">{formatDate(candidate.createdAt)}</p></TableCell>
                      <TableCell><p className="font-mono text-sm">{formatSize(candidate.artifactSize)}</p><p className="mt-1 text-xs text-muted-foreground">到期 {formatDate(candidate.artifactExpiresAt)}</p></TableCell>
                      <TableCell className="text-right"><div className="flex justify-end gap-2"><Button size="sm" variant="outline" className="cursor-pointer" disabled={candidate.status !== "ready" || Boolean(activeOperation) || !session || preflightRunId !== null} onClick={() => void runPreflight(candidate)}>{preflightRunId === candidate.runId ? <Loader2 aria-hidden="true" className="animate-spin" /> : <GitBranch aria-hidden="true" />}运行预检</Button><Button size="sm" variant="ghost" className="cursor-pointer" disabled={!overview.currentRelease || overview.currentRelease === candidate.releaseId || Boolean(activeOperation) || !session} onClick={() => { setRollbackTarget(candidate); setRollbackConfirmation(""); setRollbackReason(""); }}><RotateCcw aria-hidden="true" />回退</Button><Button asChild size="icon" variant="ghost" className="size-10" aria-label="查看候选 GitHub 运行"><a href={candidate.url} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" /></a></Button></div></TableCell>
                    </TableRow>
                  ))}</TableBody>
                </Table>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>生产操作时间线</CardTitle><CardDescription>GitHub Actions 是执行状态的事实来源。</CardDescription></CardHeader>
            <CardContent>
              {deployCandidate && passedPreflight ? (
                <AlertDialog onOpenChange={open => { if (!open) setDeployConfirmation(""); }}>
                  <AlertDialogTrigger asChild>
                    <Button className="mb-4 w-full cursor-pointer" disabled={Boolean(activeOperation) || !session || deployingRunId !== null}>
                      <Rocket aria-hidden="true" />批准部署 {deployCandidate.releaseId}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>确认部署到生产环境</AlertDialogTitle>
                      <AlertDialogDescription className="space-y-3">
                        <span className="block">此操作将精确使用预检运行 #{passedPreflight.runId} 绑定的 CI 制品，并进入 GitHub production Environment 人工审批。</span>
                        <span className="block">服务器取得并发锁后会再次校验当前生产版本。数据库迁移可能执行，失败时不会自动恢复数据库。</span>
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="space-y-2">
                      <p className="text-sm">输入完整 release ID 以确认：</p>
                      <code className="block rounded-md bg-muted p-2 text-xs">{deployCandidate.releaseId}</code>
                      <Input value={deployConfirmation} onChange={event => setDeployConfirmation(event.target.value)} autoComplete="off" spellCheck={false} aria-label="输入完整 release ID 确认部署" />
                    </div>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="cursor-pointer">取消</AlertDialogCancel>
                      <Button className="cursor-pointer" disabled={deployConfirmation !== deployCandidate.releaseId || deployingRunId !== null} onClick={() => void deploy()}>
                        {deployingRunId ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Rocket aria-hidden="true" />}确认并提交审批
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
              {overview?.operations.length ? <ol>{overview.operations.slice(0, 12).map(item => <OperationItem key={`${item.kind}-${item.runId}`} operation={item} />)}</ol> : <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">暂无 preflight、部署或回退运行。</div>}
            </CardContent>
          </Card>
        </div>

        <AlertDialog open={Boolean(rollbackTarget)} onOpenChange={open => { if (!open) { setRollbackTarget(null); setRollbackConfirmation(""); setRollbackReason(""); } }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认 code-only rollback</AlertDialogTitle>
              <AlertDialogDescription className="space-y-3">
                <span className="block">当前版本：<code>{overview?.currentRelease || "—"}</code></span>
                <span className="block">目标版本：<code>{rollbackTarget?.releaseId || "—"}</code></span>
                <span className="block font-medium text-warning">数据库不会恢复，也不会运行 migration。服务器会再次强制检查两个 release manifest、数据库 migration ledger 与代码兼容性。</span>
                <span className="block">操作会短暂停止任务 timers 和应用，并先在 5001 验证目标代码。</span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-3">
              <Input value={rollbackReason} onChange={event => setRollbackReason(event.target.value)} placeholder="填写回退原因（至少 10 个字符）" maxLength={300} aria-label="回退原因" />
              <p className="text-sm">输入完整目标 release ID：</p>
              <code className="block rounded-md bg-muted p-2 text-xs">{rollbackTarget?.releaseId}</code>
              <Input value={rollbackConfirmation} onChange={event => setRollbackConfirmation(event.target.value)} autoComplete="off" spellCheck={false} aria-label="输入完整目标 release ID 确认回退" />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel className="cursor-pointer">取消</AlertDialogCancel>
              <Button variant="destructive" className="cursor-pointer" disabled={!rollbackTarget || rollbackConfirmation !== rollbackTarget.releaseId || rollbackReason.trim().length < 10 || rollingBack} onClick={() => void rollback()}>
                {rollingBack ? <Loader2 aria-hidden="true" className="animate-spin" /> : <RotateCcw aria-hidden="true" />}确认代码回退
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Card className="border-warning/30 bg-warning/5">
          <CardContent className="flex flex-col gap-4 py-5 md:flex-row md:items-center md:justify-between">
            <div className="flex gap-3"><AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" /><div><p className="font-medium">数据库恢复不会出现在此控制台</p><p className="mt-1 text-sm leading-6 text-muted-foreground">网页回退只切换经过验证且兼容当前 schema 的代码版本。数据库 restore 继续使用独立 break-glass 流程。</p></div></div>
            <Badge variant="outline" className="border-warning/40 text-warning">安全边界已锁定</Badge>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
