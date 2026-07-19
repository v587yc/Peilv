import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  authorizeAdminRequest,
  createAdminSession,
  isSameOriginMutation,
  timingSafeSecretEqual,
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
  process.env.INTERNAL_API_SECRET = "Test_Internal_Secret_0123456789AB";
});

afterEach(() => {
  restore("ADMIN_API_TOKEN", originalAdminToken);
  restore("INTERNAL_API_SECRET", originalInternalSecret);
});

describe("admin authentication", () => {
  it("compares secrets through a constant-size timing-safe digest", () => {
    expect(timingSafeSecretEqual("bootstrap-secret", "bootstrap-secret")).toBe(true);
    expect(timingSafeSecretEqual("x", "a-much-longer-bootstrap-secret")).toBe(false);
  });
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

  it("requires login when no session is supplied", async () => {
    delete process.env.ADMIN_API_TOKEN;
    delete process.env.INTERNAL_API_SECRET;

    const result = await authorizeAdminRequest(new Request("https://app.invalid/api/settings"));
    expect(result).toEqual({ ok: false, status: 401, error: "需要管理员登录" });
  });

  it("does not authorize legacy signed sessions as administrators", async () => {
    const session = createAdminSession();
    const legacy = await authorizeAdminRequest(new Request("https://app.invalid/api/settings", {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${session}` },
    }));
    const invalid = await authorizeAdminRequest(new Request("https://app.invalid/api/settings", {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=invalid` },
    }));

    expect(legacy.ok).toBe(false);
    expect(invalid).toMatchObject({ ok: false, status: expect.any(Number) });
  });

  it("does not treat internal credentials as administrator credentials on management routes", async () => {
    delete process.env.ADMIN_API_TOKEN;
    const result = await authorizeAdminRequest(new Request("https://app.invalid/api/analysis/learn", {
      method: "POST",
      headers: { "x-internal-api-secret": "Test_Internal_Secret_0123456789AB" },
    }));

    expect(result).toEqual({ ok: false, status: 403, error: "内部任务无权访问此接口" });
  });

  it("recognizes internal credentials only on an exact allowlisted route and method", async () => {
    const result = await authorizeAdminRequest(new Request("https://app.invalid/api/automation/compensate", {
      method: "POST",
      headers: { "x-internal-api-secret": "Test_Internal_Secret_0123456789AB" },
    }));
    expect(result).toEqual({ ok: true, actor: { actorId: "internal-task", actorType: "internal" } });
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
