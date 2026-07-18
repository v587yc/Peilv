import { describe, expect, it } from "vitest";
import { MANAGEMENT_DESCRIPTORS, VERSION_UPDATE_COMMAND_MAP, findManagementDescriptor } from "@/features/management/registry";
import { canonicalCommandHash, validateAdminCommand } from "@/features/management/commands";

describe("management registry", () => {
  it("is closed, unique, and includes governed deployment controls", () => {
    const ids = MANAGEMENT_DESCRIPTORS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      "deployment.preflight",
      "deployment.deploy",
      "deployment.rollback",
    ]));
    expect(findManagementDescriptor("unknown")).toBeNull();
  });

  it("maps the version-update product flow unambiguously to deployment commands", () => {
    expect(VERSION_UPDATE_COMMAND_MAP).toEqual({
      check: "deployment.preflight",
      update: "deployment.deploy",
      restorePrevious: "deployment.rollback",
    });
    expect(MANAGEMENT_DESCRIPTORS.some(entry => entry.id === "release.version-update")).toBe(false);
    for (const id of Object.values(VERSION_UPDATE_COMMAND_MAP)) expect(findManagementDescriptor(id)?.category).toBe("deployment");
  });

  it("requires write metadata for mutable descriptors", () => {
    for (const descriptor of MANAGEMENT_DESCRIPTORS) {
      if (descriptor.mutability === "read-only" || descriptor.mutability === "external-only") continue;
      expect(descriptor.writeCapability).toMatch(/^admin:/);
      expect(descriptor.idempotency).not.toBe("not-applicable");
      expect(descriptor.audit).not.toBe("none");
    }
  });
});

describe("admin command envelope", () => {
  it("hashes semantically identical payloads deterministically", () => {
    const first = { targetId: "x", reason: "needed", idempotencyKey: "key-12345678", payload: { b: 2, a: 1 } };
    const second = { reason: "needed", payload: { a: 1, b: 2 }, idempotencyKey: "key-12345678", targetId: "x" };
    expect(canonicalCommandHash(first)).toBe(canonicalCommandHash(second));
  });

  it("rejects incomplete command metadata", () => {
    expect(() => validateAdminCommand({ targetId: "x", payload: {} })).toThrow("操作原因格式无效");
  });
});
