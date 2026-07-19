"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, LockKeyhole,
  MoreHorizontal, Plus, RefreshCcw, Search, Shield, ShieldAlert, UserCheck, UserX, Users,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ADMIN_ROLE_LABELS, type ClientAdminRole, useAdminSession } from "./admin-session-context";
import { AdminApiError, adminApiRequest } from "./admin-api-client";

type Role = ClientAdminRole;
type User = { id: string; username: string; displayName: string; role: Role; isActive: boolean; lastLoginAt: string | null; createdAt: string; updatedAt: string };
type UserResponse = { users?: User[]; user?: User; error?: string };
type RoleFilter = "all" | Role;
type StatusFilter = "all" | "active" | "inactive";
export type AdminUserMutationAction = "role" | "status" | "password";
type MutationKey = `${string}:${AdminUserMutationAction}`;

const roles: { value: Role; label: string; description: string }[] = [
  { value: "super_admin", label: "超级管理员", description: "拥有全部治理与账号管理权限" },
  { value: "operator", label: "运营管理员", description: "可配置系统并执行日常运营任务" },
  { value: "auditor", label: "只读审计员", description: "仅可查看状态、报表与审计记录" },
];

const emptyForm = { username: "", displayName: "", password: "", role: "operator" as Role };

function mutationKey(userId: string, action: AdminUserMutationAction): MutationKey {
  return `${userId}:${action}`;
}

export function buildAdminUserPatchBody(user: Pick<User, "updatedAt">, changes: Record<string, unknown>) {
  return { ...changes, expectedUpdatedAt: user.updatedAt };
}

export function applyAdminUserServerObject(users: User[], serverUser: User): User[] {
  return users.map(user => user.id === serverUser.id ? serverUser : user);
}

