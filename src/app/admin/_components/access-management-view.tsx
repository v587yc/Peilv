"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle, CheckCircle2, KeyRound, Loader2, LockKeyhole, Mail,
  Plus, RefreshCcw, Search, Shield, UserCog, Users,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ADMIN_ROLE_LABELS, useAdminSession } from "./admin-session-context";
import { AdminApiError, adminApiRequest } from "./admin-api-client";

type ViewKind = "admins" | "roles";
type AdminStatus = "active" | "disabled" | "invited";
type AdminAccount = { id: string; name: string; username: string; email?: string; roleIds: string[]; roleNames?: string[]; status: AdminStatus; lastActiveAt?: string | null };
type RoleDefinition = { id: string; name: string; description?: string; capabilities: string[]; memberCount: number; system?: boolean };
type AccessResponse = { items?: unknown[]; admins?: unknown[]; roles?: unknown[]; error?: string };
type LoadState = "loading" | "ready" | "unavailable" | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseAdmin(value: unknown): AdminAccount | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const status = value.status === "disabled" || value.status === "invited" ? value.status : "active";
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : typeof value.username === "string" ? value.username : "未命名管理员",
    username: typeof value.username === "string" ? value.username : "—",
    email: typeof value.email === "string" ? value.email : undefined,
    roleIds: strings(value.roleIds),
    roleNames: strings(value.roleNames),
    status,
    lastActiveAt: typeof value.lastActiveAt === "string" ? value.lastActiveAt : null,
  };
}

function parseRole(value: unknown): RoleDefinition | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : "未命名角色",
    description: typeof value.description === "string" ? value.description : undefined,
    capabilities: strings(value.capabilities),
    memberCount: typeof value.memberCount === "number" ? value.memberCount : 0,
    system: value.system === true,
  };
}

