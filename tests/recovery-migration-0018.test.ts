import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("0018 command audit recovery and backtest leases", () => {
  const sql = readFileSync(resolve(process.cwd(), "migrations/0018_command_audit_and_backtest_leases.sql"), "utf8");
  const setup = readFileSync(resolve(process.cwd(), "setup-database.sql"), "utf8");
  it("adds durable audit context and idempotent succeeded audits", () => {
    expect(sql).toContain("audit_context JSONB");
    expect(sql).toContain("audit_logs_command_success_unique");
    expect(sql).toContain("action LIKE '%.succeeded'");
    expect(setup).toContain("audit_logs_command_success_unique");
  });
  it("heartbeats, atomically fails startup, and reclaims expired leases", () => {
    for (const contract of ["heartbeat_backtest_job", "fail_claimed_backtest_job", "reconcile_expired_backtest_jobs", "FOR UPDATE SKIP LOCKED", "lock_owner = NULL", "lock_expires_at = NULL"]) {
      expect(sql).toContain(contract);
      expect(setup).toContain(contract);
    }
    expect(sql).toContain("REVOKE ALL ON FUNCTION heartbeat_backtest_job");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION reconcile_expired_backtest_jobs(INTEGER) TO service_role");
  });
});
