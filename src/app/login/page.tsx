"use client";

import { FormEvent, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, ArrowRight, ChevronDown, Eye, EyeOff, Info, Loader2, LockKeyhole, RefreshCw, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createAdminSession, readAdminSession } from "./auth-client";

function LoginForm() {
  const { replace, refresh } = useRouter();
  const searchParams = useSearchParams();
  const requestedNext = searchParams.get("next");
  const destination = requestedNext && /^\/admin(?:\/|\?|$)/.test(requestedNext) ? requestedNext : "/admin";
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [error, setError] = useState("");

  const checkSession = useCallback(async (signal?: AbortSignal) => {
    setCheckingSession(true);
    setError("");
    try {
      const session = await readAdminSession(signal);
      setInitialized(session.initialized !== false);
      if (session.authenticated) replace(destination);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "管理员会话服务暂时不可用");
    } finally {
      if (!signal?.aborted) setCheckingSession(false);
    }
  }, [destination, replace]);

  useEffect(() => {
    const controller = new AbortController();
    void checkSession(controller.signal);
    return () => controller.abort();
  }, [checkSession]);

  useEffect(() => {
    if (!error || submitting || checkingSession) return;
    const frame = requestAnimationFrame(() => passwordRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [checkingSession, error, submitting]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      await createAdminSession({ username: username.trim(), password });
      setPassword("");
      replace(destination);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法连接服务器，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="dark relative grid min-h-dvh overflow-hidden bg-[#080b12] text-foreground lg:grid-cols-[1.08fr_0.92fr]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_18%,rgba(59,130,246,0.13),transparent_32%),radial-gradient(circle_at_82%_78%,rgba(34,197,94,0.08),transparent_28%)]" />
      <section className="relative hidden border-r border-white/8 p-10 lg:flex lg:flex-col lg:justify-between xl:p-16">
        <div className="flex items-center gap-3 text-sm font-semibold tracking-wide">
          <span className="flex size-10 items-center justify-center rounded-xl border border-primary/25 bg-primary/12 text-primary shadow-[0_0_30px_rgba(59,130,246,0.12)]"><ShieldCheck className="size-5" /></span>
          实时赔率 · 管理控制台
        </div>
        <div className="max-w-xl space-y-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs text-muted-foreground"><Sparkles className="size-3.5 text-primary" />统一治理工作台</div>
          <div className="space-y-4">
            <p className="text-4xl font-semibold leading-tight tracking-[-0.035em] xl:text-5xl">让复杂运营，<br /><span className="text-primary">保持清晰可控。</span></p>
            <p className="max-w-lg text-base leading-7 text-muted-foreground">集中查看系统健康、自动化任务、策略版本与审计记录，在一个安全入口完成日常治理。</p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-sm">
            {["细粒度权限", "全链路审计", "实时健康状态"].map(item => <div key={item} className="rounded-xl border border-white/8 bg-white/[0.025] px-4 py-3 text-muted-foreground"><span className="mb-2 block size-1.5 rounded-full bg-success shadow-[0_0_10px_var(--success)]" />{item}</div>)}
          </div>
        </div>
        <p className="text-xs text-muted-foreground/70">仅限获得授权的管理人员访问</p>
      </section>

      <section className="relative flex min-h-dvh items-center justify-center px-4 py-10 sm:px-8">
        <Card className="w-full max-w-md border-white/10 bg-card/75 shadow-[0_30px_90px_rgba(0,0,0,0.42)] backdrop-blur-xl">
          <CardHeader className="space-y-5 pb-5">
            <div className="flex size-11 items-center justify-center rounded-xl border border-primary/25 bg-primary/12 text-primary lg:hidden"><ShieldCheck className="size-5" /></div>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold leading-none tracking-tight">{initialized === false ? "系统尚未初始化" : "欢迎回来"}</h1>
              <CardDescription className="text-sm leading-6">{initialized === false ? "请由服务器操作人员在本机终端创建首位超级管理员。" : "使用管理员账号登录，继续处理今天的系统运营。"}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {initialized === false ? (
              <section className="space-y-5" aria-label="管理员初始化说明">
                <Alert className="border-amber-400/25 bg-amber-400/8 text-amber-100">
                  <Terminal aria-hidden="true" />
                  <AlertTitle>必须在受信任的本机终端完成</AlertTitle>
                  <AlertDescription>此页面不会收集初始化 token、账号或密码，也不会继续普通登录。</AlertDescription>
                </Alert>
                <Collapsible open={instructionsOpen} onOpenChange={setInstructionsOpen} className="rounded-xl border border-white/10 bg-background/40 p-4">
                  <CollapsibleTrigger asChild>
                    <Button type="button" variant="ghost" className="h-10 w-full justify-start px-2 text-sm" aria-controls="admin-bootstrap-instructions">
                      <Info aria-hidden="true" className="size-4 text-primary" />
                      查看初始化说明
                      <ChevronDown aria-hidden="true" className={`ml-auto size-4 transition-transform ${instructionsOpen ? "rotate-180" : ""}`} />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent id="admin-bootstrap-instructions" className="space-y-2 px-2 pt-3 text-xs leading-5 text-muted-foreground">
                    <p>在应用服务器项目目录执行 <code className="rounded bg-black/30 px-1.5 py-0.5 text-foreground">pnpm admin:bootstrap</code>，按终端提示输入管理员信息。</p>
                    <p>初始化凭据只从受保护环境或终端隐藏输入读取，不应粘贴到网页、命令参数、聊天或日志中。</p>
                  </CollapsibleContent>
                </Collapsible>
                {error ? <Alert id="initialization-error" role="alert" aria-live="assertive" variant="destructive"><AlertCircle /><AlertTitle>检查失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
                <Button type="button" className="h-11 w-full" onClick={() => void checkSession()} disabled={checkingSession}>
                  {checkingSession ? <Loader2 className="animate-spin" /> : <RefreshCw />}{checkingSession ? "正在重新检查" : "重新检查初始化状态"}
                </Button>
              </section>
            ) : (
            <form className="space-y-5" onSubmit={handleSubmit} noValidate>
              <div className="space-y-2">
                <Label htmlFor="admin-username">管理员账号</Label>
                <Input
                  ref={usernameRef}
                  id="admin-username"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  required
                  minLength={2}
                  value={username}
                  onChange={event => { setUsername(event.target.value); if (error) setError(""); }}
                  placeholder="请输入账号"
                  aria-invalid={Boolean(error)}
                  className="h-11 bg-background/60"
                  disabled={submitting || checkingSession}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between"><Label htmlFor="admin-password">密码</Label><span className="text-xs text-muted-foreground">区分大小写</span></div>
                <div className="relative">
                  <Input
                    ref={passwordRef}
                    id="admin-password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={event => { setPassword(event.target.value); if (error) setError(""); }}
                    placeholder="请输入密码"
                    aria-describedby={error ? "login-error" : "password-help"}
                    aria-invalid={Boolean(error)}
                    className="h-11 bg-background/60 pr-11"
                    disabled={submitting || checkingSession}
                  />
                  <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1 size-9 text-muted-foreground hover:text-foreground" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"} disabled={submitting || checkingSession}>
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                </div>
                <p id="password-help" className="text-xs leading-5 text-muted-foreground">凭据仅用于建立安全会话，不会写入浏览器存储。</p>
              </div>
              {error ? (
                <Alert id="login-error" role="alert" aria-live="assertive" variant="destructive" className="border-destructive/30 bg-destructive/8">
                  <AlertCircle aria-hidden="true" />
                  <AlertTitle>无法登录</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <Button className="h-11 w-full shadow-lg shadow-primary/10 transition-all hover:-translate-y-0.5 hover:shadow-primary/20" type="submit" disabled={submitting || checkingSession || username.trim().length < 2 || !password}>
                {submitting || checkingSession ? <Loader2 aria-hidden="true" className="animate-spin" /> : <LockKeyhole aria-hidden="true" />}
                {checkingSession ? "正在检查会话" : submitting ? "正在安全验证" : "登录管理控制台"}
                {!submitting && !checkingSession ? <ArrowRight aria-hidden="true" className="ml-auto" /> : null}
              </Button>
            </form>
            )}
            <div className="mt-6 border-t border-white/8 pt-5 text-center text-xs text-muted-foreground">遇到访问问题，请联系系统所有者核验账号权限。</div>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="dark flex min-h-dvh items-center justify-center bg-[#080b12]" aria-label="正在加载登录页面"><Loader2 className="size-6 animate-spin text-primary" /></main>}>
      <LoginForm />
    </Suspense>
  );
}