function formatTime(value?: string | null): string {
  if (!value) return "从未登录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

const STATUS_META: Record<AdminStatus, { label: string; className: string }> = {
  active: { label: "已启用", className: "border-success/20 bg-success/8 text-success" },
  invited: { label: "待激活", className: "border-warning/20 bg-warning/8 text-warning" },
  disabled: { label: "已停用", className: "border-white/10 bg-muted text-muted-foreground" },
};

export function AccessManagementView({ kind }: { kind: ViewKind }) {
  const { loading: sessionLoading, user, hasCapability } = useAdminSession();
  const canManage = hasCapability("admin:manage");
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<(AdminAccount | RoleDefinition)[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true); else setState("loading");
    setError("");
    try {
      const payload = await adminApiRequest<AccessResponse>(`/api/admin/${kind}`, { cache: "no-store" }, "访问控制数据加载失败");
      const source = kind === "admins" ? payload.admins || payload.items || [] : payload.roles || payload.items || [];
      const parsed: (AdminAccount | RoleDefinition)[] = kind === "admins"
        ? source.map(parseAdmin).filter((item): item is AdminAccount => item !== null)
        : source.map(parseRole).filter((item): item is RoleDefinition => item !== null);
      setItems(parsed);
      setState("ready");
    } catch (cause) {
      if (cause instanceof AdminApiError && (cause.status === 404 || cause.status === 501)) {
        setItems([]);
        setState("unavailable");
        return;
      }
      setError(cause instanceof Error ? cause.message : "访问控制数据加载失败");
      setState("error");
    } finally {
      setRefreshing(false);
    }
  }, [kind]);

  useEffect(() => {
    if (!sessionLoading && canManage) void load();
    if (!sessionLoading && !canManage) setState("ready");
  }, [canManage, load, sessionLoading]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    if (!keyword) return items;
    return items.filter(item => {
      if ("username" in item) return [item.name, item.username, item.email, ...(item.roleNames || [])].some(value => value?.toLocaleLowerCase("zh-CN").includes(keyword));
      return [item.name, item.description, ...item.capabilities].some(value => value?.toLocaleLowerCase("zh-CN").includes(keyword));
    });
  }, [items, query]);

  const isAdmins = kind === "admins";
  const canMutate = state === "ready";
  const activeAdmins = isAdmins ? (items as AdminAccount[]).filter(item => item.status === "active").length : 0;
  const capabilityCount = !isAdmins ? new Set((items as RoleDefinition[]).flatMap(item => item.capabilities)).size : 0;

  if (sessionLoading) {
    return <div className="space-y-4" aria-label="正在确认访问权限"><Skeleton className="h-9 w-52" /><Skeleton className="h-20 w-full rounded-xl" /><Skeleton className="h-96 w-full rounded-xl" /></div>;
  }

  if (!canManage) {
    return <div className="mx-auto flex min-h-[calc(100dvh-10rem)] max-w-xl items-center"><Card className="w-full border-white/8 bg-card/70 shadow-xl shadow-black/10"><CardContent className="flex flex-col items-center px-6 py-12 text-center"><span className="mb-5 flex size-12 items-center justify-center rounded-full border border-warning/20 bg-warning/8 text-warning"><Shield className="size-5" /></span><h1 className="text-xl font-semibold">需要角色管理权限</h1><p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">当前会话角色为“{user ? ADMIN_ROLE_LABELS[user.role] : "未知角色"}”，不能查看或配置角色。侧栏隐藏仅用于减少干扰，服务端接口仍会独立执行权限校验。</p><Button asChild className="mt-6" variant="outline"><a href="/admin">返回控制台总览</a></Button></CardContent></Card></div>;
  }

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary">{isAdmins ? <Users className="size-3.5" /> : <Shield className="size-3.5" />}Access control</div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{isAdmins ? "管理员管理" : "角色与权限"}</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{isAdmins ? "维护后台访问账号、角色归属与启停状态。" : "以角色集中分配能力，避免逐账号维护权限。"}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={() => void load(true)} disabled={state === "loading" || refreshing} aria-label="刷新列表" className="bg-card/50"><RefreshCcw className={cn("size-4", refreshing && "animate-spin")} /></Button>
          <Button disabled={!canMutate} title={!canMutate ? "认证接口接入后可用" : undefined}><Plus />{isAdmins ? "添加管理员" : "新建角色"}</Button>
        </div>
      </div>

      {state === "unavailable" ? (
        <Alert className="border-info/20 bg-info/[0.055] text-foreground"><KeyRound className="text-info" /><AlertTitle>账号与角色接口待接入</AlertTitle><AlertDescription>页面已按预期契约完成适配；当前主线仍使用单管理员令牌认证，因此写操作已安全禁用，不会产生虚假数据。</AlertDescription></Alert>
      ) : null}
      {state === "error" ? (
        <Alert variant="destructive" className="border-destructive/30 bg-destructive/8"><AlertCircle /><AlertTitle>加载失败</AlertTitle><AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"><span>{error}</span><Button size="sm" variant="outline" onClick={() => void load()}>重新加载</Button></AlertDescription></Alert>
      ) : null}

      <section aria-label="访问控制指标" className="grid gap-3 sm:grid-cols-3">
        <MiniMetric icon={isAdmins ? Users : Shield} label={isAdmins ? "管理员总数" : "角色总数"} value={state === "ready" ? String(items.length) : "—"} />
        <MiniMetric icon={isAdmins ? CheckCircle2 : KeyRound} label={isAdmins ? "已启用账号" : "已覆盖权限"} value={state === "ready" ? String(isAdmins ? activeAdmins : capabilityCount) : "—"} tone="success" />
        <MiniMetric icon={LockKeyhole} label="权限模型" value={state === "ready" ? "RBAC" : "待接入"} />
      </section>

      <Card className="overflow-hidden border-white/8 bg-card/70 shadow-xl shadow-black/10">
        <CardHeader className="gap-4 border-b border-white/7 sm:flex-row sm:items-center sm:justify-between">
          <div><CardTitle className="text-base">{isAdmins ? "管理员列表" : "角色列表"}</CardTitle><CardDescription className="mt-1">{state === "ready" ? `共 ${items.length} 项，显示 ${filtered.length} 项` : "等待访问控制服务返回数据"}</CardDescription></div>
          <div className="relative w-full sm:w-72"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder={isAdmins ? "搜索姓名、账号或角色" : "搜索角色或权限"} className="bg-background/45 pl-9" disabled={state !== "ready"} aria-label="搜索列表" /></div>
        </CardHeader>
        <CardContent className="p-0">
          {state === "loading" ? <TableSkeleton /> : null}
          {state === "ready" && filtered.length ? (isAdmins ? <AdminTable items={filtered as AdminAccount[]} /> : <RoleTable items={filtered as RoleDefinition[]} />) : null}
          {state !== "loading" && (!filtered.length || state !== "ready") ? (
            <Empty className="min-h-80 border-0">
              <EmptyHeader><EmptyMedia variant="icon">{state === "unavailable" ? <KeyRound /> : query ? <Search /> : isAdmins ? <Users /> : <Shield />}</EmptyMedia><EmptyTitle>{state === "unavailable" ? "等待认证服务接入" : query ? "没有匹配结果" : isAdmins ? "暂无管理员" : "暂无角色"}</EmptyTitle><EmptyDescription>{state === "unavailable" ? "接口接入后，此处将自动展示真实账号与角色数据。" : query ? "尝试缩短关键词或清除筛选条件。" : "创建第一项后即可在这里进行管理。"}</EmptyDescription></EmptyHeader>
              {query && state === "ready" ? <EmptyContent><Button variant="outline" onClick={() => setQuery("")}>清除搜索</Button></EmptyContent> : null}
            </Empty>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function MiniMetric({ icon: Icon, label, value, tone = "primary" }: { icon: typeof Users; label: string; value: string; tone?: "primary" | "success" }) {
  return <Card className="border-white/8 bg-card/65"><CardContent className="flex items-center gap-4 p-4"><span className={cn("flex size-10 items-center justify-center rounded-lg border", tone === "success" ? "border-success/15 bg-success/8 text-success" : "border-primary/15 bg-primary/8 text-primary")}><Icon className="size-4.5" /></span><div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-0.5 text-xl font-semibold tabular-nums">{value}</p></div></CardContent></Card>;
}

function AdminTable({ items }: { items: AdminAccount[] }) {
  return <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead className="h-11 pl-5">管理员</TableHead><TableHead>角色</TableHead><TableHead>状态</TableHead><TableHead>最近活跃</TableHead><TableHead className="pr-5 text-right">操作</TableHead></TableRow></TableHeader><TableBody>{items.map(item => { const status = STATUS_META[item.status]; return <TableRow key={item.id} className="group"><TableCell className="pl-5"><div className="flex items-center gap-3"><Avatar className="size-9 border border-white/8"><AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{item.name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar><div><p className="font-medium">{item.name}</p><p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">{item.email ? <Mail className="size-3" /> : null}{item.email || item.username}</p></div></div></TableCell><TableCell><div className="flex flex-wrap gap-1.5">{(item.roleNames?.length ? item.roleNames : item.roleIds).map(role => <Badge key={role} variant="outline" className="font-normal">{role}</Badge>)}</div></TableCell><TableCell><Badge variant="outline" className={status.className}>{status.label}</Badge></TableCell><TableCell className="text-muted-foreground">{formatTime(item.lastActiveAt)}</TableCell><TableCell className="pr-5 text-right"><Button size="sm" variant="ghost"><UserCog />管理</Button></TableCell></TableRow>; })}</TableBody></Table>;
}

function RoleTable({ items }: { items: RoleDefinition[] }) {
  return <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead className="h-11 pl-5">角色</TableHead><TableHead>权限范围</TableHead><TableHead>成员</TableHead><TableHead className="pr-5 text-right">操作</TableHead></TableRow></TableHeader><TableBody>{items.map(item => <TableRow key={item.id}><TableCell className="pl-5"><div className="flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-lg border border-primary/15 bg-primary/8 text-primary"><Shield className="size-4" /></span><div><div className="flex items-center gap-2"><p className="font-medium">{item.name}</p>{item.system ? <Badge variant="secondary" className="text-[10px]">系统</Badge> : null}</div><p className="mt-0.5 max-w-80 truncate text-xs text-muted-foreground">{item.description || "暂无角色说明"}</p></div></div></TableCell><TableCell><div className="flex max-w-md flex-wrap gap-1.5">{item.capabilities.slice(0, 3).map(capability => <Badge key={capability} variant="outline" className="font-mono text-[10px] font-normal">{capability}</Badge>)}{item.capabilities.length > 3 ? <Badge variant="secondary" className="text-[10px]">+{item.capabilities.length - 3}</Badge> : null}</div></TableCell><TableCell className="tabular-nums text-muted-foreground">{item.memberCount} 人</TableCell><TableCell className="pr-5 text-right"><Button size="sm" variant="ghost" disabled={item.system}><UserCog />{item.system ? "受保护" : "编辑"}</Button></TableCell></TableRow>)}</TableBody></Table>;
}

function TableSkeleton() {
  return <div className="space-y-1 p-4" aria-label="正在加载访问控制数据">{Array.from({ length: 5 }).map((_, index) => <div key={index} className="flex items-center gap-4 rounded-lg px-1 py-3"><Skeleton className="size-9 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-3 w-32" /><Skeleton className="h-2.5 w-48" /></div><Skeleton className="hidden h-6 w-20 sm:block" /><Skeleton className="h-8 w-16" /></div>)}<span className="sr-only"><Loader2 className="animate-spin" />加载中</span></div>;
}
