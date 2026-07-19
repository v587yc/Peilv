import { createPrivateKey, sign } from "node:crypto";

type CachedToken = { value: string; expiresAt: number } | null;
let cachedInstallationToken: CachedToken = null;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function readPrivateKey(): string {
  const inline = process.env.GITHUB_APP_PRIVATE_KEY;
  if (inline) return inline.replace(/\\n/g, "\n");
  throw new Error("GITHUB_APP_PRIVATE_KEY 未配置");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

function createAppJwt(now = Date.now()): string {
  const appId = required("GITHUB_APP_ID");
  const issuedAt = Math.floor(now / 1000) - 30;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: appId }));
  const message = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(message), createPrivateKey(readPrivateKey()));
  return `${message}.${base64url(signature)}`;
}

async function githubJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "peilv-deployment-control",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub API 请求失败 (${response.status})`);
  return response.json() as Promise<T>;
}

export async function getInstallationToken(now = Date.now()): Promise<string> {
  if (cachedInstallationToken && cachedInstallationToken.expiresAt - now > 60_000) return cachedInstallationToken.value;
  const installationId = required("GITHUB_APP_INSTALLATION_ID");
  const result = await githubJson<{ token: string; expires_at: string }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers: { Authorization: `Bearer ${createAppJwt(now)}` } },
  );
  const expiresAt = Date.parse(result.expires_at);
  if (!result.token || !Number.isFinite(expiresAt)) throw new Error("GitHub installation token 响应无效");
  cachedInstallationToken = { value: result.token, expiresAt };
  return result.token;
}
