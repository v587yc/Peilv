import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StrategyLabSqlDependencyError,
  createStrategyLabPgOwner,
  createStrategyLabPgPool,
  createStrategyLabSqlClient,
  getOrCreateStrategyLabPgOwner,
  type StrategyLabPgPoolClientLike,
  type StrategyLabPgPoolLike,
} from "@/features/strategy-lab/postgres-sql-client";

type Step = { sql: string; parameters: readonly unknown[] };

function fakePool(input: { fail?: (sql: string) => unknown; release?: () => void } = {}) {
  const clientSteps: Step[] = [];
  const poolSteps: Step[] = [];
  const client: StrategyLabPgPoolClientLike = {
    async query(sql, parameters = []) {
      clientSteps.push({ sql, parameters });
      const failure = input.fail?.(sql);
      if (failure) throw failure;
      return { rows: [] };
    },
    release: vi.fn(input.release),
  };
  const pool: StrategyLabPgPoolLike = {
    async query(sql, parameters = []) { poolSteps.push({ sql, parameters }); return { rows: [] }; },
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
  };
  return { pool, client, clientSteps, poolSteps };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("strategy lab production pg sql adapter", () => {
  it("uses pool.query only for ordinary parameterized queries", async () => {
    const fake = fakePool();
    const value = "Robert'); SELECT secret FROM vault;--";
    await createStrategyLabSqlClient(fake.pool).query("SELECT $1::text", [value]);
    expect(fake.poolSteps).toEqual([{ sql: "SELECT $1::text", parameters: [value] }]);
    expect(fake.clientSteps).toEqual([]);
  });

  it("runs BEGIN, safe local timeouts, callback and COMMIT on one client", async () => {
    const fake = fakePool();
    const sql = createStrategyLabSqlClient(fake.pool);
    await expect(sql.transaction(async transaction => {
      expect("transaction" in transaction).toBe(false);
      await transaction.query("INSERT INTO sample(value) VALUES($1)", ["user-value"]);
      return "ok";
    })).resolves.toBe("ok");
    expect(fake.poolSteps).toEqual([]);
    expect(fake.clientSteps.map(step => step.sql)).toEqual([
      "BEGIN",
      expect.stringContaining("set_config('statement_timeout', $1, true)"),
      "INSERT INTO sample(value) VALUES($1)",
      "COMMIT",
    ]);
    expect(fake.clientSteps[1].parameters).toEqual(["3000ms", "1000ms", "5000ms"]);
    expect(fake.clientSteps[1].sql).not.toContain("3000ms");
    expect(fake.client.release).toHaveBeenCalledOnce();
  });

  it("releases when BEGIN fails without issuing a rollback", async () => {
    const raw = new Error("postgresql://user:password@db/private SELECT secret $1");
    const fake = fakePool({ fail: sql => sql === "BEGIN" ? raw : undefined });
    const error = await createStrategyLabSqlClient(fake.pool).transaction(async () => undefined).catch(value => value);
    expect(error).toBeInstanceOf(StrategyLabSqlDependencyError);
    expect(JSON.stringify(error)).not.toMatch(/password|SELECT secret|postgresql:/);
    expect(fake.clientSteps.map(step => step.sql)).toEqual(["BEGIN"]);
    expect(fake.client.release).toHaveBeenCalledOnce();
  });

  it("rolls back callback and transaction-query failures and releases", async () => {
    for (const mode of ["callback", "query"] as const) {
      const business = new Error("business failure");
      const fake = fakePool({ fail: sql => mode === "query" && sql === "WORK" ? new Error("raw SQL params secret") : undefined });
      const result = createStrategyLabSqlClient(fake.pool).transaction(async transaction => {
        if (mode === "query") await transaction.query("WORK", ["secret"]);
        throw business;
      }).catch(error => error);
      const error = await result;
      if (mode === "callback") expect(error).toBe(business);
      else expect(error).toBeInstanceOf(StrategyLabSqlDependencyError);
      expect(fake.clientSteps.at(-1)?.sql).toBe("ROLLBACK");
      expect(fake.client.release).toHaveBeenCalledOnce();
    }
  });

  it("attempts rollback after COMMIT failure and preserves the commit error", async () => {
    const fake = fakePool({ fail: sql => sql === "COMMIT" ? new Error("commit private detail") : undefined });
    const error = await createStrategyLabSqlClient(fake.pool).transaction(async () => "value").catch(value => value);
    expect(error).toBeInstanceOf(StrategyLabSqlDependencyError);
    expect(fake.clientSteps.map(step => step.sql).slice(-2)).toEqual(["COMMIT", "ROLLBACK"]);
    expect(fake.client.release).toHaveBeenCalledOnce();
  });

  it("does not replace a business error when rollback or release fails", async () => {
    const business = new Error("safe business failure");
    const fake = fakePool({ fail: sql => sql === "ROLLBACK" ? new Error("rollback raw") : undefined, release: () => { throw new Error("release raw"); } });
    await expect(createStrategyLabSqlClient(fake.pool).transaction(async () => { throw business; })).rejects.toBe(business);
  });

  it("owns and closes a pool exactly once", async () => {
    const fake = fakePool();
    const owner = createStrategyLabPgOwner(fake.pool);
    await owner.close(); await owner.close();
    expect(fake.pool.end).toHaveBeenCalledOnce();
    expect(owner).not.toHaveProperty("pool");
  });

  it("validates DSN protocols and never permits insecure TLS", () => {
    expect(() => createStrategyLabPgPool({ databaseUrl: "" })).toThrow("configuration is invalid");
    expect(() => createStrategyLabPgPool({ databaseUrl: "https://db.invalid" })).toThrow("configuration is invalid");
    const pool = createStrategyLabPgPool({ databaseUrl: "postgresql://user:pass@localhost/db", ca: "trusted-ca" });
    expect((pool as unknown as { options: { max: number; ssl: { rejectUnauthorized: boolean } } }).options).toMatchObject({ max: 4, ssl: { rejectUnauthorized: true } });
    void pool.end();
  });

  it("reuses a server singleton and allows recreation only after close", async () => {
    const first = getOrCreateStrategyLabPgOwner({ databaseUrl: "postgresql://localhost/strategy_lab_singleton" });
    const second = getOrCreateStrategyLabPgOwner({ databaseUrl: "postgresql://localhost/strategy_lab_singleton" });
    expect(second).toBe(first);
    await first.close();
    const third = getOrCreateStrategyLabPgOwner({ databaseUrl: "postgresql://localhost/strategy_lab_singleton" });
    expect(third).not.toBe(first);
    await third.close();
  });
});
