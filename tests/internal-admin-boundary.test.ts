import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  internal: vi.fn(),
  audit: vi.fn(),
  storage: vi.fn(),
}));

vi.mock("@/lib/admin-auth", () => ({
  authorizeAdminRequest: mocks.authorize,
  isSameOriginMutation: (request: Request) => ["GET", "HEAD", "OPTIONS"].includes(request.method) || request.headers.get("origin") === new URL(request.url).origin,
}));
vi.mock("@/lib/internal-auth", () => ({ isInternalRequest: mocks.internal }));
vi.mock("@/lib/audit-log", () => ({ writeAuditLog: mocks.audit }));
vi.mock("@/storage/database/supabase-client", () => ({ getSupabaseClient: mocks.storage }));

import { proxy } from "@/proxy";

type Identity = "anonymous" | "auditor" | "operator" | "super" | "internal";
const event = { waitUntil: vi.fn() } as unknown as NextFetchEvent;

function request(identity: Identity, path: string, method: string) {
  const headers = new Headers({ "x-test-identity": identity });
  if (identity === "internal") headers.set("x-internal-api-secret", "valid-internal-secret");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", "https://app.invalid");
  return new NextRequest(`https://app.invalid${path}`, { method, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.internal.mockImplementation((req: Request) => req.headers.get("x-test-identity") === "internal");
  mocks.authorize.mockImplementation(async (req: Request) => {
    const identity = req.headers.get("x-test-identity") as Identity;
    if (identity === "anonymous") return { ok: false, status: 401, error: "需要管理员登录" };
    if (identity === "internal") return { ok: true, actor: { actorId: "internal-task", actorType: "internal" } };
    const role = identity === "super" ? "super_admin" : identity;
    return { ok: true, actor: { actorId: `${identity}-id`, actorType: "admin", role } };
  });
});

async function status(identity: Identity, path: string, method: string) {
  return (await proxy(request(identity, path, method), event)).status;
}

describe("internal actor/admin capability boundary", () => {
  const deniedInternal = [
    ["/api/settings", "GET"],
    ["/api/backtest", "POST"],
    ["/api/analysis", "POST"],
    ["/api/strategy", "POST"],
    ["/api/prediction", "POST"],
    ["/api/report", "POST"],
    ["/api/deployments/deploy", "POST"],
    ["/api/admin/users", "GET"],
    ["/api/admin/users", "POST"],
    ["/api/auth/session", "GET"],
  ] as const;

  it.each(deniedInternal)("rejects internal %s %s with no downstream dispatch", async (path, method) => {
    const response = await proxy(request("internal", path, method), event);
    expect(response.status).toBe(403);
    expect(response.headers.get("x-middleware-next")).not.toBe("1");
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/automation/dispatch", "POST"],
    ["/api/automation/reconcile", "POST"],
    ["/api/automation/compensate", "POST"],
    ["/api/storage/health", "GET"],
  ] as const)("allows exact internal endpoint %s %s", async (path, method) => {
    const response = await proxy(request("internal", path, method), event);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-authenticated-actor-type")).toBeNull();
  });

  it("rejects wrong methods and compatibility-prefix lookalikes", async () => {
    expect(await status("internal", "/api/automation/dispatch", "GET")).toBe(403);
    expect(await status("internal", "/api/automation/dispatch/legacy", "POST")).toBe(403);
    expect(await status("internal", "/api/storage/health", "POST")).toBe(403);
  });

  it.each([
    ["POST", "/api/settings", "operator"],
    ["POST", "/api/strategy", "operator"],
    ["POST", "/api/strategy/v1/publish", "super"],
    ["POST", "/api/strategy/v1/rollback", "super"],
    ["POST", "/api/backtest", "operator"],
    ["DELETE", "/api/backtest", "operator"],
  ] as const)("returns side-effect-free 410 for %s %s", async (method, path, identity) => {
    const response = await proxy(request(identity, path, method), event);
    expect(response.status).toBe(410);
    expect(response.headers.get("x-middleware-next")).not.toBe("1");
    expect(event.waitUntil).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.storage).not.toHaveBeenCalled();
  });

  it("ignores forged authenticated-actor headers without a real identity", async () => {
    const forged = request("anonymous", "/api/settings", "POST");
    forged.headers.set("x-authenticated-actor-type", "admin");
    forged.headers.set("x-authenticated-actor-id", "super-admin");
    const response = await proxy(forged, event);
    expect(response.status).toBe(401);
  });

  it("canonicalizes local redirects and honors production forwarded host and protocol", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const local = new NextRequest("http://127.0.0.1:3100/admin/backtests", { headers: { "x-test-identity": "anonymous" } });
    const localResponse = await proxy(local, event);
    expect(localResponse.headers.get("location")).toBe("http://localhost:3100/login?next=%2Fadmin%2Fbacktests");

    vi.stubEnv("NODE_ENV", "production");
    const proxied = new NextRequest("http://127.0.0.1:5000/admin/backtests", { headers: { "x-test-identity": "anonymous", "x-forwarded-host": "odds.example.com", "x-forwarded-proto": "https" } });
    const proxiedResponse = await proxy(proxied, event);
    expect(proxiedResponse.headers.get("location")).toBe("https://odds.example.com:5000/login?next=%2Fadmin%2Fbacktests");
    vi.unstubAllEnvs();
  });

  it("strips forged actor headers from unprotected compatibility APIs", async () => {
    const forged = request("anonymous", "/api/auth/session", "GET");
    forged.headers.set("x-authenticated-actor-type", "internal");
    forged.headers.set("x-authenticated-actor-id", "internal-task");
    const response = await proxy(forged, event);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-request-x-authenticated-actor-type")).toBeNull();
    expect(response.headers.get("x-middleware-request-x-authenticated-actor-id")).toBeNull();
  });

  it.each([
    ["GET", "/api/settings", ["auditor", "operator", "super"]],
    ["POST", "/api/settings", []],
    ["POST", "/api/analysis", ["operator", "super"]],
    ["POST", "/api/strategy/v1/publish", []],
  ] as const)("enforces five-identity matrix for %s %s", async (method, path, allowed) => {
    for (const identity of ["anonymous", "auditor", "operator", "super", "internal"] as const) {
      const actual = await status(identity, path, method);
      const tombstoned = method === "POST" && (path === "/api/settings" || path.includes("/api/strategy/"));
      expect(actual, identity).toBe(allowed.includes(identity as never) ? 200 : identity === "anonymous" ? 401 : tombstoned && identity === "super" || tombstoned && identity === "operator" && path === "/api/settings" ? 410 : 403);
    }
  });
});
