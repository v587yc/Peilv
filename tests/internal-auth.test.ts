import { afterEach, describe, expect, it } from "vitest";
import { assertInternalSecret, isInternalRequest } from "@/lib/internal-auth";

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
    process.env.INTERNAL_API_SECRET = "test-secret";
    const request = new Request("https://app.invalid/internal", {
      headers: { "x-internal-api-secret": "test-secret" },
    });

    expect(isInternalRequest(request)).toBe(true);
    expect(() => assertInternalSecret("test-secret")).not.toThrow();
  });

  it("rejects missing configuration, missing headers, and unequal secrets", () => {
    delete process.env.INTERNAL_API_SECRET;
    expect(isInternalRequest(new Request("https://app.invalid/internal"))).toBe(false);
    expect(() => assertInternalSecret("anything")).toThrow("内部任务认证失败");

    process.env.INTERNAL_API_SECRET = "test-secret";
    expect(isInternalRequest(new Request("https://app.invalid/internal"))).toBe(false);
    expect(() => assertInternalSecret("test-secreu")).toThrow("内部任务认证失败");
    expect(() => assertInternalSecret("short")).toThrow("内部任务认证失败");
    expect(() => assertInternalSecret(null)).toThrow("内部任务认证失败");
  });
});
