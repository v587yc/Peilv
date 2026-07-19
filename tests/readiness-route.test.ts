import { beforeEach, describe, expect, it, vi } from "vitest";

const readiness = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/readiness", () => ({ isProductionBuildReady: readiness }));

import { GET } from "@/app/api/readiness/route";

describe("production readiness route", () => {
  beforeEach(() => readiness.mockReset().mockResolvedValue(true));

  it("returns a generic ready response with no-store", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    const body = await response.json();
    expect(body).toEqual({ ready: true });
    expect(Object.keys(body)).toEqual(["ready"]);
    expect(`${JSON.stringify(body)} ${JSON.stringify(Object.fromEntries(response.headers))}`).not.toMatch(/secret|credential|env|path|manifest|build.?id|internal/i);
  });

  it("returns a generic not-ready response without internal details", async () => {
    readiness.mockResolvedValueOnce(false);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ ready: false });
    expect(Object.keys(body)).toEqual(["ready"]);
    expect(`${JSON.stringify(body)} ${JSON.stringify(Object.fromEntries(response.headers))}`).not.toMatch(/secret|credential|env|path|manifest|build.?id|internal/i);
  });
});
