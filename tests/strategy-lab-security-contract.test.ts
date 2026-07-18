import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

let STRATEGY_LAB_MIGRATION_LOCK_KEY: string;
let buildLockedMigrationSql: typeof import("../scripts/run-migrations.mjs").buildLockedMigrationSql;
let parseMigrationPlan: typeof import("../scripts/run-migrations.mjs").parseMigrationPlan;
let runMigrationProcess: typeof import("../scripts/run-migrations.mjs").runMigrationProcess;

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFile(path.join(root, file), "utf8");

describe("Strategy Lab database security contract", () => {
  beforeAll(async () => {
    const migrationRunner = await import("../scripts/run-migrations.mjs");
    STRATEGY_LAB_MIGRATION_LOCK_KEY = migrationRunner.STRATEGY_LAB_MIGRATION_LOCK_KEY;
    buildLockedMigrationSql = migrationRunner.buildLockedMigrationSql;
    parseMigrationPlan = migrationRunner.parseMigrationPlan;
    runMigrationProcess = migrationRunner.runMigrationProcess;
  });

  it("keeps 0021 default-deny across all fourteen tables and all migration functions", async () => {
    const sql = await read("migrations/0021_strategy_lab_policy_and_artifacts.sql");
    for (const table of ["snapshot_sets","snapshot_items","experiment_runs","predictions","settlements","command_receipts","match_facts","focused_league_baselines","focused_league_events","league_policy_artifacts","league_policy_captures","strategy_artifacts","strategy_publications","build_artifacts"]) {
      expect(sql).toContain(`'strategy_lab_${table}'`);
    }
    expect(sql).toContain("ALTER TABLE %I FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON TABLE %I FROM PUBLIC");
    expect(sql).not.toMatch(/CREATE ROLE|CREATE POLICY/);
    expect(sql.match(/'strategy_lab_[a-z_]+\([^']*\)'/g)?.length).toBeGreaterThanOrEqual(18);
  });

  it("installs no-login least-privilege roles, stable policies and exact updates", async () => {
    const sql = await read("infra/local-data/sql/strategy-lab-roles.sql");
    expect(sql).not.toMatch(/\bPASSWORD\b|(?<!NO)\bBYPASSRLS\b|(?<!NO)\bSUPERUSER\b/i);
    expect(sql).toContain("CREATE ROLE %I NOLOGIN NOSUPERUSER");
    expect(sql).toContain("GRANT strategy_lab_owner TO strategy_lab_migrator");
    expect(sql).not.toContain("GRANT strategy_lab_owner TO strategy_lab_writer");
    expect(sql).toContain("strategy_lab_reader_select");
    expect(sql).toContain("strategy_lab_writer_insert");
    expect(sql).toContain("UPDATE(status,error_summary,started_at,finished_at,updated_at)");
    expect(sql).toContain("UPDATE(status,last_audit_error_code,audit_attempts,updated_at,audited_at)");
    expect(sql).not.toMatch(/FOR DELETE|GRANT DELETE/);
    expect(sql).toContain("ARRAY['odds_snapshots','match_results','strategy_versions']");
    expect(sql.lastIndexOf("ALTER TABLE %I OWNER TO strategy_lab_owner")).toBeGreaterThan(sql.indexOf("CREATE POLICY strategy_lab_writer_update"));
    expect(sql).not.toContain("REVOKE ALL ON SCHEMA public FROM PUBLIC");
  });

  it("grants readiness exact column-only migration ledger access through reader inheritance", async () => {
    const sql = await read("infra/local-data/sql/strategy-lab-roles.sql");
    const migrationGrants = sql.match(/GRANT\s+[^;]+ON(?:\s+TABLE)?\s+public\.schema_migrations\s+TO\s+[^;]+;/gi) ?? [];

    expect(migrationGrants).toEqual([
      "GRANT SELECT (version) ON TABLE public.schema_migrations TO strategy_lab_reader;",
    ]);
    expect(sql).not.toMatch(/GRANT\s+SELECT\s+ON(?:\s+TABLE)?\s+public\.schema_migrations/i);
    expect(sql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE)\b[^;]*schema_migrations/i);
    expect(sql).toContain("REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC,strategy_lab_reader,strategy_lab_writer,strategy_lab_maintenance;");
    expect(sql).toContain("REVOKE SELECT (%1$I),INSERT (%1$I),UPDATE (%1$I),REFERENCES (%1$I) ON TABLE public.schema_migrations");
    expect(sql).toContain("REVOKE ALL ON TABLE public.schema_migrations FROM %I");
    expect(sql).toContain("GRANT strategy_lab_reader TO strategy_lab_writer");
    expect(sql).toContain("GRANT strategy_lab_writer TO strategy_lab_maintenance");
  });

  it("grants only the canonical text helper directly to writer after function revocation", async () => {
    const rolesSql = await read("infra/local-data/sql/strategy-lab-roles.sql");
    const factMigrationSql = await read("migrations/0020_strategy_lab_fact_model.sql");
    const migrationSql = await read("migrations/0021_strategy_lab_policy_and_artifacts.sql");
    const executeGrants = rolesSql.match(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+[^;]+;/gi) ?? [];
    const canonicalGrant = "GRANT EXECUTE ON FUNCTION public.strategy_lab_canonicalize_text(text) TO strategy_lab_writer;";

    expect(executeGrants).toEqual([canonicalGrant]);
    expect(rolesSql.indexOf(canonicalGrant)).toBeGreaterThan(rolesSql.lastIndexOf("REVOKE ALL ON FUNCTION %s FROM %I"));
    expect(rolesSql).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+ALL\s+FUNCTIONS/i);
    expect(rolesSql).not.toMatch(/GRANT\s+EXECUTE[\s\S]*?\bTO\s+(?:strategy_lab_reader|strategy_lab_maintenance|PUBLIC|anon|authenticated)\b/i);

    const triggerOnlyFunctions = [
      "strategy_lab_reject_fact_mutation", "strategy_lab_validate_snapshot_item_asof",
      "strategy_lab_validate_snapshot_item_completeness", "strategy_lab_validate_snapshot_set_insert",
      "strategy_lab_validate_prediction_snapshot", "strategy_lab_validate_receipt_transition",
      "strategy_lab_validate_settlement_revision", "strategy_lab_validate_settlement_evidence",
      "strategy_lab_validate_run_transition", "strategy_lab_validate_run_insert",
      "strategy_lab_validate_match_fact_insert", "strategy_lab_validate_focused_baseline_insert",
      "strategy_lab_validate_focused_baseline_complete", "strategy_lab_validate_focused_event_insert",
      "strategy_lab_validate_policy_artifact", "strategy_lab_validate_strategy_artifact",
      "strategy_lab_validate_publication_insert",
      "strategy_lab_reject_result_revision_mutation", "strategy_lab_validate_match_result_revision",
      "strategy_lab_validate_trusted_settlement",
    ];
    for (const functionName of triggerOnlyFunctions) {
      expect(rolesSql).not.toMatch(new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+(?:public\\.)?${functionName}\\s*\\(`, "i"));
    }
    expect(rolesSql).toContain("REVOKE UPDATE,DELETE ON strategy_lab_match_result_revisions");
    expect(rolesSql).not.toMatch(/GRANT\s+(?:UPDATE|DELETE|TRUNCATE)[^;]*strategy_lab_match_result_revisions/i);
    expect(rolesSql).toContain("FOREACH role_name IN ARRAY ARRAY['anon','authenticated']");
    expect(rolesSql).toContain("REVOKE ALL ON FUNCTION %s FROM %I");
    expect(migrationSql).toMatch(/SET search_path\s*=\s*pg_catalog\s*,\s*public/i);
    expect(factMigrationSql).toMatch(/SET search_path\s*=\s*public\s*,\s*pg_temp/i);
  });

  it("keeps isolated PG16 QA opt-in, secret-safe and random-resource scoped", async () => {
    const script = await read("scripts/qa-strategy-lab-pg16.sh");
    expect(script).toContain("postgres:16-alpine");
    expect(script).toContain("trap cleanup EXIT INT TERM");
    expect(script).toContain("strategy-lab-pg16-qa-$(date +%s)-$$-$RANDOM");
    expect(script).not.toMatch(/docker system prune|docker volume prune|POSTGRES_PASSWORD=[A-Za-z0-9]+\b/);
    expect(script).not.toContain("set -x");
    expect(script).toContain("pg_try_advisory_lock");
  });
});

describe("single-session migration runner", () => {
  it("validates plans and emits one lock covering migrations, ledger and postcheck", async () => {
    const migration = await read("migrations/0021_strategy_lab_policy_and_artifacts.sql");
    const { createHash } = await import("node:crypto");
    const plan = "0021_strategy_lab_policy_and_artifacts.sql\t0021_strategy_lab_policy_and_artifacts\t" + createHash("sha256").update(migration).digest("hex") + "\tfalse\tself\n";
    expect(parseMigrationPlan(plan)).toHaveLength(1);
    const sql = await buildLockedMigrationSql({ migrationsDirectory: path.join(root, "migrations"), planText: plan });
    expect(sql.indexOf(`pg_try_advisory_lock(${STRATEGY_LAB_MIGRATION_LOCK_KEY})`)).toBeLessThan(sql.indexOf("CREATE TABLE strategy_lab_match_facts"));
    expect(sql.indexOf("CREATE TABLE strategy_lab_match_facts")).toBeLessThan(sql.indexOf("migration plan incomplete"));
    expect(sql.indexOf("migration plan incomplete")).toBeLessThan(sql.indexOf(`pg_advisory_unlock(${STRATEGY_LAB_MIGRATION_LOCK_KEY})`));
  });

  it("uses one child session and never includes connection secrets in errors", async () => {
    const stdin = { end: vi.fn() };
    const handlers: Record<string, (value?: unknown) => void> = {};
    const spawnImpl = vi.fn(() => ({ stdin, once: vi.fn((event: string, handler: (value?: unknown) => void) => { handlers[event]=handler; }) }));
    const running = runMigrationProcess({ sql: "SELECT 1", spawnImpl: spawnImpl as never });
    handlers.exit(0);
    await running;
    expect(spawnImpl).toHaveBeenCalledOnce();
    expect(stdin.end).toHaveBeenCalledWith("SELECT 1");
  });

  it("fails immediately when the advisory lock is unavailable and relies on session close for release", async () => {
    const migration = await read("migrations/0021_strategy_lab_policy_and_artifacts.sql");
    const { createHash } = await import("node:crypto");
    const plan = "0021_strategy_lab_policy_and_artifacts.sql\t0021_strategy_lab_policy_and_artifacts\t" + createHash("sha256").update(migration).digest("hex") + "\tfalse\tself\n";
    const sql = await buildLockedMigrationSql({ migrationsDirectory: path.join(root, "migrations"), planText: plan });
    expect(sql).toContain(`SELECT pg_try_advisory_lock(${STRATEGY_LAB_MIGRATION_LOCK_KEY}) AS migration_lock_acquired \\gset`);
    expect(sql.indexOf("\\quit 73")).toBeLessThan(sql.indexOf("CREATE TEMP TABLE migration_expected"));
    expect(sql).toContain(`pg_advisory_unlock(${STRATEGY_LAB_MIGRATION_LOCK_KEY})`);
  });

  it("rejects a changed migration and embedded psql meta-command before spawning", async () => {
    const migration = await read("migrations/0021_strategy_lab_policy_and_artifacts.sql");
    const { createHash } = await import("node:crypto");
    const badHashPlan = "0021_strategy_lab_policy_and_artifacts.sql\t0021_strategy_lab_policy_and_artifacts\t" + "0".repeat(64) + "\tfalse\tself\n";
    await expect(buildLockedMigrationSql({ migrationsDirectory:path.join(root,"migrations"),planText:badHashPlan })).rejects.toThrow("Migration checksum mismatch");
    const temporaryDirectory = await import("node:fs/promises").then(async fs => {
      const directory = await fs.mkdtemp(path.join(process.env.TEMP ?? process.cwd(), "migration-runner-"));
      await fs.writeFile(path.join(directory,"0099_test.sql"), "\\quit 0\n");
      return directory;
    });
    const metaHash = createHash("sha256").update("\\quit 0\n").digest("hex");
    await expect(buildLockedMigrationSql({ migrationsDirectory:temporaryDirectory,planText:`0099_test.sql\t0099_test\t${metaHash}\tfalse\tself\n` })).rejects.toThrow("unsupported psql meta-command");
    await import("node:fs/promises").then(fs => fs.rm(temporaryDirectory,{recursive:true,force:true}));
    expect(migration).not.toContain("\\quit");
  });

  it("ships the single-session runner in the verified release payload", async () => {
    const release = await read("scripts/create-release.sh");
    expect(release).toContain("scripts/run-migrations.mjs");
    expect(release).toContain('cp scripts/run-migrations.mjs "$stage_dir/scripts/run-migrations.mjs"');
    expect(release).toContain('node --check "$stage_dir/scripts/run-migrations.mjs"');
  });
});
