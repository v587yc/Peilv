import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("atomic backtest admission migration", () => {
  const sql = readFileSync(resolve(process.cwd(), "migrations/0016_atomic_backtest_claim.sql"), "utf8");

  it("serializes quota checks and claims the active job in one transaction", () => {
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toMatch(/WHERE status IN \('running', 'cancelling'\)/);
    expect(sql).toContain("INSERT INTO backtest_jobs");
    expect(sql.indexOf("pg_advisory_xact_lock")).toBeLessThan(sql.indexOf("INSERT INTO backtest_jobs"));
  });

  it("does not expose the claim RPC to public callers", () => {
    expect(sql).toContain("REVOKE ALL ON FUNCTION claim_backtest_job");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION claim_backtest_job(JSONB, INTEGER, BOOLEAN) TO service_role");
  });
});
