export type AdminCredentials = {
  username: string;
  password: string;
};

export type AdminSessionState = {
  configured: boolean;
  initialized?: boolean;
  authenticated: boolean;
  actorType?: string | null;
  user?: { id?: string; username?: string; role?: string } | null;
};

type AuthErrorPayload = { error?: string };

export async function readAdminSession(signal?: AbortSignal): Promise<AdminSessionState> {
  const response = await fetch("/api/auth/session", { cache: "no-store", signal });
  const payload = (await response.json().catch(() => ({}))) as Partial<AdminSessionState> & AuthErrorPayload;
  if (!response.ok) throw new Error(payload.error || "管理员会话服务暂时不可用");
  return {
    configured: payload.configured !== false,
    initialized: payload.initialized,
    authenticated: payload.authenticated === true,
    actorType: payload.actorType,
    user: payload.authenticated === true ? payload.user : null,
  };
}

export async function createAdminSession(credentials: AdminCredentials): Promise<void> {
  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  const payload = (await response.json().catch(() => ({}))) as AuthErrorPayload;
  if (!response.ok) {
    throw new Error(payload.error || (response.status === 503 ? "管理员认证服务尚未配置" : "账号或密码不正确"));
  }
}
