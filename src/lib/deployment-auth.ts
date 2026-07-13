import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

export const DEPLOYMENT_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
export const DEPLOYMENT_SESSION_COOKIE = "__Host-peilv_deployment_session";
const SESSION_VERSION = "v2";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_ENTRY_LIMIT = 1000;
const scryptAsync = (password: string, salt: Buffer, keyLength: number, options: { N: number; r: number; p: number; maxmem: number }) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });

export type DeploymentActor = {
  actorId: string;
  actorType: "deployment-admin";
  username: string;
  sessionId: string;
};

type SessionPayload = {
  v: 2;
  username: string;
  sid: string;
  iat: number;
  exp: number;
};

type LoginAttempt = {
  failures: number;
  windowStartedAt: number;
  blockedUntil: number;
  lastSeenAt: number;
};

const loginAttempts = new Map<string, LoginAttempt>();

function equal(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest) && actual.length === expected.length;
}

function secret(): string {
  const value = process.env.DEPLOYMENT_SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("DEPLOYMENT_SESSION_SECRET 未配置或长度不足");
  return value;
}

function configuredUsername(): string | null {
  const value = normalizeDeploymentUsername(process.env.DEPLOYMENT_ADMIN_USERNAME);
  return value || null;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(`deployment-session:${payload}`).digest("base64url");
}

export function normalizeDeploymentUsername(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(normalized) ? normalized : "";
}

function parsePasswordHash(value: string | undefined): {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  key: Buffer;
} | null {
  if (!value) return null;
  const [algorithm, costText, blockSizeText, parallelizationText, saltText, keyText, ...rest] = value.split("$");
  if (algorithm !== "scrypt" || rest.length) return null;
  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  if (cost !== 16384 || blockSize !== 8 || parallelization !== 1) return null;
  if (!/^[A-Za-z0-9_-]{22,}$/.test(saltText || "") || !/^[A-Za-z0-9_-]{43,}$/.test(keyText || "")) return null;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const key = Buffer.from(keyText, "base64url");
    return salt.length >= 16 && salt.length <= 64 && key.length === 32
      ? { cost, blockSize, parallelization, salt, key }
      : null;
  } catch {
    return null;
  }
}

export function isDeploymentCredentialConfigured(): boolean {
  return Boolean(configuredUsername() && parsePasswordHash(process.env.DEPLOYMENT_ADMIN_PASSWORD_HASH));
}

export async function verifyDeploymentCredentials(username: unknown, password: unknown): Promise<"valid" | "invalid" | "unconfigured"> {
  const expectedUsername = configuredUsername();
  const parsed = parsePasswordHash(process.env.DEPLOYMENT_ADMIN_PASSWORD_HASH);
  if (!expectedUsername || !parsed) return "unconfigured";
  if (typeof password !== "string" || password.length < 1 || password.length > 1024) return "invalid";

  const actualUsername = normalizeDeploymentUsername(username);
  const derived = await scryptAsync(password, parsed.salt, parsed.key.length, {
    N: parsed.cost,
    r: parsed.blockSize,
    p: parsed.parallelization,
    maxmem: 64 * 1024 * 1024,
  }) as Buffer;
  const usernameMatches = equal(actualUsername, expectedUsername);
  const passwordMatches = timingSafeEqual(derived, parsed.key);
  return usernameMatches && passwordMatches ? "valid" : "invalid";
}

export function deploymentSessionCookieName(isSecure: boolean): string {
  return isSecure ? DEPLOYMENT_SESSION_COOKIE : "peilv_deployment_session";
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function configuredPublicOrigin(): URL | null {
  const value = process.env.DEPLOYMENT_PUBLIC_ORIGIN;
  if (!value) return null;
  try {
    const origin = new URL(value);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return null;
    return origin;
  } catch {
    return null;
  }
}

function firstHeaderValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

export function getTrustedDeploymentOrigin(request: Request): URL {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  const requestUrl = new URL(request.url);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(requestUrl.hostname)) {
    throw new Error("DEPLOYMENT_PUBLIC_ORIGIN 未配置");
  }
  return new URL(requestUrl.origin);
}

export function getTrustedDeploymentClientIp(request: Request): string {
  const configured = configuredPublicOrigin();
  if (configured) {
    const proto = firstHeaderValue(request.headers.get("x-forwarded-proto"));
    const host = firstHeaderValue(request.headers.get("x-forwarded-host")) || firstHeaderValue(request.headers.get("host"));
    if (proto === configured.protocol.slice(0, -1) && host === configured.host) {
      const forwardedFor = firstHeaderValue(request.headers.get("x-forwarded-for"));
      if (forwardedFor && /^[0-9a-fA-F:.]{3,45}$/.test(forwardedFor)) return forwardedFor;
    }
    return "proxy-unknown";
  }
  return "local";
}

