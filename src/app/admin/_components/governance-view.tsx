"use client";
import Link from "next/link";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AdminCapability } from "@/lib/auth/admin-capabilities";
import { adminApiRequest, isAdminFeatureUnavailable } from "./admin-api-client";
import { RawDiagnostics } from "./admin-ui";

type Props = { kind: "settings" | "sources" | "automation" | "strategies" | "backtests"; capabilities: readonly AdminCapability[] };
type SettingItem = { id: string; label: string; source: string; sensitive: boolean; configured: boolean; effectiveAfter: string; value?: string };
type SourceItem = { status: string; observedAt: string; data?: unknown; error?: unknown };
type StrategyItem = { version: string; name: string; status: string; model_version: string };
type BacktestItem = { id: string; status: string; start_date: string; end_date: string; processed_dates: number; total_dates: number; accuracy: string; last_error?: string };
type GovernanceData = {
  settings?: SettingItem[];
  sections?: Record<string, SourceItem>;
  plans?: unknown[];
  tasks?: unknown[];
  items?: StrategyItem[] | BacktestItem[];
  limits?: { maxDateRangeDays: number; maxMatches: number };
};

const titles = {
  settings: ["业务设置", "安全管理运行时配置；敏感值只能替换，永不回显。"],
  sources: ["数据源", "只读查看存储、外部提供方、公司范围和数据质量。"],
  automation: ["自动化治理", "查看代码定义的计划、任务、步骤与重试状态。"],
  strategies: ["策略治理", "创建、发布和回退有版本记录的分析策略。"],
  backtests: ["回测管理", "启动、取消或继续持久化回测任务。"],
} as const;

const sourceLabels: Record<string, string> = { database: "数据库", external: "外部服务", companies: "赔率公司", quality: "数据质量" };
const statusLabels: Record<string, string> = {
  ok: "正常", healthy: "正常", active: "运行中", running: "运行中", pending: "等待中", queued: "排队中",
  completed: "已完成", success: "已完成", error: "失败", failed: "失败", degraded: "需关注", cancelled: "已取消", cancelling: "取消中",
};

const commandKey = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const textValue = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value : fallback;

function dateRangeDays(startDate: string, endDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return null;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const normalizedStart = new Date(start).toISOString().slice(0, 10);
  const normalizedEnd = new Date(end).toISOString().slice(0, 10);
  if (normalizedStart !== startDate || normalizedEnd !== endDate || end < start) return null;
  return Math.floor((end - start) / 86_400_000) + 1;
}

function statusVariant(status: string): "secondary" | "destructive" | "outline" {
  if (["error", "failed"].includes(status)) return "destructive";
  if (["ok", "healthy", "completed", "success", "active", "running"].includes(status)) return "secondary";
  return "outline";
}

