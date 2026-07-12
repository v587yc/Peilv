import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ADMIN_SESSION_COOKIE = "admin_session";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

const SESSION_VERSION = "v1";
const SESSION_CONTEXT = "single-team-admin";

export type AdminActor = {
  actorId: string;
  actorType: "admin" | "internal";
};

export type AdminAuthorization =
  | { ok: true; actor: AdminActor }
  | { ok: false; status: 401 | 403 | 503; error: string };

function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) {
    // Compare equal-length digests as well so a length mismatch does not skip
    // the constant-time primitive entirely.
    const actualDigest = createHmac("sha256", "length-mismatch").update(actualBuffer).digest();
    const expectedDigest = createHmac("sha256", "length-mismatch").update(expectedBuffer).digest();
    timingSafeEqual(actualDigest, expectedDigest);
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function signSessionPayload(payload: string, token: string): string {
  return createHmac("sha256", token)
    .update(`${SESSION_CONTEXT}:${payload}`)
    .digest("base64url");
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export function isAdminTokenConfigured(): boolean {
  return Boolean(process.env.ADMIN_API_TOKEN);
}

export function verifyAdminToken(candidate: unknown): boolean {
  const expected = process.env.ADMIN_API_TOKEN;
  return typeof candidate === "string" && Boolean(expected) && timingSafeStringEqual(candidate, expected!);
}

export function createAdminSession(now = Date.now()): string {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) throw new Error("ADMIN_API_TOKEN 未配置");
  const issuedAt = Math.floor(now / 1000);
  const payload = `${SESSION_VERSION}.${issuedAt}.${randomBytes(18).toString("base64url")}`;
  return `${payload}.${signSessionPayload(payload, token)}`;
}

export function verifyAdminSession(session: string | null | undefined, now = Date.now()): boolean {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token || !session) return false;

  const parts = session.split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return false;

  const issuedAt = Number(parts[1]);
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isInteger(issuedAt) || issuedAt > nowSeconds + 60) return false;
  if (nowSeconds - issuedAt > ADMIN_SESSION_MAX_AGE_SECONDS) return false;

  const payload = parts.slice(0, 3).join(".");
  return timingSafeStringEqual(parts[3], signSessionPayload(payload, token));
}

function verifyInternalSecret(request: Request): boolean {
  const expected = process.env.INTERNAL_API_SECRET;
  const candidate = request.headers.get("x-internal-api-secret");
  return Boolean(expected && candidate && timingSafeStringEqual(candidate, expected));
}

export function authorizeAdminRequest(request: Request): AdminAuthorization {
  if (verifyInternalSecret(request)) {
    return { ok: true, actor: { actorId: "internal-task", actorType: "internal" } };
  }

  if (!isAdminTokenConfigured()) {
    return { ok: false, status: 503, error: "管理员认证未配置" };
  }

  const session = readCookie(request.headers.get("cookie"), ADMIN_SESSION_COOKIE);
  if (!verifyAdminSession(session)) {
    return { ok: false, status: 401, error: "需要管理员登录" };
  }

  return { ok: true, actor: { actorId: "single-team-admin", actorType: "admin" } };
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function sameOriginOrLoopbackAlias(actual: URL, expected: URL): boolean {
  if (actual.origin === expected.origin) return true;
  return actual.protocol === expected.protocol
    && actual.port === expected.port
    && isLoopbackHost(actual.hostname)
    && isLoopbackHost(expected.hostname);
}

function requestOriginCandidates(request: Request): URL[] {
  const candidates = [new URL(request.url)];
  const host = request.headers.get("host");
  if (host) {
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    candidates.push(new URL(`${forwardedProto || candidates[0].protocol.replace(":", "")}://${host}`));
  }
  return candidates;
}

export function isSameOriginMutation(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;

  const source = request.headers.get("origin") || request.headers.get("referer");
  if (!source) return false;

  try {
    const sourceUrl = new URL(source);
    return requestOriginCandidates(request).some(candidate => sameOriginOrLoopbackAlias(sourceUrl, candidate));
  } catch {
    return false;
  }
}
