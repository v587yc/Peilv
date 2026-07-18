import type { LucideIcon } from "lucide-react";
import { AlertCircle, ChevronDown, Inbox, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function AdminPageHeader({ eyebrow, icon: Icon, title, description, actions }: { eyebrow: string; icon: LucideIcon; title: string; description: string; actions?: ReactNode }) {
  return <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div className="min-w-0 space-y-1.5"><p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary"><Icon aria-hidden="true" className="size-3.5" />{eyebrow}</p><h1 className="text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">{title}</h1><p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p></div>{actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}</header>;
}

export function AdminMetric({ icon: Icon, label, value, detail, tone = "primary" }: { icon: LucideIcon; label: string; value: ReactNode; detail?: string; tone?: "primary" | "success" | "warning" | "danger" }) {
  const tones = { primary: "border-primary/15 bg-primary/8 text-primary", success: "border-success/15 bg-success/8 text-success", warning: "border-warning/15 bg-warning/8 text-warning", danger: "border-destructive/15 bg-destructive/8 text-destructive" };
  return <Card className="border-white/8 bg-card/65 shadow-sm shadow-black/10"><CardContent className="flex min-h-24 items-center gap-4 p-4"><span className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg border", tones[tone])}><Icon aria-hidden="true" className="size-4.5" /></span><div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 truncate text-xl font-semibold tabular-nums tracking-tight">{value}</p>{detail ? <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p> : null}</div></CardContent></Card>;
}

const statusStyles = { healthy: "border-success/20 bg-success/8 text-success", running: "border-info/20 bg-info/8 text-info", warning: "border-warning/20 bg-warning/8 text-warning", danger: "border-destructive/20 bg-destructive/8 text-destructive", neutral: "border-white/10 bg-muted text-muted-foreground" };
export function AdminStatusBadge({ label, tone = "neutral" }: { label: string; tone?: keyof typeof statusStyles }) {
  return <Badge variant="outline" className={cn("whitespace-nowrap font-medium", statusStyles[tone])}><span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{label}</Badge>;
}

export function AdminErrorState({ title = "加载失败", message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return <Alert role="alert" variant="destructive" className="border-destructive/30 bg-destructive/8"><AlertCircle aria-hidden="true" /><AlertTitle>{title}</AlertTitle><AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"><span>{message}</span>{onRetry ? <Button type="button" size="sm" variant="outline" onClick={onRetry}>重新加载</Button> : null}</AlertDescription></Alert>;
}

export function AdminEmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-background/20 px-5 py-10 text-center"><span className="mb-4 flex size-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.035] text-muted-foreground"><Inbox aria-hidden="true" className="size-5" /></span><h2 className="font-medium">{title}</h2><p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>{action ? <div className="mt-5">{action}</div> : null}</div>;
}

export function AdminLoadingState({ label = "正在加载数据", rows = 4 }: { label?: string; rows?: number }) {
  return <div className="space-y-3 p-4" role="status" aria-label={label}><div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 aria-hidden="true" className="size-3.5 animate-spin" />{label}</div>{Array.from({ length: rows }).map((_, index) => <Skeleton key={index} className="h-14 w-full rounded-lg" />)}</div>;
}

export function RawDiagnostics({ value, label = "原始诊断" }: { value: unknown; label?: string }) {
  return <Collapsible className="rounded-lg border border-white/8 bg-black/15"><CollapsibleTrigger className="group flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><span>{label}</span><ChevronDown aria-hidden="true" className="size-4 transition-transform group-data-[state=open]:rotate-180" /></CollapsibleTrigger><CollapsibleContent><pre className="max-h-72 overflow-auto border-t border-white/8 p-3 font-mono text-[11px] leading-5 text-muted-foreground whitespace-pre-wrap break-all">{JSON.stringify(value ?? null, null, 2)}</pre></CollapsibleContent></Collapsible>;
}
