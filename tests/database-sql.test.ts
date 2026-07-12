import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
let setupSql: string;
let migrationSql: string;
let freshnessMigrationSql: string;
let analyzedAtMigrationSql: string;
let verificationColumnsMigrationSql: string;
let matchT30MigrationSql: string;
let settlementMigrationSql: string;
let weightedLearningMigrationSql: string;
let databases: PGlite[] = [];

async function createDatabase() {
  const database = new PGlite();
  databases.push(database);
  return database;
}

beforeAll(async () => {
  [setupSql, migrationSql, freshnessMigrationSql, analyzedAtMigrationSql, verificationColumnsMigrationSql, matchT30MigrationSql, settlementMigrationSql, weightedLearningMigrationSql] = await Promise.all([
    readFile(`${projectRoot}/setup-database.sql`, "utf8"),
    readFile(`${projectRoot}/migrations/0001_production_baseline.sql`, "utf8"),
    readFile(`${projectRoot}/migrations/0002_match_odds_freshness.sql`, "utf8"),
    readFile(`${projectRoot}/migrations/0003_prediction_analyzed_at.sql`, "utf8"),
    readFile(`${projectRoot}/migrations/0004_prediction_verification_columns.sql`, "utf8"),
    readFile(`${projectRoot}/migrations/0005_match_t30_analysis.sql`, "utf8"),
    readFile(`${projectRoot}/migrations/0006_market_settlement_evidence.sql`, "utf8"),
    readFile(`${projectRoot}/migrations/0007_weighted_learning_samples.sql`, "utf8"),
  ]);
});

afterEach(async () => {
  await Promise.all(databases.map((database) => database.close()));
  databases = [];
});

