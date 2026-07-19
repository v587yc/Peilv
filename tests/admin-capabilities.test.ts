import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_CAPABILITIES,
  hasAdminCapability,
  isAdminCapability,
  principalForActor,
} from "@/lib/auth/admin-capabilities";

const originalToken = process.env.ADMIN_API_TOKEN;

beforeEach(() => { process.env.ADMIN_API_TOKEN = "capability-test-token"; });
afterEach(() => {
  if (originalToken === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = originalToken;
});

describe("admin capabilities", () => {
  it("maps a super administrator to all capabilities", () => {
    const principal = principalForActor({ actorId: "admin-1", actorType: "admin", role: "super_admin" });
    expect(principal.capabilities).toEqual(ADMIN_CAPABILITIES);
    for (const capability of ADMIN_CAPABILITIES) expect(hasAdminCapability(principal, capability)).toBe(true);
  });

  it("denies internal actors and arbitrary capabilities", () => {
    const internal = principalForActor({ actorId: "internal-task", actorType: "internal" });
    const missingRole = principalForActor({ actorId: "admin-without-role", actorType: "admin" });
    expect(hasAdminCapability(internal, "admin:view")).toBe(false);
    expect(hasAdminCapability(missingRole, "admin:view")).toBe(false);
    expect(hasAdminCapability(internal, "admin:unknown")).toBe(false);
    expect(isAdminCapability("admin:unknown")).toBe(false);
  });

  it("limits operator and auditor capabilities", () => {
    const operator = principalForActor({ actorId: "admin-2", actorType: "admin", role: "operator" });
    const auditor = principalForActor({ actorId: "admin-3", actorType: "admin", role: "auditor" });
    expect(hasAdminCapability(operator, "admin:execute")).toBe(true);
    expect(hasAdminCapability(operator, "admin:dangerous")).toBe(false);
    expect(hasAdminCapability(auditor, "admin:view")).toBe(true);
    expect(hasAdminCapability(auditor, "admin:configure")).toBe(false);
  });
});
