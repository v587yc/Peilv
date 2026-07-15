import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_SESSION_COOKIE, createAdminSession } from "@/lib/admin-auth";
import {
  ADMIN_CAPABILITIES,
  hasAdminCapability,
  isAdminCapability,
  principalForActor,
  requireAdminCapability,
} from "@/lib/auth/admin-capabilities";

const originalToken = process.env.ADMIN_API_TOKEN;

beforeEach(() => { process.env.ADMIN_API_TOKEN = "capability-test-token"; });
afterEach(() => {
  if (originalToken === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = originalToken;
});

describe("admin capabilities", () => {
  it("maps the single administrator to all four capabilities", () => {
    const principal = principalForActor({ actorId: "single-team-admin", actorType: "admin" });
    expect(principal.capabilities).toEqual(ADMIN_CAPABILITIES);
    for (const capability of ADMIN_CAPABILITIES) expect(hasAdminCapability(principal, capability)).toBe(true);
  });

  it("denies internal actors and arbitrary capabilities", () => {
    const internal = principalForActor({ actorId: "internal-task", actorType: "internal" });
    expect(hasAdminCapability(internal, "admin:view")).toBe(false);
    expect(hasAdminCapability(internal, "admin:unknown")).toBe(false);
    expect(isAdminCapability("admin:unknown")).toBe(false);
  });

  it("authorizes a declared capability from a valid session", () => {
    const request = new Request("https://app.invalid/api/admin/audit", {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${createAdminSession()}` },
    });
    expect(requireAdminCapability(request, "admin:view")).toMatchObject({ ok: true });
    expect(requireAdminCapability(request, "admin:unknown")).toEqual({ ok: false, status: 403, error: "权限不足" });
  });
});
