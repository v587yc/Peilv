"use client";

type ErrorPayload = { error?: unknown };

export function isAdminFeatureUnavailable(error: unknown): error is AdminApiError {
  return error instanceof AdminApiError && (error.status === 404 || error.status === 501);
}

export class AdminApiError<T = ErrorPayload> extends Error {
  readonly status: number;
  readonly data: T;

  constructor(message: string, status: number, data: T) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.data = data;
  }
}

function currentLoginUrl(): string {
  if (typeof window === "undefined") return "/login";
  const next = `${window.location.pathname}${window.location.search}`;
  return `/login?next=${encodeURIComponent(next)}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AdminApiError(
      response.ok ? "后台返回了无法识别的数据" : `后台服务响应异常（HTTP ${response.status}）`,
      response.status,
      {} as T,
    );
  }
}

export async function adminApiRequest<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  fallbackMessage = "后台请求失败",
): Promise<T> {
  const response = await fetch(input, init);
  if (response.status === 401) {
    // Authentication takes precedence over payload parsing. Reverse proxies may
    // return an HTML login page for an expired session.
    let data = {} as T;
    try { data = await parseResponse<T>(response); } catch { /* keep auth error */ }
    if (typeof window !== "undefined") window.location.replace(currentLoginUrl());
    throw new AdminApiError("登录状态已失效，正在返回登录页", response.status, data);
  }
  const data = await parseResponse<T>(response);
  if (!response.ok) {
    const errorPayload = data as ErrorPayload;
    const message = typeof errorPayload.error === "string" && errorPayload.error.trim() ? errorPayload.error : fallbackMessage;
    throw new AdminApiError(message, response.status, data);
  }
  return data;
}
