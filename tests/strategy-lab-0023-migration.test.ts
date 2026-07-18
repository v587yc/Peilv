import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const databases: PGlite[] = [];

async function migrate0023() {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE schema_migrations(version VARCHAR(100) PRIMARY KEY,description TEXT NOT NULL);
    CREATE TABLE user_focused_leagues(id SERIAL PRIMARY KEY,league_name TEXT NOT NULL UNIQUE);
    CREATE TABLE odds_snapshots(id SERIAL PRIMARY KEY,match_id VARCHAR(20) NOT NULL,match_date VARCHAR(8) NOT NULL,
      company_id VARCHAR(20) NOT NULL,market_type TEXT NOT NULL,snapshot_type TEXT NOT NULL,source TEXT NOT NULL,
      odds JSONB NOT NULL,source_observed_at TIMESTAMPTZ,collected_at TIMESTAMPTZ NOT NULL,content_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE strategy_versions(version TEXT PRIMARY KEY);
    CREATE TABLE prediction_results(id SERIAL PRIMARY KEY);
    CREATE TABLE match_results(id SERIAL PRIMARY KEY,match_id VARCHAR(20) NOT NULL,match_date VARCHAR(8) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',home_score INTEGER,away_score INTEGER,score_source TEXT NOT NULL DEFAULT 'official',
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),settled_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);
  for (const migration of [
    "migrations/0020_strategy_lab_fact_model.sql",
    "migrations/0021_strategy_lab_policy_and_artifacts.sql",
    "migrations/0022_strategy_lab_snapshot_provider.sql",
    "migrations/0023_strategy_lab_trusted_settlement.sql",
  ]) await db.exec(await read(migration));
  return db;
}

afterAll(async () => Promise.all(databases.map(database => database.close())));

describe("0023 trusted settlement migration", () => {
  it("executes the exact fixture -> 0020 -> 0021 -> 0022 -> 0023 chain", async () => {
    const db = await migrate0023();
    const versions = await db.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
    expect(versions.rows.map(row => row.version)).toEqual([
      "0020_strategy_lab_fact_model", "0021_strategy_lab_policy_and_artifacts",
      "0022_strategy_lab_snapshot_provider", "0023_strategy_lab_trusted_settlement",
    ]);
    const columns = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('strategy_lab_predictions','strategy_lab_settlements')`);
    const names = new Set(columns.rows.map(row => row.column_name));
    for (const name of ["evidence_contract_version","execution_cutoff_at","executed_actual_quote_snapshot_id",
      "theoretical_handicap_raw","theoretical_handicap_quarter_units","theoretical_selected_water",
      "quote_handicap_raw","quote_handicap_quarter_units","quote_selected_water","quote_selected_water_millionths"]) expect(names.has(name)).toBe(true);
  });

  it("composes the fresh setup with the exact canonical 0023 migration", async () => {
    const db = new PGlite(); databases.push(db);
    await db.exec(await read("setup-database.sql"));
    await db.exec(await read("migrations/0023_strategy_lab_trusted_settlement.sql"));
    const contract = await db.query<{ table_exists: boolean; revision_trigger: boolean; settlement_trigger: boolean; ledger: boolean }>(`
      SELECT to_regclass('public.strategy_lab_match_result_revisions') IS NOT NULL AS table_exists,
        EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.strategy_lab_match_result_revisions'::regclass AND tgname='strategy_lab_match_result_revisions_append_only') AS revision_trigger,
        EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.strategy_lab_settlements'::regclass AND tgname='strategy_lab_settlements_validate_trusted') AS settlement_trigger,
        EXISTS(SELECT 1 FROM schema_migrations WHERE version='0023_strategy_lab_trusted_settlement') AS ledger`);
    expect(contract.rows[0]).toEqual({ table_exists:true, revision_trigger:true, settlement_trigger:true, ledger:true });
    const security=await db.query<{ relrowsecurity:boolean; relforcerowsecurity:boolean }>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.strategy_lab_match_result_revisions'::regclass");
    expect(security.rows[0]).toEqual({ relrowsecurity:true, relforcerowsecurity:true });
  }, 20_000);

  it("locks the trusted DB contract, append-only posture, and hardened function scope", async () => {
    const sql = await read("migrations/0023_strategy_lab_trusted_settlement.sql");
    for (const contract of [
      "decision_status<>'recommend'", "experiment_run.run_type<>'shadow'", "experiment_run.status NOT IN('running','succeeded')",
      "settlement result revision identity mismatch", "pending result cannot be settled", "special result must be unavailable",
      "finished result must be counted", "actual quote binding mismatch", "theoretical quote is not authoritative",
      "settlement successor quote drift", "match result revisions are append-only", "ENABLE ROW LEVEL SECURITY",
      "FORCE ROW LEVEL SECURITY", "REVOKE ALL ON strategy_lab_match_result_revisions FROM PUBLIC",
      "SECURITY DEFINER SET search_path=pg_catalog,public",
    ]) expect(sql).toContain(contract);
    expect(sql).toContain("previous.source_updated_at>=NEW.source_updated_at");
    expect(sql).toContain("strategy-lab-settlement-evidence-v2");
  });
});
