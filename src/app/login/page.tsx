"use client";

import { FormEvent, Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LockKeyhole, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedNext = searchParams.get("next");
  const destination = requestedNext && /^\/admin(?:\/|\?|$)/.test(requestedNext) ? requestedNext : "/admin";
  const tokenRef = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" }).then(response => {
      if (response.ok) router.replace(destination);
    }).catch(() => undefined);
  }, [destination, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setError(result.error || (response.status === 503 ? "服务端尚未配置管理员令牌" : "登录失败"));
        tokenRef.current?.focus();
        return;
      }

      setToken("");
      router.replace(destination);
      router.refresh();
    } catch {
      setError("无法连接服务器，请稍后重试");
      tokenRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="dark flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground">
      <Card className="w-full max-w-md border-border bg-card shadow-2xl shadow-black/30">
        <CardHeader className="space-y-4 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <LockKeyhole aria-hidden="true" className="size-6" />
          </div>
          <div className="space-y-2">
            <CardTitle className="text-2xl">管理员登录</CardTitle>
            <CardDescription className="text-base leading-6">
              使用服务端配置的管理员令牌进入实时赔率监控系统。
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="admin-token">管理员令牌</Label>
              <Input
                ref={tokenRef}
                id="admin-token"
                name="admin-token"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={token}
                onChange={event => setToken(event.target.value)}
                aria-describedby={error ? "login-error" : "token-help"}
                aria-invalid={Boolean(error)}
                className="h-11"
              />
              <p id="token-help" className="text-sm leading-5 text-muted-foreground">
                令牌仅用于本次登录，不会保存在浏览器存储中。
              </p>
              {error ? (
                <p id="login-error" role="alert" className="text-sm font-medium text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
            <Button className="h-11 w-full cursor-pointer" type="submit" disabled={submitting || !token}>
              {submitting ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
              {submitting ? "正在验证" : "安全登录"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-background" aria-label="正在加载登录页面" />}>
      <LoginForm />
    </Suspense>
  );
}
