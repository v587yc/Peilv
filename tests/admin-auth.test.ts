import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  authorizeAdminRequest,
  createAdminSession,
  isSameOriginMutation,
  verifyAdminSession,
  verifyAdminToken,
} from "@/lib/admin-auth";

const originalAdminToken = process.env.ADMIN_API_TOKEN;
const originalInternalSecret = process.env.INTERNAL_API_SECRET;

function restore(name: "ADMIN_API_TOKEN" | "INTERNAL_API_SECRET", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env.ADMIN_API_TOKEN = "test-admin-token";
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
});

afterEach(() => {
  restore("ADMIN_API_TOKEN", originalAdminToken);
  restore("INTERNAL_API_SECRET", originalInternalSecret);
});

describe("admin authentication", () => {
  it("compares the configured token exactly", () => {
    expect(verifyAdminToken("test-admin-token")).toBe(true);
    expect(verifyAdminToken("test-admin-tokee")).toBe(false);
    expect(verifyAdminToken("short")).toBe(false);
    expect(verifyAdminToken(null)).toBe(false);
  });

  it("issues a signed session without embedding the admin token", () => {
    const now = Date.now();
    const session = createAdminSession(now);

    expect(session).not.toContain("test-admin-token");
    expect(verifyAdminSession(session, now)).toBe(true);
    expect(verifyAdminSession(`${session.slice(0, -1)}x`, now)).toBe(false);
    expect(verifyAdminSession(session, now + (ADMIN_SESSION_MAX_AGE_SECONDS + 1) * 1000)).toBe(false);
  });

  it("fails closed with 503 when admin auth is unconfigured", () => {
    delete process.env.ADMIN_API_TOKEN;
    delete process.env.INTERNAL_API_SECRET;

    const result = authorizeAdminRequest(new Request("https://app.invalid/api/settings"));
    expect(result).toEqual({ ok: false, status: 503, error: "管理员认证未配置" });
  });

  it("accepts a valid session and rejects an invalid one", () => {
    const session = createAdminSession();
    const valid = authorizeAdminRequest(new Request("https://app.invalid/api/settings", {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${session}` },
    }));
    const invalid = authorizeAdminRequest(new Request("https://app.invalid/api/settings", {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=invalid` },
    }));

    expect(valid).toEqual({
      ok: true,
      actor: { actorId: "single-team-admin", actorType: "admin" },
    });
    expect(invalid).toEqual({ ok: false, status: 401, error: "需要管理员登录" });
  });

  it("preserves the internal task channel without requiring an admin cookie", () => {
    delete process.env.ADMIN_API_TOKEN;
    const result = authorizeAdminRequest(new Request("https://app.invalid/api/analysis/learn", {
      method: "POST",
      headers: { "x-internal-api-secret": "test-internal-secret" },
    }));

    expect(result).toEqual({
      ok: true,
      actor: { actorId: "internal-task", actorType: "internal" },
    });
  });

  it("requires same-origin browser mutations", () => {
    expect(isSameOriginMutation(new Request("https://app.invalid/api/settings"))).toBe(true);
    expect(isSameOriginMutation(new Request("https://app.invalid/api/settings", {
      method: "POST",
      headers: { origin: "https://app.invalid" },
    }))).toBe(true);
    expect(isSameOriginMutation(new Request("https://app.invalid/api/settings", {
      method: "POST",
      headers: { origin: "https://evil.invalid" },
    }))).toBe(false);
    expect(isSameOriginMutation(new Request("http://127.0.0.1:5000/api/auth/session", {
      method: "POST",
      headers: { origin: "http://localhost:5000", host: "127.0.0.1:5000" },
    }))).toBe(true);
    expect(isSameOriginMutation(new Request("http://localhost:5000/api/auth/session", {
      method: "POST",
      headers: { referer: "http://localhost:5000/login", host: "127.0.0.1:5000" },
    }))).toBe(true);
    expect(isSameOriginMutation(new Request("https://app.invalid/api/settings", {
      method: "POST",
    }))).toBe(false);
  });
});
