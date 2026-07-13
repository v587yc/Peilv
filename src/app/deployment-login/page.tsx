"use client";

import { FormEvent, useState } from "react";
import { AlertCircle, Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function DeploymentLoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/deployment-auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const result = await response.json().catch(() => ({ error: "登录失败，请稍后重试" })) as { success?: boolean; error?: string };
      if (!response.ok || !result.success) {
        setError(result.error || "登录失败，请稍后重试");
        return;
      }
      window.location.replace("/deployments");
    } catch {
      setError("登录失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="dark flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground">
      <Card className="w-full max-w-lg border-border bg-card shadow-2xl shadow-black/30">
        <CardHeader className="space-y-5 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <ShieldCheck aria-hidden="true" className="size-6" />
          </div>
          <div className="space-y-2">
            <CardTitle className="text-2xl">版本管理与部署控制台</CardTitle>
            <CardDescription className="mx-auto max-w-md text-base leading-6">
              使用部署管理员账号查看发布候选、执行生产预检，并在人工确认后部署或回退代码版本。
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {error ? (
            <div role="alert" className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="deployment-username">管理员账号</Label>
              <Input
                id="deployment-username"
                autoComplete="username"
                value={username}
                onChange={event => setUsername(event.target.value)}
                maxLength={64}
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="deployment-password">管理员密码</Label>
              <Input
                id="deployment-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                maxLength={1024}
                disabled={submitting}
              />
            </div>
            <Button type="submit" className="h-11 w-full cursor-pointer" disabled={submitting || !username || !password}>
              {submitting ? <Loader2 aria-hidden="true" className="size-5 animate-spin" /> : <LockKeyhole aria-hidden="true" className="size-5" />}
              {submitting ? "正在登录" : "安全登录"}
            </Button>
          </form>
          <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm leading-6 text-muted-foreground">
            GitHub App 仅在服务器后台读取固定仓库并调度 Actions。浏览器不会获得 GitHub Token、App 私钥或生产 SSH 凭据。
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
