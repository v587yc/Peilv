import { afterEach, describe, expect, it } from "vitest";
import { assertInternalSecret, isAuthorizedInternalRoute, isInternalRequest } from "@/lib/internal-auth";

const originalSecret = process.env.INTERNAL_API_SECRET;

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.INTERNAL_API_SECRET;
  } else {
    process.env.INTERNAL_API_SECRET = originalSecret;
  }
});

describe("internal authentication", () => {
  it("accepts the exact configured secret", () => {
    process.env.INTERNAL_API_SECRET = "Test_Internal_Secret_0123456789AB";
    const request = new Request("https://app.invalid/internal", {
      headers: { "x-internal-api-secret": "Test_Internal_Secret_0123456789AB" },
    });

    expect(isInternalRequest(request)).toBe(true);
    expect(() => assertInternalSecret("Test_Internal_Secret_0123456789AB")).not.toThrow();
  });

  it("rejects missing configuration, missing headers, and unequal secrets", () => {
    delete process.env.INTERNAL_API_SECRET;
    expect(isInternalRequest(new Request("https://app.invalid/internal"))).toBe(false);
    expect(() => assertInternalSecret("anything")).toThrow("内部任务认证失败");

    process.env.INTERNAL_API_SECRET = "Test_Internal_Secret_0123456789AB";
    expect(isInternalRequest(new Request("https://app.invalid/internal"))).toBe(false);
    expect(() => assertInternalSecret("test-secreu")).toThrow("内部任务认证失败");
    expect(() => assertInternalSecret("short")).toThrow("内部任务认证失败");
    expect(() => assertInternalSecret(null)).toThrow("内部任务认证失败");
  });

  it("binds internal authentication to an exact route method and purpose", () => {
    process.env.INTERNAL_API_SECRET = "Test_Internal_Secret_0123456789AB";
    const allowed = new Request("https://app.invalid/api/automation/dispatch", {
      method: "POST",
      headers: { "x-internal-api-secret": "Test_Internal_Secret_0123456789AB" },
    });
    const wrongMethod = new Request("https://app.invalid/api/automation/dispatch", {
      method: "GET",
      headers: { "x-internal-api-secret": "Test_Internal_Secret_0123456789AB" },
    });
    expect(isAuthorizedInternalRoute(allowed, "automation:dispatch")).toBe(true);
    expect(isAuthorizedInternalRoute(allowed, "automation:reconcile")).toBe(false);
    expect(isAuthorizedInternalRoute(wrongMethod, "automation:dispatch")).toBe(false);
  });
});
