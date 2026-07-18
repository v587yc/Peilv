import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { buildStrategyLabProductionService, inspectStrategyLabProductionDependencies } from "@/features/strategy-lab/production-server";
import { createStrategyLabProductionState } from "@/features/strategy-lab/server";

const root = new URL("..", import.meta.url);
const fakeSqlClient = { query: async () => ({ rows: [] }), transaction: async <T>(callback: (executor: never) => Promise<T>) => callback({ query: async () => ({ rows: [] }) } as never) };

describe("strategy lab production composition", () => {
  it("is unavailable without an explicit DSN and remains unavailable with repository only", () => {
    const missing = createStrategyLabProductionState();
    expect(missing).toMatchObject({ configured: false, service: null, sqlClient: null });
    const repositoryOnly = createStrategyLabProductionState({ databaseUrl: "postgresql://localhost/strategy_lab", sqlClient: fakeSqlClient });
    expect(repositoryOnly.configured).toBe(true);
    expect(repositoryOnly.sqlClient).toBe(fakeSqlClient);
    expect(repositoryOnly.service).toBeNull();
    expect(repositoryOnly.dependencies.status).toBe("unavailable");
  });

  it("requires the full atomic dependency set and builds with complete fakes", () => {
    const repository = {} as never;
    const snapshotProvider = {} as never;
    const leaguePolicy = {} as never;
    const versionProvider = {} as never;
    const runtimeRegistry = {} as never;
    const captureValidator = { validate: vi.fn() } as never;
    const settlementCalculator = { calculate: vi.fn() } as never;
    const complete = { repository, snapshotProvider, captureValidator, leaguePolicy, versionProvider, runtimeRegistry, currentBuildId: "build", settlementCalculator };
    expect(inspectStrategyLabProductionDependencies({ repository }).missing).toEqual(["snapshotProvider", "captureValidator", "leaguePolicy", "versionProvider", "runtimeRegistry", "currentBuildId", "settlementCalculator"]);
    for (const missing of ["repository", "snapshotProvider", "captureValidator", "leaguePolicy", "versionProvider", "runtimeRegistry", "currentBuildId", "settlementCalculator"] as const) {
      expect(buildStrategyLabProductionService(Object.fromEntries(Object.entries(complete).filter(([name]) => name !== missing)))).toBeNull();
    }
    expect(buildStrategyLabProductionService(complete)).not.toBeNull();
  });

  it("has no REST/Supabase fallback or credential derivation", async () => {
    const source = await readFile(new URL("src/features/strategy-lab/server.ts", root), "utf8");
    expect(source).toContain("STRATEGY_LAB_DATABASE_URL");
    expect(source).not.toMatch(/supabase|service[_-]?role|fetch\(|\.from\(/i);
  });

  it("keeps pg runtime-resolvable without requiring an existing build", () => {
    const require = createRequire(import.meta.url);
    expect(require.resolve("pg")).toMatch(/pg/);
    expect(require.resolve("pg/package.json")).toMatch(/package\.json$/);
  });
});