describe("PostgreSQL schema bootstrap", () => {
  it("runs twice on an empty database and creates the canonical tables and fields", async () => {
    const database = await createDatabase();

    await database.exec(setupSql);
    await database.exec(setupSql);

    const tables = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(ARRAY[
          'prediction_data', 'daily_reports', 'match_odds', 'prediction_results',
          'prediction_results_backtest', 'learned_patterns', 'learned_patterns_backtest',
          'strategy_versions', 'automation_tasks', 'automation_task_steps',
          'odds_snapshots', 'data_quality_records', 'audit_logs', 'match_results',
          'migration_duplicate_archive', 'schema_migrations'
        ])
      ORDER BY table_name
    `);
    expect(tables.rows.map(({ table_name }) => table_name)).toHaveLength(16);

    const requiredColumns = await database.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('prediction_data', 'date_key'),
          ('daily_reports', 'report_date'),
          ('match_odds', 'match_date'),
          ('match_odds', 'source'),
          ('match_odds', 'source_observed_at'),
          ('match_odds', 'write_token'),
          ('prediction_results', 'strategy_version'),
          ('prediction_results', 'weights_snapshot'),
          ('prediction_results', 'analyzed_at'),
          ('prediction_results', 'manual_is_correct'),
          ('prediction_results', 'effective_is_correct'),
          ('prediction_results', 'verification_status'),
          ('prediction_results', 'water_verification_status'),
          ('prediction_results', 'total_verification_status'),
          ('prediction_results', 'effective_verification_status'),
          ('prediction_results', 'auto_is_correct'),
          ('prediction_results', 'actual_handicap_trend'),
          ('prediction_results', 'actual_water_direction'),
          ('prediction_results', 'auto_verified_at'),
          ('prediction_results', 'manually_verified_at'),
          ('prediction_results', 'manually_verified_by'),
          ('prediction_results', 'verified_at'),
          ('prediction_results_backtest', 'run_id'),
          ('prediction_results_backtest', 'analyzed_at'),
          ('prediction_results_backtest', 'manual_is_correct'),
          ('prediction_results_backtest', 'effective_is_correct'),
          ('prediction_results_backtest', 'verification_status'),
          ('prediction_results_backtest', 'water_verification_status'),
          ('prediction_results_backtest', 'total_verification_status'),
          ('prediction_results_backtest', 'effective_verification_status'),
          ('prediction_results_backtest', 'auto_is_correct'),
          ('prediction_results_backtest', 'actual_handicap_trend'),
          ('prediction_results_backtest', 'actual_water_direction'),
          ('prediction_results_backtest', 'auto_verified_at'),
          ('prediction_results_backtest', 'manually_verified_at'),
          ('prediction_results_backtest', 'manually_verified_by'),
          ('prediction_results_backtest', 'verified_at'),
          ('learned_patterns', 'training_window_start'),
          ('automation_tasks', 'idempotency_key'),
          ('odds_snapshots', 'content_hash'),
          ('data_quality_records', 'completeness_score')
        )
    `);
    expect(requiredColumns.rows).toHaveLength(41);

    const uniqueIndexes = await database.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY(ARRAY[
          'prediction_data_date_key_unique',
          'daily_reports_report_date_unique',
          'match_odds_match_date_id_unique',
          'prediction_results_match_date_unique',
          'automation_tasks_idempotency_unique',
          'automation_tasks_single_running_analysis',
          'odds_snapshots_idempotency_unique'
        ])
    `);
    expect(uniqueIndexes.rows).toHaveLength(7);

    await expect(database.exec(`
      INSERT INTO prediction_data(date_key, json_content) VALUES ('20260230', '{}')
    `)).rejects.toThrow();
  });

  it("enforces idempotent upserts for the core natural keys", async () => {
    const database = await createDatabase();
    await database.exec(setupSql);

    await database.exec(`
      INSERT INTO prediction_data(date_key, json_content)
      VALUES ('20260710', '{"revision":1}')
      ON CONFLICT (date_key) DO UPDATE
      SET json_content = EXCLUDED.json_content, updated_at = NOW();
      INSERT INTO prediction_data(date_key, json_content)
      VALUES ('20260710', '{"revision":2}')
      ON CONFLICT (date_key) DO UPDATE
      SET json_content = EXCLUDED.json_content, updated_at = NOW();

      INSERT INTO daily_reports(report_date, report_content)
      VALUES ('20260710', 'first')
      ON CONFLICT (report_date) DO UPDATE
      SET report_content = EXCLUDED.report_content, updated_at = NOW();
      INSERT INTO daily_reports(report_date, report_content)
      VALUES ('20260710', 'second')
      ON CONFLICT (report_date) DO UPDATE
      SET report_content = EXCLUDED.report_content, updated_at = NOW();

      INSERT INTO match_odds(match_id, match_date, odds_data)
      VALUES ('match-1', '20260710', '{"revision":1}')
      ON CONFLICT (match_id, match_date) DO UPDATE
      SET odds_data = EXCLUDED.odds_data, updated_at = NOW();
      INSERT INTO match_odds(match_id, match_date, odds_data)
      VALUES ('match-1', '20260710', '{"revision":2}')
      ON CONFLICT (match_id, match_date) DO UPDATE
      SET odds_data = EXCLUDED.odds_data, updated_at = NOW();
    `);

    const result = await database.query<{
      prediction_count: number;
      prediction_content: string;
      report_count: number;
      report_content: string;
      odds_count: number;
      odds_content: string;
    }>(`
      SELECT
        (SELECT COUNT(*)::int FROM prediction_data) AS prediction_count,
        (SELECT json_content FROM prediction_data) AS prediction_content,
        (SELECT COUNT(*)::int FROM daily_reports) AS report_count,
        (SELECT report_content FROM daily_reports) AS report_content,
        (SELECT COUNT(*)::int FROM match_odds) AS odds_count,
        (SELECT odds_data FROM match_odds) AS odds_content
    `);

    expect(result.rows[0]).toEqual({
      prediction_count: 1,
      prediction_content: '{"revision":2}',
      report_count: 1,
      report_content: "second",
      odds_count: 1,
      odds_content: '{"revision":2}',
    });
  });
});

describe("match odds freshness migration", () => {
  it("accepts newer writes, rejects stale writes, and treats token replay as applied", async () => {
    const database = await createDatabase();
    await database.exec(setupSql);

    const upsert = async (revision: number, observedAt: string, token: string) => {
      const result = await database.query<{ applied: boolean }>(`
        SELECT applied
        FROM upsert_match_odds_if_fresher(
          'match-1', '20260711', '3',
          '{"revision":${revision}}'::jsonb,
          NULL::jsonb, NULL::jsonb, NULL::jsonb,
          'titan-analysis-odds', '${observedAt}'::timestamptz, '${token}'
        )
      `);
      return result.rows[0]?.applied;
    };

    expect(await upsert(1, "2026-07-11T10:00:00Z", "token-new")).toBe(true);
    expect(await upsert(0, "2026-07-11T09:59:59Z", "token-old")).toBe(false);
    expect(await upsert(999, "2026-07-11T10:00:00Z", "token-new")).toBe(true);

    let stored = await database.query<{ revision: string; write_token: string }>(`
      SELECT odds_data::jsonb->>'revision' AS revision, write_token
      FROM match_odds
      WHERE match_id = 'match-1' AND match_date = '20260711'
    `);
    expect(stored.rows[0]).toEqual({ revision: "1", write_token: "token-new" });

    expect(await upsert(2, "2026-07-11T10:00:01Z", "token-newer")).toBe(true);
    stored = await database.query<{ revision: string; write_token: string }>(`
      SELECT odds_data::jsonb->>'revision' AS revision, write_token
      FROM match_odds
      WHERE match_id = 'match-1' AND match_date = '20260711'
    `);
    expect(stored.rows[0]).toEqual({ revision: "2", write_token: "token-newer" });
  });

  it("upgrades a legacy match_odds table idempotently", async () => {
    const database = await createDatabase();
    await database.exec(`
      CREATE TABLE schema_migrations (
        version VARCHAR(100) PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE match_odds (
        id SERIAL PRIMARY KEY,
        match_id VARCHAR(20) NOT NULL,
        match_date VARCHAR(8) NOT NULL,
        company_ids TEXT NOT NULL DEFAULT '3',
        odds_data TEXT NOT NULL,
        open_times_data TEXT,
        crown_live_odds TEXT,
        crown_12_odds TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(match_id, match_date)
      );
    `);

    await database.exec(freshnessMigrationSql);
    await database.exec(freshnessMigrationSql);

    const columns = await database.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'match_odds'
        AND column_name IN ('source', 'source_observed_at', 'write_token')
      ORDER BY column_name
    `);
    expect(columns.rows.map(row => row.column_name)).toEqual([
      "source", "source_observed_at", "write_token",
    ]);
  });
});