export function GovernanceView({ kind, capabilities }: Props) {
  const [data, setData] = useState<GovernanceData | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("管理员后台操作");
  const [strategyName, setStrategyName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [maxMatches, setMaxMatches] = useState("50");
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError("");
    setUnavailable(false);
    if (refresh) setSuccess("");
    try {
      const result = await adminApiRequest<GovernanceData & { error?: string }>(`/api/admin/${kind}`, { cache: "no-store" }, "加载失败");
      setData(result);
    } catch (cause) {
      if (isAdminFeatureUnavailable(cause)) {
        setData(null);
        setUnavailable(true);
      } else setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => { void load(); }, [load]);

  async function send(method: string, targetId: string, payload: Record<string, unknown>, confirmation?: string) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await adminApiRequest<Record<string, unknown> & { error?: string }>(`/api/admin/${kind}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, reason, idempotencyKey: commandKey(targetId), confirmation, payload }),
      }, "操作失败");
      setSuccess("操作已提交并刷新最新状态");
      await load();
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  const [title, description] = titles[kind];
  const items = data?.items || [];
  const canConfigure = capabilities.includes("admin:configure");
  const canExecute = capabilities.includes("admin:execute");
  const canDangerous = capabilities.includes("admin:dangerous");
  const canWrite = kind === "settings" ? canConfigure : kind === "automation" || kind === "backtests" ? canExecute : kind === "strategies" ? canConfigure : false;
  const rangeDays = useMemo(() => dateRangeDays(startDate, endDate), [startDate, endDate]);
  const requestedMatches = Number(maxMatches);
  const backtestValidation = !startDate || !endDate
    ? "请选择开始和结束日期"
    : rangeDays === null
      ? "结束日期不能早于开始日期"
      : data?.limits && rangeDays > data.limits.maxDateRangeDays
        ? `日期范围不能超过 ${data.limits.maxDateRangeDays} 天`
        : !Number.isInteger(requestedMatches) || requestedMatches < 1
          ? "赛事上限必须是正整数"
          : data?.limits && requestedMatches > data.limits.maxMatches
            ? `赛事上限不能超过 ${data.limits.maxMatches}`
            : "";

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><h1 className="text-2xl font-semibold tracking-tight">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>
        <Button variant="outline" onClick={() => void load(true)} disabled={loading || busy} className="w-full sm:w-auto">
          <RefreshCw className={loading ? "animate-spin" : ""} />刷新
        </Button>
      </div>
      {error ? <div role="alert" className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div> : null}
      {success ? <div role="status" className="flex gap-2 rounded-lg border border-success/30 bg-success/8 p-3 text-sm text-success"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{success}</div> : null}
      {canWrite ? <div className="space-y-2"><Label htmlFor={`${kind}-reason`}>操作原因</Label><Input id={`${kind}-reason`} value={reason} onChange={event => setReason(event.target.value)} placeholder="操作原因（至少 3 个字符）" maxLength={300} /></div> : null}
      {loading && !data ? <Card><CardContent className="flex items-center gap-2 p-8 text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在加载…</CardContent></Card> : null}
      {!loading && unavailable ? <EmptyState text="该后台能力尚未启用，其他管理功能不受影响" /> : null}

      {!unavailable && kind === "settings" && data?.settings ? <SettingsPanel settings={data.settings} edits={edits} setEdits={setEdits} canConfigure={canConfigure} busy={busy} reason={reason} onSave={() => void send("PATCH", "setting.batch", { replacements: edits }).then(result => { if (result) setEdits({}); })} /> : null}
      {kind === "sources" && data?.sections ? <SourcesPanel sections={data.sections} /> : null}
      {kind === "automation" ? <AutomationPanel data={data} canExecute={canExecute} busy={busy} reason={reason} onCompensate={() => void send("POST", "automation.daily-compensation", { types: ["odds-fetch", "crown-snapshot", "analysis", "verify-learn-report"] })} /> : null}
      {kind === "strategies" ? <><Card className="border-primary/20 bg-primary/5"><CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">Strategy Lab 管理观察台</p><p className="text-sm text-muted-foreground">查看影子运行、策略矩阵、决策证据与修订链。</p></div><Button asChild variant="outline"><Link href="/admin/strategies/lab">进入策略实验室</Link></Button></CardContent></Card><StrategiesPanel items={items as StrategyItem[]} strategyName={strategyName} setStrategyName={setStrategyName} canConfigure={canConfigure} canDangerous={canDangerous} busy={busy} reason={reason} send={send} /></> : null}
      {kind === "backtests" ? <BacktestsPanel items={items as BacktestItem[]} limits={data?.limits} startDate={startDate} setStartDate={setStartDate} endDate={endDate} setEndDate={setEndDate} maxMatches={maxMatches} setMaxMatches={setMaxMatches} validation={backtestValidation} canExecute={canExecute} busy={busy} reason={reason} send={send} /> : null}
    </div>
  );
}

function SettingsPanel({ settings, edits, setEdits, canConfigure, busy, reason, onSave }: { settings: SettingItem[]; edits: Record<string, string>; setEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>; canConfigure: boolean; busy: boolean; reason: string; onSave: () => void }) {
  if (!settings.length) return <EmptyState text="当前没有可管理的运行配置" />;
  return <div className="grid gap-4 xl:grid-cols-2">{settings.map(item => <Card key={item.id}><CardHeader><div className="flex items-center justify-between gap-3"><CardTitle className="text-base">{item.label}</CardTitle><Badge variant="outline">{item.source}</Badge></div><CardDescription>{item.sensitive ? "敏感值：留空保持原值，不支持清空" : `生效：${item.effectiveAfter}`}</CardDescription></CardHeader><CardContent><Input disabled={!canConfigure} type={item.sensitive ? "password" : "text"} placeholder={item.sensitive && item.configured ? "已配置，输入新值以替换" : "输入配置值"} value={edits[item.id] ?? (item.sensitive ? "" : item.value || "")} onChange={event => setEdits(current => ({ ...current, [item.id]: event.target.value }))} /></CardContent></Card>)}{canConfigure ? <div className="xl:col-span-2"><Button disabled={busy || reason.trim().length < 3 || !Object.keys(edits).length} onClick={onSave}>{busy ? <Loader2 className="animate-spin" /> : null}保存更改</Button></div> : null}</div>;
}

function SourcesPanel({ sections }: { sections: Record<string, SourceItem> }) {
  const entries = Object.entries(sections);
  if (!entries.length) return <EmptyState text="暂未观测到数据源状态" />;
  return <div className="grid gap-4 md:grid-cols-2">{entries.map(([name, section]) => { const record = asRecord(section.data); const summary = section.status === "degraded" ? textValue(asRecord(section.error)?.message, "数据暂时不可用") : sourceSummary(name, record); return <Card key={name}><CardHeader><div className="flex justify-between gap-3"><CardTitle>{sourceLabels[name] || name}</CardTitle><Badge variant={statusVariant(section.status)}>{statusLabels[section.status] || section.status}</Badge></div><CardDescription>观测时间 {section.observedAt || "未知"}</CardDescription></CardHeader><CardContent className="space-y-3"><p className="text-sm leading-6">{summary}</p><RawDiagnostics value={section.data ?? section.error ?? {}} label="查看原始诊断数据" /></CardContent></Card>; })}</div>;
}

function sourceSummary(name: string, record: Record<string, unknown> | null): string {
  if (!record) return "连接正常，暂无更多摘要。";
  if (name === "quality") return `最近检查 ${textValue(record.latestCheckedAt, "尚无记录")}，共 ${Number(record.observations) || 0} 条观测，${Number(record.issues) || 0} 条需关注。`;
  if (name === "companies") return `默认公司 ${Array.isArray(record.defaultCompanyIds) ? record.defaultCompanyIds.join("、") : "未配置"}，当前为只读治理。`;
  if (name === "provider") return `${textValue(record.label, "外部提供方")} 已配置，模式：${textValue(record.mode, "未知")}。`;
  return `存储后端：${textValue(record.backend ?? record.type, "已连接")}；结构版本：${textValue(record.schemaVersion, "未记录")}。`;
}

function AutomationPanel({ data, canExecute, busy, reason, onCompensate }: { data: GovernanceData | null; canExecute: boolean; busy: boolean; reason: string; onCompensate: () => void }) {
  const plans = data?.plans || [];
  const tasks = data?.tasks || [];
  return <div className="space-y-4">{canExecute ? <AlertDialog><AlertDialogTrigger asChild><Button disabled={busy || reason.trim().length < 3}>{busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}执行每日任务补偿</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>执行每日任务补偿？</AlertDialogTitle><AlertDialogDescription>将补执行赔率抓取、皇冠快照、AI 分析与验证学习报表，可能产生外部请求和计算成本。服务端仍会执行幂等控制。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>取消</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={onCompensate}>确认执行补偿</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog> : null}<section className="space-y-3"><h2 className="text-base font-semibold">调度计划</h2>{plans.length ? <div className="grid gap-3 md:grid-cols-2">{plans.map((plan, index) => <RecordCard key={textValue(asRecord(plan)?.id, `plan-${index}`)} value={plan} fallbackTitle={`计划 ${index + 1}`} />)}</div> : <EmptyState text="当前没有调度计划" />}</section><section className="space-y-3"><h2 className="text-base font-semibold">最近任务</h2>{tasks.length ? <div className="grid gap-3 md:grid-cols-2">{tasks.map((task, index) => <RecordCard key={textValue(asRecord(task)?.id, `task-${index}`)} value={task} fallbackTitle={`任务 ${index + 1}`} />)}</div> : <EmptyState text="当前没有任务记录" />}</section></div>;
}

function RecordCard({ value, fallbackTitle }: { value: unknown; fallbackTitle: string }) {
  const record = asRecord(value);
  const title = textValue(record?.name ?? record?.type ?? record?.task_type ?? record?.id, fallbackTitle);
  const status = textValue(record?.status, "unknown");
  const detail = textValue(record?.schedule ?? record?.cron ?? record?.updated_at ?? record?.created_at, "暂无更多摘要");
  return <Card><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle className="text-sm">{title}</CardTitle><CardDescription className="mt-1">{detail}</CardDescription></div><Badge variant={statusVariant(status)}>{statusLabels[status] || status}</Badge></div></CardHeader><CardContent><RawDiagnostics value={value} label="查看详细数据" /></CardContent></Card>;
}

function StrategiesPanel({ items, strategyName, setStrategyName, canConfigure, canDangerous, busy, reason, send }: { items: StrategyItem[]; strategyName: string; setStrategyName: (value: string) => void; canConfigure: boolean; canDangerous: boolean; busy: boolean; reason: string; send: (method: string, targetId: string, payload: Record<string, unknown>, confirmation?: string) => Promise<unknown> }) {
  return <div className="space-y-4">{canConfigure ? <Card><CardHeader><CardTitle className="text-base">创建策略草稿</CardTitle></CardHeader><CardContent className="flex flex-col gap-2 sm:flex-row"><Input aria-label="策略名称" value={strategyName} onChange={event => setStrategyName(event.target.value)} placeholder="策略名称" /><Button disabled={busy || strategyName.trim().length < 2 || reason.trim().length < 3} onClick={() => void send("POST", "strategy.draft", { name: strategyName }).then(result => { if (result) setStrategyName(""); })}>创建</Button></CardContent></Card> : null}{items.length ? items.map(item => <Card key={item.version}><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle className="font-mono text-sm">{item.version}</CardTitle><CardDescription>{item.name} · {item.model_version}</CardDescription></div><Badge>{statusLabels[item.status] || item.status}</Badge></div></CardHeader>{canDangerous ? <CardContent className="flex flex-wrap gap-2">{item.status === "draft" ? <AlertDialog><AlertDialogTrigger asChild><Button disabled={busy || reason.trim().length < 3}>发布</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>发布策略 {item.version}？</AlertDialogTitle><AlertDialogDescription>发布后将成为新的生效策略，并影响后续分析任务。请确认已完成必要验证。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => void send("PATCH", "strategy.publish", { version: item.version }, "strategy.publish")}>确认发布</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog> : null}{item.status !== "draft" ? <AlertDialog><AlertDialogTrigger asChild><Button variant="destructive" disabled={busy || reason.trim().length < 3}>回退到此版本</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>回退到 {item.version}？</AlertDialogTitle><AlertDialogDescription>回退会替换当前生效策略，后续分析将使用该历史版本；操作会写入审计记录。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void send("PATCH", "strategy.rollback", { version: item.version }, "strategy.rollback")}>确认回退</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog> : null}</CardContent> : null}</Card>) : <EmptyState text="当前没有策略版本" />}</div>;
}

function BacktestsPanel({ items, limits, startDate, setStartDate, endDate, setEndDate, maxMatches, setMaxMatches, validation, canExecute, busy, reason, send }: { items: BacktestItem[]; limits?: GovernanceData["limits"]; startDate: string; setStartDate: (value: string) => void; endDate: string; setEndDate: (value: string) => void; maxMatches: string; setMaxMatches: (value: string) => void; validation: string; canExecute: boolean; busy: boolean; reason: string; send: (method: string, targetId: string, payload: Record<string, unknown>) => Promise<unknown> }) {
  return <div className="space-y-4">{canExecute ? <Card><CardHeader><CardTitle className="text-base">启动回测</CardTitle><CardDescription>回测遵循用户关注联赛白名单。为避免误触发高成本任务，请明确设置赛事上限。</CardDescription></CardHeader><CardContent className="grid gap-4 md:grid-cols-3"><div className="space-y-2"><Label htmlFor="backtest-start-date">开始日期</Label><Input id="backtest-start-date" type="date" value={startDate} onChange={event => setStartDate(event.target.value)} /></div><div className="space-y-2"><Label htmlFor="backtest-end-date">结束日期</Label><Input id="backtest-end-date" type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></div><div className="space-y-2"><Label htmlFor="backtest-max-matches">赛事上限</Label><Input id="backtest-max-matches" type="number" min={1} max={limits?.maxMatches} value={maxMatches} onChange={event => setMaxMatches(event.target.value)} /></div><div className="flex flex-col items-start gap-2 md:col-span-3"><Button disabled={busy || Boolean(validation) || reason.trim().length < 3} onClick={() => void send("POST", "backtest.start", { startDate: startDate.replaceAll("-", ""), endDate: endDate.replaceAll("-", ""), maxMatches: Number(maxMatches) })}>{busy ? <Loader2 className="animate-spin" /> : null}启动回测</Button>{validation ? <p className="text-xs text-muted-foreground">{validation}</p> : <p className="text-xs text-success">输入有效，可启动回测</p>}</div></CardContent></Card> : null}{items.length ? items.map(item => <Card key={item.id}><CardHeader><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><CardTitle className="font-mono text-sm">{item.id}</CardTitle><CardDescription>{item.start_date} ~ {item.end_date} · {item.processed_dates}/{item.total_dates} · {item.accuracy || "暂无准确率"}</CardDescription></div><Badge variant={statusVariant(item.status)}>{statusLabels[item.status] || item.status}</Badge></div></CardHeader><CardContent className="flex flex-wrap items-center gap-2">{canExecute && ["running", "cancelling"].includes(item.status) ? <Button variant="destructive" disabled={busy} onClick={() => void send("POST", "backtest.cancel", { jobId: item.id })}>取消</Button> : null}{canExecute && ["error", "cancelled", "timed_out"].includes(item.status) ? <Button disabled={busy} onClick={() => void send("POST", "backtest.resume", { jobId: item.id })}>继续</Button> : null}{item.last_error ? <span className="flex items-center gap-1 text-sm text-destructive"><AlertCircle className="size-4" />{item.last_error}</span> : <span className="flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="size-3.5" />状态已同步</span>}</CardContent></Card>) : <EmptyState text="当前没有回测任务" />}</div>;
}

function EmptyState({ text }: { text: string }) {
  return <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">{text}</CardContent></Card>;
}