export function useAdminUserMutationRegistry() {
  const tokensRef = useRef(new Map<MutationKey, symbol>());
  const [activeKeys, setActiveKeys] = useState<ReadonlySet<MutationKey>>(() => new Set());

  const run = useCallback(async <T,>(userId: string, action: AdminUserMutationAction, operation: () => Promise<T>): Promise<T | undefined> => {
    const key = mutationKey(userId, action);
    const token = Symbol(key);
    tokensRef.current.set(key, token);
    setActiveKeys(current => new Set(current).add(key));
    try {
      const result = await operation();
      return tokensRef.current.get(key) === token ? result : undefined;
    } finally {
      if (tokensRef.current.get(key) === token) {
        tokensRef.current.delete(key);
        setActiveKeys(current => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  }, []);

  const isActive = useCallback((userId: string, action?: AdminUserMutationAction) => {
    if (action) return activeKeys.has(mutationKey(userId, action));
    return (["role", "status", "password"] as const).some(candidate => activeKeys.has(mutationKey(userId, candidate)));
  }, [activeKeys]);

  return { run, isActive };
}

function formatLastLogin(value: string | null): string {
  if (!value) return "尚未登录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function initials(user: User): string {
  return (user.displayName || user.username).trim().slice(0, 2).toUpperCase();
}

export function AdminUsersView() {
  const { loading: sessionLoading, user: currentUser, hasCapability } = useAdminSession();
  const canManage = hasCapability("admin:manage");
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [showCreatePassword, setShowCreatePassword] = useState(false);
  const [confirmUser, setConfirmUser] = useState<User | null>(null);
  const [passwordUser, setPasswordUser] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [showResetPassword, setShowResetPassword] = useState(false);
  const mutationRegistry = useAdminUserMutationRegistry();
  const loadRequestIdRef = useRef(0);
  const mutationRevisionRef = useRef(0);

  const load = useCallback(async (background = false) => {
    const requestId = ++loadRequestIdRef.current;
    const mutationRevision = mutationRevisionRef.current;
    if (background) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const result = await adminApiRequest<UserResponse>("/api/admin/users", { cache: "no-store" }, "管理员列表加载失败");
      if (requestId === loadRequestIdRef.current && mutationRevision === mutationRevisionRef.current) {
        setUsers(Array.isArray(result.users) ? result.users : []);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "管理员列表加载失败");
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!sessionLoading && canManage) void load();
    if (!sessionLoading && !canManage) setLoading(false);
  }, [canManage, load, sessionLoading]);

  const filteredUsers = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    return users.filter(user => {
      const matchesQuery = !keyword || user.username.toLocaleLowerCase("zh-CN").includes(keyword) || user.displayName.toLocaleLowerCase("zh-CN").includes(keyword);
      const matchesRole = roleFilter === "all" || user.role === roleFilter;
      const matchesStatus = statusFilter === "all" || (statusFilter === "active" ? user.isActive : !user.isActive);
      return matchesQuery && matchesRole && matchesStatus;
    });
  }, [query, roleFilter, statusFilter, users]);

  const activeCount = users.filter(user => user.isActive).length;
  const superAdminCount = users.filter(user => user.role === "super_admin" && user.isActive).length;
  const filtersActive = Boolean(query || roleFilter !== "all" || statusFilter !== "all");

  async function create(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError("");
    try {
      const result = await adminApiRequest<UserResponse>("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, username: form.username.trim(), displayName: form.displayName.trim() }),
      }, "创建管理员失败");
      setForm(emptyForm);
      setCreateOpen(false);
      toast.success("管理员已创建", { description: `${result.user?.displayName || form.displayName || form.username} 现在可以使用新账号登录。` });
      await load(true);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "创建管理员失败";
      setError(message);
      toast.error("创建失败", { description: message });
    } finally {
      setCreating(false);
    }
  }

  async function update(user: User, action: "role" | "status" | "password", changes: Record<string, unknown>) {
    mutationRevisionRef.current += 1;
    setError("");
    try {
      const result = await mutationRegistry.run(user.id, action, async () => {
        try {
          return await adminApiRequest<UserResponse>(`/api/admin/users/${user.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildAdminUserPatchBody(user, changes)),
          }, "管理员更新失败");
        } catch (cause) {
          if (cause instanceof AdminApiError && cause.status === 409) {
            const payload = cause.data as UserResponse;
            if (payload.user) return { ...payload, conflict: true };
          }
          throw cause;
        }
      });
      if (!result) return;
      mutationRevisionRef.current += 1;
      if (result.user) setUsers(current => applyAdminUserServerObject(current, result.user as User));
      if ("conflict" in result) {
        const message = "该管理员已被其他操作更新，已加载最新状态，请重新操作";
        setError(message);
        toast.error("数据已变化", { description: message });
        if (action === "password") { setPasswordUser(null); setNewPassword(""); }
        if (action === "status") setConfirmUser(null);
        return;
      }
      const successMessage = action === "password" ? "密码已重置" : action === "status" ? (changes.isActive ? "账号已启用" : "账号已停用") : "角色已更新";
      toast.success(successMessage, { description: action === "password" || changes.isActive === false ? "该账号现有会话已按安全策略撤销。" : `${user.displayName || user.username} 的设置已生效。` });
      if (action === "password") { setPasswordUser(null); setNewPassword(""); }
      if (action === "status") setConfirmUser(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "管理员更新失败";
      setError(message);
      toast.error("更新失败", { description: message });
    }
  }

  function clearFilters() {
    setQuery("");
    setRoleFilter("all");
    setStatusFilter("all");
  }

  if (sessionLoading) return <AdminUsersSkeleton />;

  if (!canManage) {
    return <NoAccessState role={currentUser?.role} />;
  }

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary"><Users className="size-3.5" />Access control</div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">管理员账号</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">创建与维护后台账号。系统不物理删除管理员；停用即移除访问权，账号身份、审计与预测治理追踪永久保留，并可随时重新启用。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" onClick={() => void load(true)} disabled={loading || refreshing} aria-label="刷新管理员列表" className="bg-card/50"><RefreshCcw className={cn("size-4", refreshing && "animate-spin")} /></Button>
          <Button onClick={() => setCreateOpen(true)}><Plus />添加管理员</Button>
        </div>
      </div>

      {error ? <Alert variant="destructive" className="border-destructive/30 bg-destructive/8"><AlertCircle /><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}

      <section className="grid gap-3 sm:grid-cols-3" aria-label="管理员指标">
        <Metric icon={Users} label="管理员总数" value={String(users.length)} />
        <Metric icon={UserCheck} label="已启用账号" value={String(activeCount)} tone="success" />
        <Metric icon={Shield} label="活跃超级管理员" value={String(superAdminCount)} />
      </section>

      <Card className="overflow-hidden border-white/8 bg-card/70 shadow-xl shadow-black/10">
        <CardHeader className="gap-4 border-b border-white/7 p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
          <div><CardTitle className="text-base">账号目录</CardTitle><CardDescription className="mt-1">共 {users.length} 个账号，当前显示 {filteredUsers.length} 个</CardDescription></div>
          <div className="grid w-full gap-2 sm:grid-cols-[minmax(220px,1fr)_160px_140px] lg:max-w-2xl">
            <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索姓名或账号" className="h-10 bg-background/45 pl-9" aria-label="搜索管理员" /></div>
            <Select value={roleFilter} onValueChange={value => setRoleFilter(value as RoleFilter)}><SelectTrigger className="h-10 w-full bg-background/45" aria-label="按角色筛选"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部角色</SelectItem>{roles.map(role => <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>)}</SelectContent></Select>
            <Select value={statusFilter} onValueChange={value => setStatusFilter(value as StatusFilter)}><SelectTrigger className="h-10 w-full bg-background/45" aria-label="按状态筛选"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="active">已启用</SelectItem><SelectItem value="inactive">已停用</SelectItem></SelectContent></Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? <AdminUsersSkeleton compact /> : filteredUsers.length ? (
            <>
              <div className="hidden md:block"><AdminTable users={filteredUsers} currentUserId={currentUser?.id} isBusy={mutationRegistry.isActive} onRoleChange={(user, role) => void update(user, "role", { role })} onToggle={setConfirmUser} onPassword={setPasswordUser} /></div>
              <div className="divide-y divide-white/7 md:hidden">{filteredUsers.map(user => <AdminMobileCard key={user.id} user={user} currentUserId={currentUser?.id} busy={mutationRegistry.isActive(user.id)} onRoleChange={(role) => void update(user, "role", { role })} onToggle={() => setConfirmUser(user)} onPassword={() => setPasswordUser(user)} />)}</div>
            </>
          ) : (
            <Empty className="min-h-80 border-0"><EmptyHeader><EmptyMedia variant="icon">{filtersActive ? <Search /> : <Users />}</EmptyMedia><EmptyTitle>{filtersActive ? "没有匹配的管理员" : "暂无管理员账号"}</EmptyTitle><EmptyDescription>{filtersActive ? "尝试调整搜索关键词、角色或状态筛选。" : "创建第一个管理员后即可在这里维护访问权限。"}</EmptyDescription></EmptyHeader>{filtersActive ? <EmptyContent><Button variant="outline" onClick={clearFilters}>清除筛选</Button></EmptyContent> : null}</Empty>
          )}
        </CardContent>
      </Card>

      <CreateAdminDialog open={createOpen} onOpenChange={open => { if (!creating) setCreateOpen(open); }} form={form} setForm={setForm} showPassword={showCreatePassword} setShowPassword={setShowCreatePassword} creating={creating} onSubmit={create} />
      <PasswordDialog user={passwordUser} onOpenChange={open => { if (!open && (!passwordUser || !mutationRegistry.isActive(passwordUser.id, "password"))) { setPasswordUser(null); setNewPassword(""); } }} password={newPassword} setPassword={setNewPassword} showPassword={showResetPassword} setShowPassword={setShowResetPassword} busy={Boolean(passwordUser && mutationRegistry.isActive(passwordUser.id, "password"))} onSubmit={() => passwordUser && void update(passwordUser, "password", { password: newPassword })} />
      <StatusConfirmDialog user={confirmUser} busy={Boolean(confirmUser && mutationRegistry.isActive(confirmUser.id, "status"))} onCancel={() => setConfirmUser(null)} onConfirm={() => confirmUser && void update(confirmUser, "status", { isActive: !confirmUser.isActive })} />
    </div>
  );
}

function Metric({ icon: Icon, label, value, tone = "primary" }: { icon: typeof Users; label: string; value: string; tone?: "primary" | "success" }) {
  return <Card className="border-white/8 bg-card/65"><CardContent className="flex items-center gap-4 p-4"><span className={cn("flex size-10 items-center justify-center rounded-lg border", tone === "success" ? "border-success/15 bg-success/8 text-success" : "border-primary/15 bg-primary/8 text-primary")}><Icon className="size-4.5" /></span><div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-0.5 text-xl font-semibold tabular-nums">{value}</p></div></CardContent></Card>;
}

function RoleSelect({ user, disabled, onChange }: { user: User; disabled: boolean; onChange: (role: Role) => void }) {
  return <Select value={user.role} disabled={disabled} onValueChange={value => onChange(value as Role)}><SelectTrigger className="h-9 w-full min-w-36 bg-background/35 md:w-40" aria-label={`${user.username}角色`}>{disabled ? <Loader2 className="size-3.5 animate-spin" /> : null}<SelectValue /></SelectTrigger><SelectContent>{roles.map(role => <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>)}</SelectContent></Select>;
}

function AdminTable({ users, currentUserId, isBusy, onRoleChange, onToggle, onPassword }: { users: User[]; currentUserId?: string; isBusy: (userId: string, action?: AdminUserMutationAction) => boolean; onRoleChange: (user: User, role: Role) => void; onToggle: (user: User) => void; onPassword: (user: User) => void }) {
  return <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead className="h-11 pl-5">管理员</TableHead><TableHead>角色</TableHead><TableHead>状态</TableHead><TableHead>最近登录</TableHead><TableHead className="pr-5 text-right">操作</TableHead></TableRow></TableHeader><TableBody>{users.map(user => { const busy = isBusy(user.id); return <TableRow key={user.id} className={cn(!user.isActive && "opacity-65")}><TableCell className="pl-5"><div className="flex items-center gap-3"><Avatar className="size-9 border border-white/8"><AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{initials(user)}</AvatarFallback></Avatar><div className="min-w-0"><div className="flex items-center gap-2"><p className="max-w-52 truncate font-medium">{user.displayName || user.username}</p>{user.id === currentUserId ? <Badge variant="secondary" className="text-[10px]">当前账号</Badge> : null}</div><p className="mt-0.5 max-w-56 truncate text-xs text-muted-foreground">@{user.username}</p></div></div></TableCell><TableCell><RoleSelect user={user} disabled={busy} onChange={role => onRoleChange(user, role)} /></TableCell><TableCell><Badge variant="outline" className={user.isActive ? "border-success/20 bg-success/8 text-success" : "border-white/10 bg-muted text-muted-foreground"}>{user.isActive ? <CheckCircle2 /> : <UserX />}{user.isActive ? "已启用" : "已停用"}</Badge></TableCell><TableCell className="text-sm text-muted-foreground">{formatLastLogin(user.lastLoginAt)}</TableCell><TableCell className="pr-5 text-right"><RowMenu user={user} busy={busy} onToggle={() => onToggle(user)} onPassword={() => onPassword(user)} /></TableCell></TableRow>; })}</TableBody></Table>;
}

function AdminMobileCard({ user, currentUserId, busy, onRoleChange, onToggle, onPassword }: { user: User; currentUserId?: string; busy: boolean; onRoleChange: (role: Role) => void; onToggle: () => void; onPassword: () => void }) {
  return <article className={cn("space-y-4 p-4", !user.isActive && "opacity-65")}><div className="flex items-start gap-3"><Avatar className="size-10 border border-white/8"><AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{initials(user)}</AvatarFallback></Avatar><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="truncate font-medium">{user.displayName || user.username}</h2>{user.id === currentUserId ? <Badge variant="secondary" className="text-[10px]">当前</Badge> : null}</div><p className="mt-0.5 truncate text-xs text-muted-foreground">@{user.username} · {formatLastLogin(user.lastLoginAt)}</p></div><RowMenu user={user} busy={busy} onToggle={onToggle} onPassword={onPassword} /></div><div className="grid grid-cols-[1fr_auto] items-center gap-3"><RoleSelect user={user} disabled={busy} onChange={onRoleChange} /><Badge variant="outline" className={user.isActive ? "border-success/20 bg-success/8 text-success" : "border-white/10 bg-muted text-muted-foreground"}>{user.isActive ? "已启用" : "已停用"}</Badge></div></article>;
}

function RowMenu({ user, busy, onToggle, onPassword }: { user: User; busy: boolean; onToggle: () => void; onPassword: () => void }) {
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" disabled={busy} aria-label={`管理 ${user.username}`}>{busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}</Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-44"><DropdownMenuItem onSelect={onPassword}><KeyRound />重置密码</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={onToggle} className={user.isActive ? "text-destructive focus:text-destructive" : "text-success focus:text-success"}>{user.isActive ? <UserX /> : <UserCheck />}{user.isActive ? "停用账号" : "启用账号"}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
}

function CreateAdminDialog({ open, onOpenChange, form, setForm, showPassword, setShowPassword, creating, onSubmit }: { open: boolean; onOpenChange: (open: boolean) => void; form: typeof emptyForm; setForm: React.Dispatch<React.SetStateAction<typeof emptyForm>>; showPassword: boolean; setShowPassword: (value: boolean) => void; creating: boolean; onSubmit: (event: FormEvent) => void }) {
  const selectedRole = roles.find(role => role.value === form.role);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto border-white/10 bg-card p-0 sm:max-w-xl"><DialogHeader className="border-b border-white/7 p-5 pr-12"><DialogTitle>添加管理员</DialogTitle><DialogDescription>创建独立登录账号并分配初始角色。后续变更会进入审计日志。</DialogDescription></DialogHeader><form onSubmit={onSubmit}><div className="grid gap-5 p-5 sm:grid-cols-2"><Field label="管理员账号" htmlFor="new-admin-username" hint="3-64 位字母、数字、点、下划线或短横线"><Input id="new-admin-username" autoComplete="username" value={form.username} onChange={event => setForm(current => ({ ...current, username: event.target.value }))} required minLength={3} disabled={creating} placeholder="例如 ops.wang" /></Field><Field label="显示名称" htmlFor="new-admin-display-name" hint="显示在审计记录与管理列表"><Input id="new-admin-display-name" value={form.displayName} onChange={event => setForm(current => ({ ...current, displayName: event.target.value }))} disabled={creating} placeholder="例如 王小明" /></Field><div className="space-y-2 sm:col-span-2"><Label htmlFor="new-admin-role">初始角色</Label><Select value={form.role} onValueChange={value => setForm(current => ({ ...current, role: value as Role }))} disabled={creating}><SelectTrigger id="new-admin-role" className="h-11 w-full"><SelectValue /></SelectTrigger><SelectContent>{roles.map(role => <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>)}</SelectContent></Select><p className="text-xs leading-5 text-muted-foreground">{selectedRole?.description}</p></div><div className="space-y-2 sm:col-span-2"><Label htmlFor="new-admin-password">初始密码</Label><div className="relative"><Input id="new-admin-password" type={showPassword ? "text" : "password"} autoComplete="new-password" minLength={12} value={form.password} onChange={event => setForm(current => ({ ...current, password: event.target.value }))} required disabled={creating} className="h-11 pr-11" placeholder="至少 12 位，包含字母和数字" /><Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1 size-9 text-muted-foreground" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "隐藏初始密码" : "显示初始密码"}>{showPassword ? <EyeOff /> : <Eye />}</Button></div><p className="text-xs leading-5 text-muted-foreground">请通过安全渠道发送初始密码，首次登录后建议立即重置。</p></div></div><DialogFooter className="border-t border-white/7 bg-background/25 p-4"><Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={creating}>取消</Button><Button type="submit" disabled={creating || form.username.trim().length < 3 || form.password.length < 12}>{creating ? <Loader2 className="animate-spin" /> : <Plus />}{creating ? "正在创建…" : "创建管理员"}</Button></DialogFooter></form></DialogContent></Dialog>;
}

function PasswordDialog({ user, onOpenChange, password, setPassword, showPassword, setShowPassword, busy, onSubmit }: { user: User | null; onOpenChange: (open: boolean) => void; password: string; setPassword: (value: string) => void; showPassword: boolean; setShowPassword: (value: boolean) => void; busy: boolean; onSubmit: () => void }) {
  return <Dialog open={Boolean(user)} onOpenChange={onOpenChange}><DialogContent className="border-white/10 bg-card sm:max-w-md"><DialogHeader><span className="mb-2 flex size-10 items-center justify-center rounded-lg border border-warning/20 bg-warning/8 text-warning"><KeyRound className="size-4.5" /></span><DialogTitle>重置管理员密码</DialogTitle><DialogDescription>为 <strong className="text-foreground">{user?.displayName || user?.username}</strong> 设置新密码。保存后该账号现有会话会被撤销。</DialogDescription></DialogHeader><div className="space-y-2 py-2"><Label htmlFor="reset-admin-password">新密码</Label><div className="relative"><Input id="reset-admin-password" type={showPassword ? "text" : "password"} autoComplete="new-password" minLength={12} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} className="h-11 pr-11" placeholder="至少 12 位，包含字母和数字" /><Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1 size-9 text-muted-foreground" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "隐藏新密码" : "显示新密码"}>{showPassword ? <EyeOff /> : <Eye />}</Button></div></div><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button><Button onClick={onSubmit} disabled={busy || password.length < 12}>{busy ? <Loader2 className="animate-spin" /> : <LockKeyhole />}{busy ? "正在重置…" : "确认重置"}</Button></DialogFooter></DialogContent></Dialog>;
}

function StatusConfirmDialog({ user, busy, onCancel, onConfirm }: { user: User | null; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const disabling = user?.isActive === true;
  return <AlertDialog open={Boolean(user)} onOpenChange={open => { if (!open && !busy) onCancel(); }}><AlertDialogContent className="border-white/10 bg-card"><AlertDialogHeader><span className={cn("mx-auto mb-2 flex size-11 items-center justify-center rounded-full sm:mx-0", disabling ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success")}>{disabling ? <ShieldAlert className="size-5" /> : <UserCheck className="size-5" />}</span><AlertDialogTitle>{disabling ? "确认停用管理员？" : "确认重新启用管理员？"}</AlertDialogTitle><AlertDialogDescription>{disabling ? `停用 ${user?.displayName || user?.username} 后，该账号将无法登录，现有会话会立即失效；账号不会物理删除，历史审计与治理追踪会永久保留。` : `重新启用 ${user?.displayName || user?.username} 后，该账号可按当前角色登录控制台，原有审计记录保持不变。`}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>取消</AlertDialogCancel><AlertDialogAction onClick={event => { event.preventDefault(); onConfirm(); }} disabled={busy} className={disabling ? "bg-destructive text-white hover:bg-destructive/90" : "bg-success text-white hover:bg-success/90"}>{busy ? <Loader2 className="animate-spin" /> : disabling ? <UserX /> : <UserCheck />}{busy ? "正在处理…" : disabling ? "确认停用" : "确认重新启用"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label htmlFor={htmlFor}>{label}</Label>{children}<p className="text-xs leading-5 text-muted-foreground">{hint}</p></div>;
}

function NoAccessState({ role }: { role?: Role }) {
  return <div className="mx-auto flex min-h-[calc(100dvh-10rem)] max-w-xl items-center"><Card className="w-full border-white/8 bg-card/70 shadow-xl shadow-black/10"><CardContent className="flex flex-col items-center px-6 py-12 text-center"><span className="mb-5 flex size-12 items-center justify-center rounded-full border border-warning/20 bg-warning/8 text-warning"><ShieldAlert className="size-5" /></span><h1 className="text-xl font-semibold">需要账号管理权限</h1><p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">当前会话角色为“{role ? ADMIN_ROLE_LABELS[role] : "未知角色"}”，不能查看或修改管理员账号。页面入口会从侧栏隐藏，服务端仍会独立校验每一次请求。</p><Button asChild className="mt-6" variant="outline"><a href="/admin">返回控制台总览</a></Button></CardContent></Card></div>;
}

function AdminUsersSkeleton({ compact = false }: { compact?: boolean }) {
  return <div className={cn("space-y-4", compact ? "p-4" : "pb-8")} aria-label="正在加载管理员账号">{!compact ? <><div className="space-y-2"><Skeleton className="h-4 w-28" /><Skeleton className="h-9 w-52" /><Skeleton className="h-4 w-96 max-w-full" /></div><div className="grid gap-3 sm:grid-cols-3">{Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-20 rounded-xl" />)}</div></> : null}<Skeleton className={cn("rounded-xl", compact ? "h-80" : "h-[430px]")} /><span className="sr-only"><Loader2 className="animate-spin" />加载中</span></div>;
}
