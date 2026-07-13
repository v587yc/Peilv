import { getInstallationToken } from "@/lib/github/github-app-auth";

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId: string | null,
    public readonly retryAfter: string | null,
  ) {
    super(message);
  }
}

export async function githubApiBytes(endpoint: string): Promise<Uint8Array> {
  if (!endpoint.startsWith("/")) throw new Error("GitHub endpoint 必须是固定相对路径");
  const token = await getInstallationToken();
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "peilv-deployment-control",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new GitHubApiError(
      `GitHub API 请求失败 (${response.status})`,
      response.status,
      response.headers.get("x-github-request-id"),
      response.headers.get("retry-after") || response.headers.get("x-ratelimit-reset"),
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function githubApi<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  if (!endpoint.startsWith("/")) throw new Error("GitHub endpoint 必须是固定相对路径");
  const token = await getInstallationToken();
  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "peilv-deployment-control",
      ...init.headers,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new GitHubApiError(
      `GitHub API 请求失败 (${response.status})`,
      response.status,
      response.headers.get("x-github-request-id"),
      response.headers.get("retry-after") || response.headers.get("x-ratelimit-reset"),
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
