"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowRight, Bot, CheckCircle2, Clock3,
  Database, FileClock, Gauge, Loader2, RefreshCcw, Settings2, ShieldCheck,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { adminApiRequest, isAdminFeatureUnavailable } from "./admin-api-client";

type SectionStatus = "ok" | "degraded";
type OverviewSection = { status: SectionStatus; observedAt: string; data?: unknown; error?: string };
type OverviewResponse = { status?: SectionStatus; sections?: Record<string, OverviewSection>; error?: string };
type UnknownRecord = Record<string, unknown>;

const SECTION_META = {
  settings: { label: "运行配置", description: "系统参数与敏感配置", href: "/admin/settings", icon: Settings2 },
  sources: { label: "数据源", description: "存储与外部服务连接", href: "/admin/sources", icon: Database },
  automation: { label: "自动化", description: "计划任务与补偿执行", href: "/admin/automation", icon: Bot },
  strategy: { label: "分析策略", description: "当前生效策略版本", href: "/admin/strategies", icon: Gauge },
  backtests: { label: "回测任务", description: "模型回测运行状态", href: "/admin/backtests", icon: Activity },
  audit: { label: "审计链路", description: "最近管理操作记录", href: "/admin/audit", icon: FileClock },
} as const;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function numericValue(record: UnknownRecord, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatObservedAt(value?: string): string {
  if (!value) return "尚未观测";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function sectionMetric(name: string, section?: OverviewSection): { value: string; hint: string } {
  if (!section || section.status === "degraded") return { value: "需处理", hint: section?.error || "状态暂不可用" };
  const data = asRecord(section.data);
  if (name === "settings") return { value: `${numericValue(data, "configured")}/${numericValue(data, "total")}`, hint: "配置项已就绪" };
  if (name === "automation") return { value: String(numericValue(data, "active")), hint: numericValue(data, "failed") > 0 ? `${numericValue(data, "failed")} 项执行失败` : "项任务运行中" };
  if (name === "backtests") return { value: String(numericValue(data, "active")), hint: `${numericValue(data, "total")} 条任务记录` };
  if (name === "strategy") return { value: String(data.version || "未发布"), hint: String(data.name || "等待策略发布") };
  if (name === "audit") {
    const recent = Array.isArray(data.recent) ? data.recent : [];
    return { value: String(recent.length), hint: "条最近操作" };
  }
  const nestedSections = asRecord(data.sections);
  const nestedValues = Object.values(nestedSections);
  return { value: nestedValues.length ? `${nestedValues.filter(item => asRecord(item).status === "ok").length}/${nestedValues.length}` : "已连接", hint: "数据通道健康" };
}

export function OverviewView() {
  const [sections, setSections] = useState<Record<string, OverviewSection>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    setError("");
    setUnavailable(false);
    try {
      const result = await adminApiRequest<OverviewResponse>("/api/admin/overview", { cache: "no-store" }, "总览加载失败");
      setSections(result.sections || {});
    } catch (cause) {
      if (isAdminFeatureUnavailable(cause)) {
        setSections({});
        setUnavailable(true);
      } else setError(cause instanceof Error ? cause.message : "总览加载失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const knownEntries = useMemo(() => Object.entries(SECTION_META).map(([key, meta]) => ({ key, meta, section: sections[key] })), [sections]);
  const healthyCount = knownEntries.filter(entry => entry.section?.status === "ok").length;
  const issues = knownEntries.filter(entry => entry.section?.status === "degraded");
  const latestObservation = knownEntries.map(entry => entry.section?.observedAt).filter(Boolean).sort().at(-1);

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary"><ShieldCheck className="size-3.5" />Operations center</div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">控制台总览</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">聚焦运行健康、待处理异常和关键治理入口，不让原始数据干扰判断。</p>
        </div>
        <Button variant="outline" className="w-full bg-card/50 sm:w-auto" onClick={() => void load(true)} disabled={loading || refreshing}>
          <RefreshCcw className={cn("size-4", refreshing && "animate-spin")} />{refreshing ? "正在刷新" : "刷新状态"}
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive" className="border-destructive/30 bg-destructive/8">
          <AlertTriangle /><AlertTitle>总览暂时不可用</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"><span>{error}</span><Button size="sm" variant="outline" onClick={() => void load()}>重新加载</Button></AlertDescription>
        </Alert>
      ) : null}
      {!loading && unavailable ? <Alert><AlertTriangle /><AlertTitle>总览聚合暂未启用</AlertTitle><AlertDescription>可继续通过左侧导航进入各后台模块。</AlertDescription></Alert> : null}

      {loading ? <OverviewSkeleton /> : unavailable ? null : (
        <>
          <section aria-label="核心指标" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="整体健康" value={`${healthyCount}/${knownEntries.length}`} hint={issues.length ? `${issues.length} 个模块需要关注` : "所有核心模块运行正常"} icon={CheckCircle2} tone={issues.length ? "warning" : "success"} />
            <KpiCard label="运行中自动化" value={sectionMetric("automation", sections.automation).value} hint={sectionMetric("automation", sections.automation).hint} icon={Bot} />
            <KpiCard label="活跃回测" value={sectionMetric("backtests", sections.backtests).value} hint={sectionMetric("backtests", sections.backtests).hint} icon={Activity} />
            <KpiCard label="最近观测" value={formatObservedAt(latestObservation)} hint="状态数据更新时间" icon={Clock3} />
          </section>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.7fr)]">
            <Card className="border-white/8 bg-card/70 shadow-xl shadow-black/10">
              <CardHeader className="border-b border-white/7">
                <div className="flex items-center justify-between gap-3"><div><CardTitle className="text-base">系统健康</CardTitle><CardDescription className="mt-1">六个治理域独立观测，局部异常不会遮蔽其他状态。</CardDescription></div><Badge variant={issues.length ? "outline" : "secondary"} className={cn(issues.length ? "border-warning/30 text-warning" : "text-success")}>{issues.length ? "部分降级" : "运行正常"}</Badge></div>
              </CardHeader>
              <CardContent className="grid gap-2 p-3 sm:grid-cols-2">
                {knownEntries.map(({ key, meta, section }) => {
                  const Icon = meta.icon;
                  const metric = sectionMetric(key, section);
                  return <Link key={key} href={meta.href} className="group flex min-w-0 items-center gap-3 rounded-xl border border-transparent p-3 transition-all hover:border-white/8 hover:bg-white/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg border", section?.status === "ok" ? "border-success/15 bg-success/8 text-success" : "border-warning/20 bg-warning/8 text-warning")}><Icon className="size-4.5" /></span>
                    <span className="min-w-0 flex-1"><span className="flex items-center gap-2 font-medium"><span className="truncate">{meta.label}</span><span className={cn("size-1.5 rounded-full", section?.status === "ok" ? "bg-success" : "bg-warning")} /></span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{metric.hint}</span></span>
                    <span className="text-right"><span className="block max-w-24 truncate text-sm font-semibold tabular-nums">{metric.value}</span><ArrowRight className="ml-auto mt-1 size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" /></span>
                  </Link>;
                })}
              </CardContent>
            </Card>

            <Card className="border-white/8 bg-card/70 shadow-xl shadow-black/10">
              <CardHeader className="border-b border-white/7"><CardTitle className="text-base">异常与行动</CardTitle><CardDescription>优先处理会影响运营判断的模块。</CardDescription></CardHeader>
              <CardContent className="space-y-3 p-4">
                {issues.length ? issues.map(({ key, meta, section }) => (
                  <Link href={meta.href} key={key} className="group block rounded-xl border border-warning/15 bg-warning/[0.045] p-4 transition-colors hover:bg-warning/[0.075] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" /><div className="min-w-0 flex-1"><p className="font-medium">{meta.label}状态降级</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{section?.error || "暂时无法获取状态，请进入模块检查。"}</p></div><ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" /></div>
                  </Link>
                )) : (
                  <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.015] px-5 text-center"><span className="mb-4 flex size-11 items-center justify-center rounded-full bg-success/10 text-success"><CheckCircle2 className="size-5" /></span><p className="font-medium">当前没有待处理异常</p><p className="mt-1 max-w-64 text-xs leading-5 text-muted-foreground">所有治理域均已返回健康状态，可以继续常规运营。</p></div>
                )}
                <Button asChild variant="outline" className="w-full"><Link href="/admin/audit"><FileClock />查看审计日志</Link></Button>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function KpiCard({ label, value, hint, icon: Icon, tone = "primary" }: { label: string; value: string; hint: string; icon: typeof Activity; tone?: "primary" | "success" | "warning" }) {
  const toneClass = tone === "success" ? "bg-success/9 text-success border-success/15" : tone === "warning" ? "bg-warning/9 text-warning border-warning/15" : "bg-primary/9 text-primary border-primary/15";
  return <Card className="group border-white/8 bg-card/70 transition-colors hover:border-white/14"><CardContent className="p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-2 truncate text-2xl font-semibold tracking-tight tabular-nums">{value}</p></div><span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg border", toneClass)}><Icon className="size-4" /></span></div><p className="mt-3 truncate text-xs text-muted-foreground">{hint}</p></CardContent></Card>;
}

function OverviewSkeleton() {
  return <div className="space-y-4" aria-label="正在加载控制台总览"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <Card key={index} className="border-white/8"><CardContent className="space-y-3 p-5"><Skeleton className="h-3 w-20" /><Skeleton className="h-8 w-24" /><Skeleton className="h-3 w-32" /></CardContent></Card>)}</div><div className="grid gap-4 xl:grid-cols-[1.45fr_0.7fr]"><Skeleton className="h-[390px] rounded-xl" /><Skeleton className="h-[390px] rounded-xl" /></div><span className="sr-only"><Loader2 className="animate-spin" />加载中</span></div>;
}
