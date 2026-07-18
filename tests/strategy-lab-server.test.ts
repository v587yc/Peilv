import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStrategyLabService, registerStrategyLabServiceForTests } from "@/features/strategy-lab/server";

const root = new URL("..", import.meta.url);
const restores: Array<() => void> = [];
afterEach(() => { while (restores.length) restores.pop()?.(); vi.unstubAllEnvs(); });

describe("strategy lab server-only composition boundary", () => {
  it("is unavailable by default and restores test overrides", () => {
    expect(getStrategyLabService()).toBeNull();
    const service = { marker: "test" } as never;
    const restore = registerStrategyLabServiceForTests(service); restores.push(restore);
    expect(getStrategyLabService()).toBe(service);
    restore(); restores.pop();
    expect(getStrategyLabService()).toBeNull();
  });

  it("rejects test registration outside test mode", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => registerStrategyLabServiceForTests(null)).toThrow("test-only");
    expect(getStrategyLabService()).toBeNull();
  });

  it("keeps server and postgres implementations out of the common index", async () => {
    const index = await readFile(new URL("src/features/strategy-lab/index.ts", root), "utf8");
    const production = await readFile(new URL("src/features/strategy-lab/production-server.ts", root), "utf8");
    expect(index).not.toMatch(/postgres-repository|postgres-sql-client|production-server|production-readiness|\.\/server|application-service|admin-route/);
    expect(production).toContain('import "server-only"');
    expect(production).not.toMatch(/supabase|service[_-]?role|\.from\(/i);
  });

  it("keeps server-only strategy infrastructure out of client components", async () => {
    const files = ["postgres-sql-client.ts", "production-server.ts", "production-readiness.ts", "server.ts"];
    for (const file of files) {
      const source = await readFile(new URL(`src/features/strategy-lab/${file}`, root), "utf8");
      expect(source, file).toContain('import "server-only"');
      expect(source, file).not.toContain('"use client"');
    }
  });
});
