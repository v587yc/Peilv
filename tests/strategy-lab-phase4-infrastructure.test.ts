import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("Strategy Lab Phase4 infrastructure contracts", () => {
  it("composes fresh bootstrap from the exact canonical 0023 migration without unsupported SQL meta commands", async () => {
    const setup = await read("setup-database.sql"); const bootstrap = await read("scripts/local-data.ps1"); const migration = await read("migrations/0023_strategy_lab_trusted_settlement.sql");
    expect(setup).not.toMatch(/^\\i[r]?\s/m);
    expect(bootstrap).toContain("$StrategyLabTrustedSettlementSql = Join-Path $ProjectRoot 'migrations\\0023_strategy_lab_trusted_settlement.sql'");
    expect(bootstrap.indexOf("Invoke-PsqlFile $SetupSql")).toBeLessThan(bootstrap.indexOf("Invoke-PsqlFile $StrategyLabTrustedSettlementSql"));
    expect(bootstrap.indexOf("Invoke-PsqlFile $StrategyLabTrustedSettlementSql")).toBeLessThan(bootstrap.indexOf("Invoke-PsqlFile $StrategyLabRolesSql"));
    for (const token of ["strategy_lab_match_result_revisions", "evidence_contract_version", "strategy_lab_settlements_validate_trusted", "ENABLE ROW LEVEL SECURITY", "0023_strategy_lab_trusted_settlement"]) expect(migration).toContain(token);
  });
  it("grants result revision minimum SELECT/INSERT and denies mutation", async () => {
    const roles = await read("infra/local-data/sql/strategy-lab-roles.sql");
    expect(roles).toContain("'strategy_lab_match_result_revisions'");
    expect(roles).toContain("GRANT SELECT ON TABLE %I TO strategy_lab_reader,strategy_lab_writer");
    expect(roles).toContain("GRANT INSERT ON TABLE %I TO strategy_lab_writer");
    expect(roles).toContain("REVOKE UPDATE,DELETE ON strategy_lab_match_result_revisions");
    for (const fn of ["strategy_lab_reject_result_revision_mutation()", "strategy_lab_validate_match_result_revision()", "strategy_lab_validate_trusted_settlement()"]) expect(roles).toContain(fn);
    expect(roles).toContain("ALTER FUNCTION %s OWNER TO strategy_lab_owner");
  });
  it("probes 0023 ledger, table, columns, triggers, RLS policies and ACL with a minimal external error", async () => {
    const readiness = await read("src/features/strategy-lab/production-readiness.ts");
    for (const value of ["0023_strategy_lab_trusted_settlement", "strategy_lab_match_result_revisions", "evidence_contract_version", "evidence_hash", "strategy_lab_settlements_validate_trusted", "STRATEGY_LAB_DATABASE_UNAVAILABLE"]) expect(readiness).toContain(value);
    expect(readiness).toContain("count(*)=15"); expect(readiness).toContain("count(*)=47");
  });
  it("injects the production calculator and keeps it out of the public index", async () => {
    const server = await read("src/features/strategy-lab/server.ts"); const index = await read("src/features/strategy-lab/index.ts");
    expect(server).toContain("new PostgresSettlementCalculator(sqlClient)");
    expect(index).not.toMatch(/postgres-settlement-calculator|production-server|production-readiness|\.\/server/);
  });
});