describe("prediction analyzed-at migration", () => {
  it("adds nullable timestamps to production and backtest tables idempotently", async () => {
    const database = await createDatabase();
    await database.exec(`
      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE prediction_results (id SERIAL PRIMARY KEY);
      CREATE TABLE prediction_results_backtest (id SERIAL PRIMARY KEY);
    `);

    await database.exec(analyzedAtMigrationSql);
    await database.exec(analyzedAtMigrationSql);

    const columns = await database.query<{ table_name: string; is_nullable: string }>(`
      SELECT table_name, is_nullable
      FROM information_schema.columns
      WHERE table_name IN ('prediction_results', 'prediction_results_backtest')
        AND column_name = 'analyzed_at'
      ORDER BY table_name
    `);
    expect(columns.rows).toEqual([
      { table_name: "prediction_results", is_nullable: "YES" },
      { table_name: "prediction_results_backtest", is_nullable: "YES" },
    ]);
  });
});

describe("prediction verification columns migration", () => {
  it("upgrades legacy production and backtest tables idempotently", async () => {
    const database = await createDatabase();
    await database.exec(`
      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE prediction_results (id SERIAL PRIMARY KEY);
      CREATE TABLE prediction_results_backtest (id SERIAL PRIMARY KEY);
    `);

    await database.exec(verificationColumnsMigrationSql);
    await database.exec(verificationColumnsMigrationSql);

    const columns = await database.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_name IN ('prediction_results', 'prediction_results_backtest')
        AND column_name IN (
          'manual_is_correct', 'effective_is_correct', 'verification_status',
          'water_verification_status', 'total_verification_status',
          'effective_verification_status', 'auto_is_correct',
          'actual_handicap_trend', 'actual_water_direction', 'auto_verified_at',
          'manually_verified_at', 'manually_verified_by', 'verified_at'
        )
      ORDER BY table_name, column_name
    `);
    expect(columns.rows).toHaveLength(26);

    await database.exec(`
      INSERT INTO prediction_results DEFAULT VALUES;
      INSERT INTO prediction_results_backtest DEFAULT VALUES;
    `);

    const defaults = await database.query<{
      table_name: string;
      verification_status: string;
      water_verification_status: string;
      total_verification_status: string;
      effective_verification_status: string;
    }>(`
      SELECT 'prediction_results' AS table_name,
        verification_status, water_verification_status,
        total_verification_status, effective_verification_status
      FROM prediction_results
      UNION ALL
      SELECT 'prediction_results_backtest' AS table_name,
        verification_status, water_verification_status,
        total_verification_status, effective_verification_status
      FROM prediction_results_backtest
      ORDER BY table_name
    `);
    expect(defaults.rows).toEqual([
      {
        table_name: "prediction_results",
        verification_status: "pending",
        water_verification_status: "pending",
        total_verification_status: "pending",
        effective_verification_status: "unverified",
      },
      {
        table_name: "prediction_results_backtest",
        verification_status: "pending",
        water_verification_status: "pending",
        total_verification_status: "pending",
        effective_verification_status: "unverified",
      },
    ]);

    const migrationState = await database.query<{ migration_count: number }>(`
      SELECT COUNT(*)::int AS migration_count
      FROM schema_migrations
      WHERE version = '0004_prediction_verification_columns'
    `);
    expect(migrationState.rows[0]).toEqual({ migration_count: 1 });
  });
});

describe("match T-30 analysis migration", () => {
  it("serializes running analysis tasks and runs idempotently", async () => {
    const database = await createDatabase();
    await database.exec(`
      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE automation_tasks (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        match_id VARCHAR(20),
        current_step TEXT,
        lock_owner TEXT,
        lock_expires_at TIMESTAMPTZ,
        scheduled_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO automation_tasks(id, task_type, status, updated_at) VALUES
        ('older', 'analysis', 'running', '2026-07-11T10:00:00Z'),
        ('newer', 'match-t30-analysis', 'running', '2026-07-11T10:01:00Z');
    `);

    await database.exec(matchT30MigrationSql);
    await database.exec(matchT30MigrationSql);

    const statuses = await database.query<{ id: string; status: string }>(`
      SELECT id, status FROM automation_tasks ORDER BY id
    `);
    expect(statuses.rows).toEqual([
      { id: "newer", status: "running" },
      { id: "older", status: "retrying" },
    ]);

    await expect(database.exec(`
      INSERT INTO automation_tasks(id, task_type, status)
      VALUES ('blocked', 'analysis', 'running')
    `)).rejects.toThrow();
    await database.exec(`
      INSERT INTO automation_tasks(id, task_type, status)
      VALUES ('allowed', 'odds-fetch', 'running')
    `);

    const indexes = await database.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'automation_tasks_single_running_analysis',
        'automation_tasks_match_type_status_idx'
      )
      ORDER BY indexname
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "automation_tasks_match_type_status_idx",
      "automation_tasks_single_running_analysis",
    ]);

    const migrationState = await database.query<{ migration_count: number }>(`
      SELECT COUNT(*)::int AS migration_count
      FROM schema_migrations
      WHERE version = '0005_match_t30_analysis'
    `);
    expect(migrationState.rows[0]).toEqual({ migration_count: 1 });
  });
});

describe("market settlement evidence migration", () => {
  it("runs idempotently and keeps production and backtest settlement fields aligned", async () => {
    const database = await createDatabase();
    await database.exec(setupSql);
    await database.exec(settlementMigrationSql);
    await database.exec(settlementMigrationSql);

    const settlementColumns = await database.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_name IN ('prediction_results', 'prediction_results_backtest')
        AND (
          column_name LIKE 'handicap_%' OR column_name LIKE 'total_%'
          OR column_name IN (
            'prediction_revision', 'actual_score_margin', 'actual_total_goals',
            'probability_output', 'probability_model_version',
            'probability_calibration_version', 'probability_source_observed_at',
            'probability_quality_status'
          )
        )
      ORDER BY table_name, column_name
    `);
    const production = settlementColumns.rows
      .filter((row) => row.table_name === "prediction_results")
      .map((row) => row.column_name);
    const backtest = settlementColumns.rows
      .filter((row) => row.table_name === "prediction_results_backtest")
      .map((row) => row.column_name);
    expect(backtest).toEqual(production);
    expect(production).toEqual(expect.arrayContaining([
      "handicap_auto_outcome", "handicap_auto_is_correct", "handicap_manual_is_correct",
      "handicap_effective_is_correct", "handicap_automatic_status", "handicap_effective_status",
      "handicap_settlement_reason", "handicap_auto_verified_at", "handicap_manual_verified_at",
      "handicap_final_verified_at", "handicap_verified_by", "total_auto_outcome",
      "total_auto_is_correct", "total_manual_is_correct", "total_effective_is_correct",
      "total_automatic_status", "total_effective_status", "total_settlement_reason",
      "total_auto_verified_at", "total_manual_verified_at", "total_final_verified_at",
      "total_verified_by", "probability_output", "probability_quality_status",
    ]));

    const migrationState = await database.query<{ migration_count: number }>(`
      SELECT COUNT(*)::int AS migration_count FROM schema_migrations
      WHERE version = '0006_market_settlement_evidence'
    `);
    expect(migrationState.rows[0]).toEqual({ migration_count: 1 });
  });

  it("enforces result identity and dates without copying legacy correctness into total", async () => {
    const database = await createDatabase();
    await database.exec(setupSql);

    await database.exec(`
      INSERT INTO match_results(match_id, match_date, status, home_score, away_score)
      VALUES ('m1', '20260712', 'settled', 2, 1);
      INSERT INTO prediction_results(match_id, match_date, is_correct)
      VALUES ('m1', '20260712', TRUE);
    `);
    await expect(database.exec(`
      INSERT INTO match_results(match_id, match_date) VALUES ('m1', '20260712')
    `)).rejects.toThrow();
    await expect(database.exec(`
      INSERT INTO match_results(match_id, match_date) VALUES ('m2', '20260230')
    `)).rejects.toThrow();

    const legacy = await database.query<{
      is_correct: boolean;
      total_auto_is_correct: boolean | null;
      total_manual_is_correct: boolean | null;
      probability_output: unknown | null;
      probability_quality_status: string;
    }>(`
      SELECT is_correct, total_auto_is_correct, total_manual_is_correct,
        probability_output, probability_quality_status
      FROM prediction_results WHERE match_id = 'm1'
    `);
    expect(legacy.rows[0]).toEqual({
      is_correct: true,
      total_auto_is_correct: null,
      total_manual_is_correct: null,
      probability_output: null,
      probability_quality_status: "unavailable",
    });
  });

  it("allows the same learned pattern in both markets", async () => {
    const database = await createDatabase();
    await database.exec(setupSql);
    await database.exec(`
      INSERT INTO learned_patterns(pattern_key, league, market)
      VALUES ('late-steam', 'EPL', 'handicap'), ('late-steam', 'EPL', 'total');
      INSERT INTO learned_patterns_backtest(pattern_key, league, market)
      VALUES ('late-steam', 'EPL', 'handicap'), ('late-steam', 'EPL', 'total');
    `);
    const counts = await database.query<{ production: number; backtest: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM learned_patterns WHERE pattern_key = 'late-steam') AS production,
        (SELECT COUNT(*)::int FROM learned_patterns_backtest WHERE pattern_key = 'late-steam') AS backtest
    `);
    expect(counts.rows[0]).toEqual({ production: 2, backtest: 2 });
  });
});

describe("weighted learning samples migration", () => {
  it("stores half-sample totals in both market pattern tables and runs idempotently", async () => {
    const database = await createDatabase();
    await database.exec(setupSql);
    await database.exec(weightedLearningMigrationSql);
    await database.exec(weightedLearningMigrationSql);
    await database.exec(`
      INSERT INTO learned_patterns(pattern_key, league, market, total_predictions, correct_predictions)
      VALUES ('quarter-result', 'EPL', 'handicap', 0.5, 0.5);
      INSERT INTO learned_patterns_backtest(pattern_key, league, market, total_predictions, correct_predictions)
      VALUES ('quarter-result', 'EPL', 'total', 0.5, 0);
    `);

    const values = await database.query<{ production_total: number; production_correct: number; backtest_total: number }>(`
      SELECT
        (SELECT total_predictions FROM learned_patterns WHERE pattern_key = 'quarter-result') AS production_total,
        (SELECT correct_predictions FROM learned_patterns WHERE pattern_key = 'quarter-result') AS production_correct,
        (SELECT total_predictions FROM learned_patterns_backtest WHERE pattern_key = 'quarter-result') AS backtest_total
    `);
    expect(values.rows[0]).toEqual({ production_total: 0.5, production_correct: 0.5, backtest_total: 0.5 });

    const migrationState = await database.query<{ migration_count: number }>(`
      SELECT COUNT(*)::int AS migration_count FROM schema_migrations
      WHERE version = '0007_weighted_learning_samples'
    `);
    expect(migrationState.rows[0]).toEqual({ migration_count: 1 });
  });
});

describe("production baseline migration", () => {
  it("deterministically retains newest legacy rows and archives every discarded duplicate", async () => {
    const database = await createDatabase();
    await database.exec(setupSql);
    await database.exec(`
      DROP INDEX prediction_data_date_key_unique;
      DROP INDEX daily_reports_report_date_unique;
      DROP INDEX match_odds_match_date_id_unique;

      INSERT INTO prediction_data(id, date_key, json_content, updated_at) VALUES
        (101, '20260710', 'old prediction', '2026-07-10T01:00:00Z'),
        (102, '20260710', 'new prediction', '2026-07-10T02:00:00Z');
      INSERT INTO daily_reports(id, report_date, report_content, created_at, updated_at) VALUES
        (201, '20260710', 'old report', '2026-07-10T01:00:00Z', '2026-07-10T01:00:00Z'),
        (202, '20260710', 'new report', '2026-07-10T02:00:00Z', '2026-07-10T02:00:00Z');
      INSERT INTO match_odds(id, match_id, match_date, odds_data, created_at, updated_at) VALUES
        (301, 'match-1', '20260710', 'old odds', '2026-07-10T01:00:00Z', '2026-07-10T01:00:00Z'),
        (302, 'match-1', '20260710', 'new odds', '2026-07-10T02:00:00Z', '2026-07-10T02:00:00Z');
    `);

    await database.exec(migrationSql);
    await database.exec(migrationSql);

    const survivors = await database.query<{
      prediction_id: number;
      report_id: number;
      odds_id: number;
    }>(`
      SELECT
        (SELECT id FROM prediction_data WHERE date_key = '20260710') AS prediction_id,
        (SELECT id FROM daily_reports WHERE report_date = '20260710') AS report_id,
        (SELECT id FROM match_odds WHERE match_id = 'match-1' AND match_date = '20260710') AS odds_id
    `);
    expect(survivors.rows[0]).toEqual({ prediction_id: 102, report_id: 202, odds_id: 302 });

    const archive = await database.query<{
      table_name: string;
      archived_id: string;
      retained_id: string;
      archived_content: string;
    }>(`
      SELECT table_name, archived_id, retained_id,
        CASE table_name
          WHEN 'prediction_data' THEN archived_row->>'json_content'
          WHEN 'daily_reports' THEN archived_row->>'report_content'
          WHEN 'match_odds' THEN archived_row->>'odds_data'
        END AS archived_content
      FROM migration_duplicate_archive
      WHERE migration_version = '0001_production_baseline'
        AND table_name IN ('prediction_data', 'daily_reports', 'match_odds')
      ORDER BY table_name
    `);
    expect(archive.rows).toEqual([
      { table_name: "daily_reports", archived_id: "201", retained_id: "202", archived_content: "old report" },
      { table_name: "match_odds", archived_id: "301", retained_id: "302", archived_content: "old odds" },
      { table_name: "prediction_data", archived_id: "101", retained_id: "102", archived_content: "old prediction" },
    ]);

    const migrationState = await database.query<{ migration_count: number; audit_count: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM schema_migrations WHERE version = '0001_production_baseline') AS migration_count,
        (SELECT COUNT(*)::int FROM audit_logs
          WHERE action = 'migration_duplicate_cleanup' AND object_id = '0001_production_baseline') AS audit_count
    `);
    expect(migrationState.rows[0]).toEqual({ migration_count: 1, audit_count: 1 });

    await expect(database.exec(`
      INSERT INTO prediction_data(date_key, json_content) VALUES ('20260710', 'duplicate')
    `)).rejects.toThrow();
    await expect(database.exec(`
      INSERT INTO daily_reports(report_date, report_content) VALUES ('20260710', 'duplicate')
    `)).rejects.toThrow();
    await expect(database.exec(`
      INSERT INTO match_odds(match_id, match_date, odds_data) VALUES ('match-1', '20260710', 'duplicate')
    `)).rejects.toThrow();
  });

  it("normalizes equivalent date keys before deduplication when a legacy unique constraint exists", async () => {
    const database = await createDatabase();
    await database.exec(setupSql);
    await database.exec(`
      ALTER TABLE daily_reports DROP CONSTRAINT daily_reports_report_date_check;
      ALTER TABLE daily_reports ALTER COLUMN report_date TYPE VARCHAR(20);
      DROP INDEX daily_reports_report_date_unique;
      ALTER TABLE daily_reports
        ADD CONSTRAINT daily_reports_unique_date UNIQUE (report_date);

      INSERT INTO daily_reports(id, report_date, report_content, created_at, updated_at) VALUES
        (401, '20260504', 'compact old report', '2026-05-04T01:00:00Z', '2026-05-04T01:00:00Z'),
        (402, '2026-05-04', 'hyphenated new report', '2026-05-04T02:00:00Z', '2026-05-04T02:00:00Z');
    `);

    await database.exec(migrationSql);
    await database.exec(migrationSql);

    const result = await database.query<{
      report_id: number;
      report_date: string;
      report_content: string;
      legacy_constraint_count: number;
      canonical_index_count: number;
      archived_id: string;
      retained_id: string;
    }>(`
      SELECT
        (SELECT id FROM daily_reports) AS report_id,
        (SELECT report_date FROM daily_reports) AS report_date,
        (SELECT report_content FROM daily_reports) AS report_content,
        (SELECT COUNT(*)::int FROM pg_constraint
          WHERE conrelid = 'daily_reports'::regclass
            AND conname = 'daily_reports_unique_date') AS legacy_constraint_count,
        (SELECT COUNT(*)::int FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'daily_reports_report_date_unique') AS canonical_index_count,
        (SELECT archived_id FROM migration_duplicate_archive
          WHERE migration_version = '0001_production_baseline'
            AND table_name = 'daily_reports') AS archived_id,
        (SELECT retained_id FROM migration_duplicate_archive
          WHERE migration_version = '0001_production_baseline'
            AND table_name = 'daily_reports') AS retained_id
    `);

    expect(result.rows[0]).toEqual({
      report_id: 402,
      report_date: "20260504",
      report_content: "hyphenated new report",
      legacy_constraint_count: 0,
      canonical_index_count: 1,
      archived_id: "401",
      retained_id: "402",
    });
  });
});
