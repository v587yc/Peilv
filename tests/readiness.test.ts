import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isProductionBuildReady } from "@/lib/readiness";

describe("production readiness service", () => {
  it("reports ready only when the required build markers are accessible", async () => {
    const accessFile = vi.fn<(filePath: string) => Promise<void>>(async () => undefined);
    await expect(isProductionBuildReady({ cwd: "workspace", accessFile })).resolves.toBe(true);
    expect(accessFile.mock.calls.map(([value]) => value)).toEqual([
      path.join("workspace", ".next", "BUILD_ID"),
      path.join("workspace", ".next", "routes-manifest.json"),
    ]);
  });

  it("reports not-ready without leaking filesystem errors", async () => {
    const accessFile = vi.fn<(filePath: string) => Promise<void>>(async (filePath: string) => {
      if (filePath.endsWith("BUILD_ID")) throw new Error("secret absolute path");
    });
    await expect(isProductionBuildReady({ cwd: "workspace", accessFile })).resolves.toBe(false);
  });
});
