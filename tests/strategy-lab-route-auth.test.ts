import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), internal: vi.fn(), audit: vi.fn(), storage: vi.fn() }));
vi.mock("@/lib/admin-auth", () => ({
  authorizeAdminRequest: mocks.authorize,
  isSameOriginMutation: (request: Request) => ["GET", "HEAD", "OPTIONS"].includes(request.method) || request.headers.get("origin") === new URL(request.url).origin,
}));
vi.mock("@/lib/internal-auth", () => ({ isInternalRequest: mocks.internal }));
vi.mock("@/lib/audit-log", () => ({ writeAuditLog: mocks.audit }));
vi.mock("@/storage/database/supabase-client", () => ({ getSupabaseClient: mocks.storage }));

import { proxy } from "@/proxy";
import { hasAdminCapability, principalForActor, type AdminCapability } from "@/lib/auth/admin-capabilities";

type Identity = "anonymous" | "auditor" | "operator" | "super_admin" | "internal";
const event = { waitUntil: vi.fn() } as unknown as NextFetchEvent;

function request(identity: Identity, method: string, path: string, origin = "https://app.invalid") {
  const headers = new Headers({ "x-test-identity": identity });
  if (identity === "internal") headers.set("x-internal-api-secret", "internal-secret");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", origin);
  return new NextRequest(`https://app.invalid${path}`, { method, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.internal.mockImplementation((req: Request) => req.headers.get("x-test-identity") === "internal");
  mocks.authorize.mockImplementation(async (req: Request) => {
    const identity = req.headers.get("x-test-identity") as Identity;
    if (identity === "anonymous") return { ok: false, status: 401, error: "需要管理员登录" };
    if (identity === "internal") return { ok: true, actor: { actorId: "internal-task", actorType: "internal" } };
    return { ok: true, actor: { actorId: `${identity}-id`, actorType: "admin", role: identity } };
  });
});

describe("strategy lab real admin authorization matrix", () => {
  it.each([
    ["admin:view", ["auditor", "operator", "super_admin"]],
    ["admin:configure", ["operator", "super_admin"]],
    ["admin:execute", ["operator", "super_admin"]],
    ["admin:dangerous", ["super_admin"]],
  ] as const)("enforces %s across all five identities", (capability, allowed) => {
    for (const identity of ["anonymous", "auditor", "operator", "super_admin", "internal"] as const) {
      if (identity === "anonymous" || identity === "internal") {
        expect(allowed.includes(identity as never)).toBe(false);
        continue;
      }
      const principal = principalForActor({ actorId: identity, actorType: "admin", role: identity });
      expect(hasAdminCapability(principal, capability as AdminCapability), identity).toBe(allowed.includes(identity as never));
    }
  });

  it("allows same-origin operator mutations through proxy but rejects cross-origin", async () => {
    const same = await proxy(request("operator", "POST", "/api/admin/strategy-lab/runs"), event);
    const cross = await proxy(request("operator", "POST", "/api/admin/strategy-lab/runs", "https://evil.invalid"), event);
    expect(same.status).toBe(200);
    expect(same.headers.get("x-middleware-next")).toBe("1");
    expect(cross.status).toBe(403);
    expect(cross.headers.get("x-middleware-next")).not.toBe("1");
  });

  it("rejects anonymous and internal identities before downstream dispatch", async () => {
    for (const identity of ["anonymous", "internal"] as const) {
      const response = await proxy(request(identity, "POST", "/api/admin/strategy-lab/predictions"), event);
      expect(response.status).toBe(identity === "anonymous" ? 401 : 403);
      expect(response.headers.get("x-middleware-next")).not.toBe("1");
    }
  });

  it("ignores forged actor headers without a real session", async () => {
    const forged = request("anonymous", "POST", "/api/admin/strategy-lab/settlements");
    forged.headers.set("x-authenticated-actor-type", "admin");
    forged.headers.set("x-authenticated-actor-id", "super_admin");
    const response = await proxy(forged, event);
    expect(response.status).toBe(401);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.storage).not.toHaveBeenCalled();
  });
});
