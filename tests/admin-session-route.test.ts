import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(),
  countAdminUsers: vi.fn(),
  authorizeAdminRequest: vi.fn(),
  createPersistentAdminSession: vi.fn(),
  revokeAdminSession: vi.fn(),
  writeAuditLog: vi.fn(),
  loginAdmissionKeys: vi.fn(), reserveAdminLoginAttempt: vi.fn(), settleAdminLoginAttempt: vi.fn(),
}));

vi.mock("@/lib/auth/admin-accounts", () => ({
  authenticateAdmin: mocks.authenticateAdmin,
  countAdminUsers: mocks.countAdminUsers,
}));
vi.mock("@/lib/admin-auth", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/admin-auth")>();
  return {
    ...actual,
    authorizeAdminRequest: mocks.authorizeAdminRequest,
    createPersistentAdminSession: mocks.createPersistentAdminSession,
    revokeAdminSession: mocks.revokeAdminSession,
  };
});
vi.mock("@/lib/audit-log", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/lib/auth/admin-login-rate-limit", () => ({
  loginAdmissionKeys: mocks.loginAdmissionKeys,
  reserveAdminLoginAttempt: mocks.reserveAdminLoginAttempt,
  settleAdminLoginAttempt: mocks.settleAdminLoginAttempt,
}));

import { DELETE, GET, POST } from "@/app/api/auth/session/route";