export function isSecureDeploymentRequest(request: Request): boolean {
  if (configuredPublicOrigin()) return true;
  const forwardedProto = firstHeaderValue(request.headers.get("x-forwarded-proto"));
  return (forwardedProto || new URL(request.url).protocol.replace(":", "")) === "https";
}

export function isSameOriginDeploymentMutation(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;
  const source = request.headers.get("origin") || request.headers.get("referer");
  if (!source) return false;
  try {
    return new URL(source).origin === getTrustedDeploymentOrigin(request).origin;
  } catch {
    return false;
  }
}

export function authorizeDeploymentRequest(request: Request): DeploymentActor | null {
  const name = deploymentSessionCookieName(isSecureDeploymentRequest(request));
  return verifyDeploymentSession(readCookie(request.headers.get("cookie"), name));
}

export function createDeploymentSession(username: string, now = Date.now()): string {
  const normalized = normalizeDeploymentUsername(username);
  if (!normalized || normalized !== configuredUsername()) throw new Error("部署管理员用户名无效");
  const issuedAt = Math.floor(now / 1000);
  const payload: SessionPayload = {
    v: 2,
    username: normalized,
    sid: randomBytes(18).toString("base64url"),
    iat: issuedAt,
    exp: issuedAt + DEPLOYMENT_SESSION_MAX_AGE_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${SESSION_VERSION}.${encoded}.${sign(encoded)}`;
}

export function verifyDeploymentSession(session: string | null | undefined, now = Date.now()): DeploymentActor | null {
  if (!session) return null;
  try {
    const [version, encoded, signature, ...rest] = session.split(".");
    if (version !== SESSION_VERSION || !encoded || !signature || rest.length) return null;
    if (!equal(signature, sign(encoded))) return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    const nowSeconds = Math.floor(now / 1000);
    const currentUsername = configuredUsername();
    if (payload.v !== 2 || !currentUsername || payload.username !== currentUsername) return null;
    if (!normalizeDeploymentUsername(payload.username) || !/^[A-Za-z0-9_-]{20,}$/.test(payload.sid)) return null;
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.iat > nowSeconds + 60 || payload.exp <= nowSeconds) return null;
    return {
      actorId: `local:${payload.username}`,
      actorType: "deployment-admin",
      username: payload.username,
      sessionId: payload.sid,
    };
  } catch {
    return null;
  }
}

export function createDeploymentCsrfToken(actor: DeploymentActor, action: string): string {
  return createHmac("sha256", secret())
    .update(`deployment-csrf:${actor.sessionId}:${action}`)
    .digest("base64url");
}

export function verifyDeploymentCsrfToken(actor: DeploymentActor, action: string, token: string | null): boolean {
  return Boolean(token && equal(token, createDeploymentCsrfToken(actor, action)));
}

function loginKey(username: unknown, clientIp: string): string {
  return `${normalizeDeploymentUsername(username) || "invalid"}\0${clientIp}`;
}

function pruneLoginAttempts(now: number): void {
  for (const [key, attempt] of loginAttempts) {
    if (attempt.blockedUntil <= now && attempt.windowStartedAt + LOGIN_WINDOW_MS <= now) loginAttempts.delete(key);
  }
  while (loginAttempts.size >= LOGIN_ENTRY_LIMIT) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, attempt] of loginAttempts) {
      if (attempt.lastSeenAt < oldest) {
        oldest = attempt.lastSeenAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    loginAttempts.delete(oldestKey);
  }
}

export function isDeploymentLoginBlocked(username: unknown, clientIp: string, now = Date.now()): boolean {
  pruneLoginAttempts(now);
  const attempt = loginAttempts.get(loginKey(username, clientIp));
  return Boolean(attempt && attempt.blockedUntil > now);
}

export function recordDeploymentLoginFailure(username: unknown, clientIp: string, now = Date.now()): void {
  pruneLoginAttempts(now);
  const key = loginKey(username, clientIp);
  const current = loginAttempts.get(key);
  const attempt = !current || current.windowStartedAt + LOGIN_WINDOW_MS <= now
    ? { failures: 0, windowStartedAt: now, blockedUntil: 0, lastSeenAt: now }
    : current;
  attempt.failures += 1;
  attempt.lastSeenAt = now;
  if (attempt.failures >= LOGIN_MAX_FAILURES) attempt.blockedUntil = now + LOGIN_BLOCK_MS;
  loginAttempts.set(key, attempt);
}

export function clearDeploymentLoginFailures(username: unknown, clientIp: string): void {
  loginAttempts.delete(loginKey(username, clientIp));
}

export function resetDeploymentLoginThrottleForTests(): void {
  loginAttempts.clear();
}