const admin = { id: "admin-1", username: "root", displayName: "Root", role: "super_admin", isActive: true, lastLoginAt: null, createdAt: "", updatedAt: "" };
function request(body: Record<string, unknown>, url = "https://app.invalid/api/auth/session") {
  return new NextRequest(url, { method: "POST", headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateAdmin.mockResolvedValue(admin);
  mocks.createPersistentAdminSession.mockResolvedValue("opaque-session-token");
  mocks.countAdminUsers.mockResolvedValue(1);
  mocks.authorizeAdminRequest.mockResolvedValue({ ok: true, actor: { actorId: admin.id, actorType: "admin", role: admin.role, username: admin.username } });
  mocks.loginAdmissionKeys.mockReturnValue({ globalKey: "g", sourceKey: null });
  mocks.reserveAdminLoginAttempt.mockResolvedValue({ reservationKey: "r".repeat(64), allowed: true, retryAfterSeconds: 0 });
  mocks.settleAdminLoginAttempt.mockResolvedValue({ settled: true, auditFailure: true });
});
afterEach(() => vi.restoreAllMocks());

describe("admin session API", () => {
  it("returns 200 and an explicit unauthenticated state for a normal session probe", async () => {
    mocks.authorizeAdminRequest.mockResolvedValue({ ok: false, status: 401, error: "需要管理员登录" });
    const response = await GET(new NextRequest("https://app.invalid/api/auth/session"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ initialized: true, authenticated: false, user: null });
  });

  it("reports initialized false when no administrator exists", async () => {
    mocks.authorizeAdminRequest.mockResolvedValue({ ok: false, status: 401, error: "需要管理员登录" });
    mocks.countAdminUsers.mockResolvedValue(0);
    const response = await GET(new NextRequest("https://app.invalid/api/auth/session"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ initialized: false, authenticated: false, user: null });
  });

  it("preserves session infrastructure failures instead of reporting logged out", async () => {
    mocks.authorizeAdminRequest.mockResolvedValue({ ok: false, status: 503, error: "管理员认证暂时不可用" });
    const response = await GET(new NextRequest("https://app.invalid/api/auth/session", { headers: { cookie: "admin_session=opaque-session-token" } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ authenticated: false, user: null, error: "管理员认证暂时不可用" });
  });

  it("returns 503 when initialization state cannot be read", async () => {
    mocks.authorizeAdminRequest.mockResolvedValue({ ok: false, status: 401, error: "需要管理员登录" });
    mocks.countAdminUsers.mockRejectedValue(new Error("database unavailable"));
    const response = await GET(new NextRequest("https://app.invalid/api/auth/session"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ authenticated: false, user: null });
  });
  it("authenticates username/password and creates a persistent session", async () => {
    const response = await POST(request({ username: "root", password: "StrongPassword123" }));
    expect(response.status).toBe(200);
    expect(mocks.authenticateAdmin).toHaveBeenCalledWith("root", "StrongPassword123");
    expect(mocks.reserveAdminLoginAttempt).toHaveBeenCalledBefore(mocks.authenticateAdmin);
    expect(mocks.loginAdmissionKeys).toHaveBeenCalledWith(expect.any(Request));
    expect(mocks.settleAdminLoginAttempt).toHaveBeenCalledWith("r".repeat(64), true);
    expect(mocks.createPersistentAdminSession).toHaveBeenCalledWith({ userId: admin.id, role: "super_admin", username: "root" });
    const cookie = response.headers.get("set-cookie") || "";
    expect(cookie).toContain("admin_session=opaque-session-token");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=strict");
    expect(cookie.toLowerCase()).toContain("secure");
  });

  it("does not treat a legacy token as a password login", async () => {
    mocks.authenticateAdmin.mockResolvedValue(null);
    const response = await POST(request({ username: "", password: "legacy-secret", token: "legacy-secret" }));
    expect(response.status).toBe(401);
    expect(mocks.createPersistentAdminSession).not.toHaveBeenCalled();
    expect(mocks.settleAdminLoginAttempt).toHaveBeenCalledWith("r".repeat(64), false);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "admin.login_failed",
      metadata: expect.not.objectContaining({ username: expect.anything(), ip: expect.anything(), password: expect.anything() }),
    }));
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("returns 429 with Retry-After before password hashing when locked", async () => {
    mocks.reserveAdminLoginAttempt.mockResolvedValue({ reservationKey: "", allowed: false, retryAfterSeconds: 37 });
    const response = await POST(request({ username: "root", password: "StrongPassword123" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(await response.json()).toMatchObject({ success: false, error: "账号或密码无效，请稍后重试" });
    expect(mocks.authenticateAdmin).not.toHaveBeenCalled();
  });

  it("returns a uniform 401 after a reserved failed attempt", async () => {
    mocks.authenticateAdmin.mockResolvedValue(null);
    const response = await POST(request({ username: "root", password: "wrong" }));
    expect(response.status).toBe(401);
    expect(mocks.settleAdminLoginAttempt).toHaveBeenCalledWith("r".repeat(64), false);
  });

  it("fails closed when the persistent limiter is unavailable", async () => {
    mocks.reserveAdminLoginAttempt.mockRejectedValue(new Error("database unavailable"));
    const response = await POST(request({ username: "root", password: "StrongPassword123" }));
    expect(response.status).toBe(503);
    expect(mocks.authenticateAdmin).not.toHaveBeenCalled();
  });

  it.each([4, 5, 10, 12])("admits known and unknown labels identically at %i concurrent requests", async count => {
    let sequence = 0;
    mocks.reserveAdminLoginAttempt.mockImplementation(async () => ({ reservationKey: (++sequence).toString().padStart(64, "0"), allowed: true, retryAfterSeconds: 0 }));
    mocks.authenticateAdmin.mockResolvedValue(null);
    const known = await Promise.all(Array.from({ length: count }, () => POST(request({ username: "known", password: "Password123456" }))));
    const knownHashEntries = mocks.authenticateAdmin.mock.calls.length;
    vi.clearAllMocks();
    mocks.loginAdmissionKeys.mockReturnValue({ globalKey: "g", sourceKey: null });
    mocks.reserveAdminLoginAttempt.mockImplementation(async () => ({ reservationKey: (++sequence).toString().padStart(64, "0"), allowed: true, retryAfterSeconds: 0 }));
    mocks.authenticateAdmin.mockResolvedValue(null);
    mocks.settleAdminLoginAttempt.mockResolvedValue({ settled: true, auditFailure: false });
    const unknown = await Promise.all(Array.from({ length: count }, () => POST(request({ username: "unknown", password: "Password123456" }))));
    expect(known.map(response => response.status)).toEqual(Array(count).fill(401));
    expect(unknown.map(response => response.status)).toEqual(Array(count).fill(401));
    expect(knownHashEntries).toBe(count);
    expect(mocks.authenticateAdmin).toHaveBeenCalledTimes(count);
    expect(mocks.loginAdmissionKeys).toHaveBeenCalledTimes(count);
  });

  it("fails closed when persistent session creation fails", async () => {
    mocks.createPersistentAdminSession.mockRejectedValue(new Error("database unavailable"));
    const response = await POST(request({ username: "root", password: "StrongPassword123" }));
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("uses a non-secure cookie only for an explicit HTTP origin", async () => {
    const response = await POST(request({ username: "root", password: "StrongPassword123" }, "http://app.invalid/api/auth/session"));
    expect(response.status).toBe(200);
    expect((response.headers.get("set-cookie") || "").toLowerCase()).not.toContain("secure");
  });

  it("revokes the server session before clearing the cookie on logout", async () => {
    const response = await DELETE(new NextRequest("https://app.invalid/api/auth/session", { method: "DELETE", headers: { origin: "https://app.invalid", cookie: "admin_session=opaque-session-token" } }));
    expect(response.status).toBe(200);
    expect(mocks.revokeAdminSession).toHaveBeenCalledWith("opaque-session-token");
    expect(response.headers.get("set-cookie")).toContain("admin_session=");
  });

  it("does not clear the cookie when server revocation fails", async () => {
    mocks.revokeAdminSession.mockRejectedValue(new Error("database unavailable"));
    const response = await DELETE(new NextRequest("https://app.invalid/api/auth/session", { method: "DELETE", headers: { origin: "https://app.invalid", cookie: "admin_session=opaque-session-token" } }));
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects cross-origin login attempts", async () => {
    const response = await POST(new NextRequest("https://app.invalid/api/auth/session", { method: "POST", headers: { origin: "https://evil.invalid", "content-type": "application/json" }, body: JSON.stringify({ username: "root", password: "StrongPassword123" }) }));
    expect(response.status).toBe(403);
    expect(mocks.authenticateAdmin).not.toHaveBeenCalled();
  });
});
