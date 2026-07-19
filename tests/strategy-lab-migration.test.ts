import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStrategyLabRunSchema,
  createStrategyLabSettlementSchema,
  createStrategyLabSnapshotSetSchema,
  updateStrategyLabRunSchema,
} from "@/features/strategy-lab";

const root = new URL("..", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const ids = { t1215: uuid(1), t30: uuid(2), t03: uuid(3), t1215r2: uuid(4), run2Set: uuid(5), run: uuid(10), run2: uuid(11), prediction: uuid(20), prediction2: uuid(21), settlement: uuid(30) };
let db: PGlite;
let fixtureSequence = 3000;

async function rejects(sql: string) {
  await expect(db.exec(sql)).rejects.toBeDefined();
}

function snapshotSql(options: {
  id: string; runId?: string; matchId?: string; matchDate?: string; checkpoint?: string; checkpointAt?: string;
  mode?: string; previous?: string | null; revision?: number; supersedes?: string | null;
  hash?: string; schemaVersion?: number;
}) {
  return `INSERT INTO strategy_lab_snapshot_sets(
    id,run_id,match_id,match_date,checkpoint_type,checkpoint_at,dataset_mode,status,previous_snapshot_set_id,
    revision,supersedes_snapshot_set_id,source_cutoff_at,content_hash,schema_version,completeness,trace_id
  ) VALUES(
    '${options.id}','${options.runId ?? ids.run}','${options.matchId ?? "m1"}','${options.matchDate ?? "20260717"}',
    '${options.checkpoint ?? "T1215"}','${options.checkpointAt ?? "2026-07-17T12:15:00Z"}',
    '${options.mode ?? "strict_asof"}','missing',${options.previous ? `'${options.previous}'` : "NULL"},
    ${options.revision ?? 1},${options.supersedes ? `'${options.supersedes}'` : "NULL"},
    '${options.checkpointAt ?? "2026-07-17T12:15:00Z"}','${options.hash ?? `hash-${options.id}`}',
    ${options.schemaVersion ?? 1},'{"reasonCode":"TEST_FIXTURE"}','trace-${options.id}')`;
}

function runSql(id: string, key: string) {
  return `INSERT INTO strategy_lab_experiment_runs(
    id,run_type,status,dataset_mode,start_date,end_date,dataset_cutoff_at,strategy_versions,
    configuration,code_version,idempotency_key,created_by,trace_id,created_at,updated_at
  ) VALUES('${id}','shadow','pending','strict_asof','20260717','20260717','2026-07-17T12:15:00Z',
    '{"A":"A-v1"}','{}','code-1','${key}','tester','trace-${key}',
    '2026-07-17T11:00:00Z','2026-07-17T11:00:00Z')`;
}

function predictionSql(options: {
  id: string; key: string; runId?: string; snapshot?: string; matchId?: string; matchDate?: string; checkpoint?: string;
}) {
  return `INSERT INTO strategy_lab_predictions(
    id,run_id,match_id,match_date,checkpoint_type,snapshot_set_id,requested_strategy,executed_strategy,
    strategy_version,decision_status,selection,locked_deterministic,reason_code,branch_id,input_hash,
    output_hash,decision_payload,source,idempotency_key,trace_id
  ) VALUES('${options.id}','${options.runId ?? ids.run}','${options.matchId ?? "m1"}','${options.matchDate ?? "20260717"}',
    '${options.checkpoint ?? "T1215"}','${options.snapshot ?? ids.t1215}','A','A','A-v1','recommend','home',
    TRUE,'A_RULE','A-BRANCH','input','output','{}','experiment','${options.key}','trace-${options.key}')`;
}

async function seedPrediction(runId: string, predictionId: string, key: string) {
  const snapshotId = uuid(fixtureSequence++);
  await db.exec(`${runSql(runId, `${key}-run`)};${snapshotSql({ id: snapshotId, runId, hash: `${key}-snapshot` })};${predictionSql({ id: predictionId, key, runId, snapshot: snapshotId })}`);
}

function settlementSql(options: {
  id: string; prediction?: string; revision?: number; supersedes?: string | null; quoteBasis?: "actual" | "theoretical";
  outcome?: string; profit?: string; counted?: boolean; evidence?: string; matchResultId?: number;
  actualQuoteSnapshotId?: number | null;
}) {
  const theoretical = options.quoteBasis === "theoretical";
  const actualQuoteSnapshotId = options.actualQuoteSnapshotId === undefined
    ? theoretical ? null : 1
    : options.actualQuoteSnapshotId;
  return `INSERT INTO strategy_lab_settlements(
    id,prediction_id,revision,match_result_id,actual_quote_snapshot_id,quote_basis,outcome,profit_units,is_counted,
    settlement_basis,evidence,settled_at,settled_by,supersedes,trace_id
  ) VALUES('${options.id}','${options.prediction ?? ids.prediction}',${options.revision ?? 1},${options.matchResultId ?? 1},
    ${actualQuoteSnapshotId === null ? "NULL" : actualQuoteSnapshotId},
    '${theoretical ? "theoretical" : "actual"}','${options.outcome ?? "win"}',${options.profit ?? "0.9"},
    ${options.counted ?? true},'${theoretical ? "theoretical_quote" : "actual_quote"}',
    '${options.evidence ?? (theoretical ? `{"theoreticalQuote":{"home":0.9}}` : `{}`)}',
    NOW(),'tester',${options.supersedes ? `'${options.supersedes}'` : "NULL"},'trace-${options.id}')`;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE schema_migrations(version VARCHAR(100) PRIMARY KEY, description TEXT NOT NULL);
    CREATE TABLE odds_snapshots(
      id SERIAL PRIMARY KEY, match_id VARCHAR(20) NOT NULL, match_date VARCHAR(8) NOT NULL,
      company_id VARCHAR(20) NOT NULL, market_type TEXT NOT NULL, snapshot_type TEXT NOT NULL,
      source TEXT NOT NULL, odds JSONB NOT NULL, source_observed_at TIMESTAMPTZ,
      collected_at TIMESTAMPTZ NOT NULL, content_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE strategy_versions(version TEXT PRIMARY KEY);
    CREATE TABLE prediction_results(id SERIAL PRIMARY KEY);
    CREATE TABLE match_results(id SERIAL PRIMARY KEY, match_id VARCHAR(20) NOT NULL, match_date VARCHAR(8) NOT NULL);
  `);
  await db.exec(await read("migrations/0020_strategy_lab_fact_model.sql"));
  await db.exec(`
    INSERT INTO strategy_versions(version) VALUES('A-v1'),('C-v1');
    INSERT INTO odds_snapshots(match_id,match_date,company_id,market_type,snapshot_type,source,odds,source_observed_at,collected_at,content_hash,idempotency_key)
    VALUES('m1','20260717','3','handicap','live','source','{}','2026-07-17T11:59:00Z','2026-07-17T12:00:00Z','h1','odds-1'),
          ('m1','20260717','3','handicap','live','source','{}','2026-07-17T12:16:00Z','2026-07-17T12:16:00Z','h2','odds-2'),
          ('m2','20260717','3','handicap','live','source','{}','2026-07-17T12:16:00Z','2026-07-17T12:16:00Z','h3','odds-3'),
          ('m1','20260718','3','handicap','live','source','{}','2026-07-18T12:16:00Z','2026-07-18T12:16:00Z','h4','odds-4');
    INSERT INTO match_results(match_id,match_date) VALUES('m1','20260717'),('m2','20260717'),('m1','20260718');
    ${runSql(ids.run, "run-main")};
    ${runSql(ids.run2, "run-second")};
    ${snapshotSql({ id: ids.t1215, hash: "t1215-v1" })};
    ${snapshotSql({ id: ids.t30, checkpoint: "T30", checkpointAt: "2026-07-17T12:45:00Z", previous: ids.t1215, hash: "t30-v1" })};
    ${snapshotSql({ id: ids.t03, checkpoint: "T03", checkpointAt: "2026-07-17T12:57:00Z", previous: ids.t30, hash: "t03-v1" })};
    ${snapshotSql({ id: ids.run2Set, runId: ids.run2, hash: "run2-t1215-v1" })};
    ${predictionSql({ id: ids.prediction, key: "prediction-main" })};
    ${predictionSql({ id: ids.prediction2, key: "prediction-second", runId: ids.run2, snapshot: ids.run2Set })};
  `);
}, 30_000);

afterAll(async () => db.close());

describe("strategy lab 0020 manifest and synchronization", () => {
  it("is ordered after 0019 with the exact hash and synchronized representations", async () => {
    const manifest = JSON.parse(await read("migrations/manifest.json"));
    const index = manifest.migrations.findIndex((item: { version: string }) => item.version === "0020_strategy_lab_fact_model");
    const entry = manifest.migrations[index];
    const migration = await read("migrations/0020_strategy_lab_fact_model.sql");
    expect(manifest.migrations[index - 1].file).toBe("0019_backtest_owner_fenced_persistence.sql");
    expect(entry.file).toBe("0020_strategy_lab_fact_model.sql");
    expect(manifest.migrations[index + 1].file).toBe("0021_strategy_lab_policy_and_artifacts.sql");
    expect(entry.sha256).toBe(createHash("sha256").update(migration).digest("hex"));
    const setup = await read("setup-database.sql");
    const schema = await read("src/storage/database/shared/schema.ts");
    for (const table of ["snapshot_sets", "snapshot_items", "experiment_runs", "predictions", "settlements", "command_receipts"]) {
      expect(setup).toContain(`CREATE TABLE IF NOT EXISTS strategy_lab_${table}`);
      expect(schema).toContain(`"strategy_lab_${table}"`);
      expect(setup).toContain(`ALTER TABLE strategy_lab_${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(setup).not.toMatch(/CREATE POLICY[^;]+strategy_lab_/i);
  });
});

describe("snapshot checkpoint and revision chains", () => {
  it("accepts the strict T1215 to T30 to T03 checkpoint chain", async () => {
    const rows = await db.query<{ checkpoint_type: string }>(
      "SELECT checkpoint_type FROM strategy_lab_snapshot_sets WHERE id=ANY($1) ORDER BY checkpoint_at",
      [[ids.t1215, ids.t30, ids.t03]],
    );
    expect(rows.rows.map(row => row.checkpoint_type)).toEqual(["T1215", "T30", "T03"]);
  });

  it.each([
    ["self previous", { id: uuid(100), previous: uuid(100) }],
    ["T1215 previous", { id: uuid(101), previous: ids.t1215 }],
    ["missing T30 previous", { id: uuid(102), checkpoint: "T30", checkpointAt: "2026-07-17T12:46:00Z" }],
    ["T03 directly from T1215", { id: uuid(103), checkpoint: "T03", checkpointAt: "2026-07-17T12:58:00Z", previous: ids.t1215 }],
    ["cross match", { id: uuid(104), matchId: "m2", checkpoint: "T30", checkpointAt: "2026-07-17T12:46:00Z", previous: ids.t1215 }],
    ["cross date", { id: uuid(105), matchDate: "20260718", checkpoint: "T30", checkpointAt: "2026-07-17T12:46:00Z", previous: ids.t1215 }],
    ["cross mode", { id: uuid(106), mode: "reconstructed", checkpoint: "T30", checkpointAt: "2026-07-17T12:46:00Z", previous: ids.t1215 }],
    ["reverse time", { id: uuid(107), checkpoint: "T30", checkpointAt: "2026-07-17T12:14:00Z", previous: ids.t1215 }],
  ])("rejects invalid previous chain: %s", async (_name, options) => rejects(snapshotSql(options)));

  it("accepts revision 1 to 2 and rejects missing, skipped, cross-logical and branched revisions", async () => {
    await db.exec(snapshotSql({ id: ids.t1215r2, revision: 2, supersedes: ids.t1215, hash: "t1215-v2" }));
    await rejects(snapshotSql({ id: uuid(110), revision: 2, hash: "missing-super" }));
    await rejects(snapshotSql({ id: uuid(116), revision: 2, supersedes: uuid(116), hash: "self-super" }));
    await rejects(snapshotSql({ id: uuid(111), revision: 3, supersedes: ids.t1215, hash: "skip" }));
    await rejects(snapshotSql({ id: uuid(112), checkpointAt: "2026-07-17T12:16:00Z", revision: 2, supersedes: ids.t1215, hash: "cross-logical" }));
    await rejects(snapshotSql({ id: uuid(113), revision: 2, supersedes: ids.t1215, hash: "branch" }));
    await rejects(snapshotSql({ id: uuid(114), revision: 1, hash: "parallel-different-hash" }));
    await rejects(snapshotSql({ id: uuid(115), revision: 3, supersedes: ids.t1215r2, hash: "t1215-v2" }));
  });
});

describe("prediction snapshot identity", () => {
  it.each([
    ["match", { id: uuid(201), key: "cross-match", matchId: "m2" }],
    ["date", { id: uuid(202), key: "cross-date", matchDate: "20260718" }],
    ["checkpoint", { id: uuid(203), key: "cross-checkpoint", checkpoint: "T30" }],
  ])("rejects a prediction with mismatched snapshot %s", async (_name, options) => rejects(predictionSql(options)));
});

describe("settlement evidence, outcomes and revisions", () => {
  it("uses the same real match result for actual and theoretical quotes while separating quote evidence", async () => {
    await db.exec(settlementSql({ id: ids.settlement }));
    await db.exec(settlementSql({ id: uuid(31), prediction: ids.prediction2, quoteBasis: "theoretical", matchResultId: 1 }));
    const rows = await db.query<{ quote_basis: string; match_result_id: number }>(
      "SELECT quote_basis,match_result_id FROM strategy_lab_settlements WHERE id=ANY($1) ORDER BY quote_basis",
      [[ids.settlement, uuid(31)]],
    );
    expect(rows.rows).toEqual([
      { quote_basis: "actual", match_result_id: 1 },
      { quote_basis: "theoretical", match_result_id: 1 },
    ]);
  });

  it.each([
    ["actual missing physical quote", { id: uuid(301), actualQuoteSnapshotId: null }],
    ["actual redundant JSON identity", { id: uuid(302), evidence: `{"actualQuoteSnapshotId":"q"}` }],
    ["actual contaminated", { id: uuid(306), evidence: `{"theoreticalQuote":{"home":1}}` }],
    ["theoretical missing quote", { id: uuid(303), quoteBasis: "theoretical" as const, evidence: "{}" }],
    ["theoretical empty quote", { id: uuid(304), quoteBasis: "theoretical" as const, evidence: `{"theoreticalQuote":{}}` }],
    ["theoretical contaminated JSON", { id: uuid(305), quoteBasis: "theoretical" as const, evidence: `{"theoreticalQuote":{"home":1},"actualQuoteSnapshotId":"q"}` }],
    ["theoretical physical actual quote", { id: uuid(307), quoteBasis: "theoretical" as const, actualQuoteSnapshotId: 1 }],
  ])("rejects quote evidence violation: %s", async (_name, options) => {
    const prediction = uuid(600 + Number(options.id.slice(-3)));
    const run = uuid(1600 + Number(options.id.slice(-3)));
    await seedPrediction(run, prediction, `evidence-${options.id}`);
    await rejects(settlementSql({ ...options, prediction }));
  });

  it.each([
    ["result cross match", { id: uuid(308), matchResultId: 2 }],
    ["result cross date", { id: uuid(309), matchResultId: 3 }],
    ["actual quote cross match", { id: uuid(310), actualQuoteSnapshotId: 3 }],
    ["actual quote cross date", { id: uuid(311), actualQuoteSnapshotId: 4 }],
  ])("rejects settlement identity mismatch: %s", async (_name, options) => {
    const run = uuid(1800 + Number(options.id.slice(-3)));
    const prediction = uuid(800 + Number(options.id.slice(-3)));
    await seedPrediction(run, prediction, `identity-${options.id}`);
    await rejects(settlementSql({ ...options, prediction }));
  });

  it("enforces the complete outcome/count/profit matrix", async () => {
    const legal = [["win", "0.8"], ["half_win", "0.4"], ["push", "0"], ["half_loss", "-0.5"], ["loss", "-1"]] as const;
    for (const [index, [outcome, profit]] of legal.entries()) {
      const legalRun = uuid(1750 + index);
      const legalPrediction = uuid(750 + index);
      await seedPrediction(legalRun, legalPrediction, `legal-sign-${outcome}`);
      await db.exec(settlementSql({ id: uuid(360 + index), prediction: legalPrediction, outcome, profit }));
      const uncountedPrediction = uuid(700 + index);
      const nullProfitPrediction = uuid(710 + index);
      const uncountedRun = uuid(1700 + index);
      const nullProfitRun = uuid(1710 + index);
      await seedPrediction(uncountedRun, uncountedPrediction, `uncounted-${outcome}`);
      await seedPrediction(nullProfitRun, nullProfitPrediction, `null-profit-${outcome}`);
      await rejects(settlementSql({ id: uuid(320 + index), prediction: uncountedPrediction, outcome, counted: false }));
      await rejects(settlementSql({ id: uuid(330 + index), prediction: nullProfitPrediction, outcome, profit: "NULL" }));
    }
    const unavailableProfitPrediction = uuid(720);
    const unavailableCountedPrediction = uuid(721);
    await seedPrediction(uuid(1720), unavailableProfitPrediction, "unavailable-profit");
    await seedPrediction(uuid(1721), unavailableCountedPrediction, "unavailable-counted");
    await rejects(settlementSql({ id: uuid(340), prediction: unavailableProfitPrediction, outcome: "unavailable", profit: "0", counted: false }));
    await rejects(settlementSql({ id: uuid(341), prediction: unavailableCountedPrediction, outcome: "unavailable", profit: "NULL", counted: true }));

    const invalidSigns = [
      ["win", "-0.1"], ["half_win", "0"], ["half_win", "-0.1"], ["push", "0.1"],
      ["push", "-0.1"], ["half_loss", "0"], ["half_loss", "0.1"], ["loss", "0"], ["loss", "0.1"],
    ] as const;
    for (const [index, [outcome, profit]] of invalidSigns.entries()) {
      const run = uuid(1760 + index);
      const prediction = uuid(760 + index);
      await seedPrediction(run, prediction, `invalid-sign-${index}`);
      await rejects(settlementSql({ id: uuid(370 + index), prediction, outcome, profit }));
    }
  });

  it("accepts revision 1 to 2 and rejects cross-prediction, skips and forks", async () => {
    const second = uuid(350);
    await db.exec(settlementSql({ id: second, revision: 2, supersedes: ids.settlement, outcome: "loss", profit: "-1" }));
    await rejects(settlementSql({ id: uuid(351), revision: 2, supersedes: null }));
    await rejects(settlementSql({ id: uuid(356), revision: 2, supersedes: uuid(356) }));
    await rejects(settlementSql({ id: uuid(352), revision: 3, supersedes: ids.settlement }));
    await rejects(settlementSql({ id: uuid(353), prediction: ids.prediction2, revision: 2, supersedes: ids.settlement, quoteBasis: "theoretical" }));
    await rejects(settlementSql({ id: uuid(354), revision: 2, supersedes: ids.settlement }));
    await rejects(settlementSql({ id: uuid(355), revision: 1, supersedes: ids.settlement }));
  });
});

describe("experiment run state machine", () => {
  it("accepts every legal transition", async () => {
    const cases = [
      [uuid(401), "running", "succeeded"], [uuid(402), "running", "failed"],
      [uuid(403), "running", "cancelled"], [uuid(404), "pending", "cancelled"],
    ] as const;
    for (const [id, first, terminal] of cases) {
      await db.exec(runSql(id, `run-${id}`));
      if (first === "running") {
        await db.exec(`UPDATE strategy_lab_experiment_runs SET status='running',started_at='2026-07-17T11:01:00Z',updated_at='2026-07-17T11:01:00Z' WHERE id='${id}' AND status='pending'`);
        await db.exec(`UPDATE strategy_lab_experiment_runs SET status='${terminal}',finished_at='2026-07-17T11:02:00Z',updated_at='2026-07-17T11:02:00Z' WHERE id='${id}' AND status='running'`);
      } else {
        await db.exec(`UPDATE strategy_lab_experiment_runs SET status='cancelled',finished_at='2026-07-17T11:01:00Z',updated_at='2026-07-17T11:01:00Z' WHERE id='${id}' AND status='pending'`);
      }
    }
  });

  it("rejects illegal jumps, malformed times, immutable changes and terminal mutation", async () => {
    const pending = uuid(410); await db.exec(runSql(pending, "run-pending-invalid"));
    await rejects(`UPDATE strategy_lab_experiment_runs SET status='succeeded',started_at='2026-07-17T11:01:00Z',finished_at='2026-07-17T11:02:00Z',updated_at='2026-07-17T11:02:00Z' WHERE id='${pending}'`);
    await rejects(`UPDATE strategy_lab_experiment_runs SET status='running' WHERE id='${pending}'`);
    await rejects(`UPDATE strategy_lab_experiment_runs SET status='cancelled',finished_at='2026-07-17T11:01:00Z',updated_at='2026-07-17T11:01:00Z',code_version='changed' WHERE id='${pending}'`);
    const started = uuid(413); await db.exec(runSql(started, "run-started"));
    await db.exec(`UPDATE strategy_lab_experiment_runs SET status='running',started_at='2026-07-17T11:01:00Z',updated_at='2026-07-17T11:01:00Z' WHERE id='${started}'`);
    await rejects(`UPDATE strategy_lab_experiment_runs SET status='succeeded',started_at='2026-07-17T11:02:00Z',finished_at='2026-07-17T11:03:00Z',updated_at='2026-07-17T11:03:00Z' WHERE id='${started}'`);
    const terminal = uuid(411); await db.exec(runSql(terminal, "run-terminal"));
    await db.exec(`UPDATE strategy_lab_experiment_runs SET status='cancelled',finished_at='2026-07-17T11:01:00Z',updated_at='2026-07-17T11:01:00Z' WHERE id='${terminal}'`);
    await rejects(`UPDATE strategy_lab_experiment_runs SET status='cancelled',updated_at='2026-07-17T11:02:00Z' WHERE id='${terminal}'`);
    await rejects(`INSERT INTO strategy_lab_experiment_runs(id,run_type,status,dataset_mode,start_date,end_date,dataset_cutoff_at,strategy_versions,configuration,code_version,idempotency_key,created_by,trace_id,finished_at)
      VALUES('${uuid(412)}','shadow','cancelled','strict_asof','20260717','20260717',NOW(),'{}','{}','c','direct-terminal','x','t',NOW())`);
  });

  it("enforces absolute and monotonic lifecycle timestamps", async () => {
    await rejects(`INSERT INTO strategy_lab_experiment_runs(
      id,run_type,status,dataset_mode,start_date,end_date,dataset_cutoff_at,strategy_versions,configuration,
      code_version,idempotency_key,created_by,trace_id,created_at,updated_at
    ) VALUES('${uuid(420)}','shadow','pending','strict_asof','20260717','20260717','2026-07-17T10:00:00Z',
      '{}','{}','c','early-insert','x','t','2026-07-17T11:00:00Z','2026-07-17T10:59:00Z')`);
    const earlyStart = uuid(421); await db.exec(runSql(earlyStart, "early-start"));
    await rejects(`UPDATE strategy_lab_experiment_runs SET status='running',started_at='2026-07-17T10:59:00Z',updated_at='2026-07-17T11:01:00Z' WHERE id='${earlyStart}'`);
    const backwards = uuid(422); await db.exec(runSql(backwards, "backwards-updated"));
    await rejects(`UPDATE strategy_lab_experiment_runs SET status='running',started_at='2026-07-17T11:01:00Z',updated_at='2026-07-17T10:59:00Z' WHERE id='${backwards}'`);
    const terminalTime = uuid(423); await db.exec(runSql(terminalTime, "terminal-time"));
    await db.exec(`UPDATE strategy_lab_experiment_runs SET status='running',started_at='2026-07-17T11:01:00Z',updated_at='2026-07-17T11:01:00Z' WHERE id='${terminalTime}'`);
    await rejects(`UPDATE strategy_lab_experiment_runs SET status='succeeded',finished_at='2026-07-17T11:03:00Z',updated_at='2026-07-17T11:02:00Z' WHERE id='${terminalTime}'`);
    await db.exec(`UPDATE strategy_lab_experiment_runs SET status='succeeded',finished_at='2026-07-17T11:03:00Z',updated_at='2026-07-17T11:03:00Z' WHERE id='${terminalTime}'`);
  });
});

describe("strategy lab persistence Zod contracts", () => {
  const snapshot = {
    id: uuid(501), runId: ids.run, matchId: "m1", matchDate: "20260717", checkpointType: "T1215",
    checkpointAt: "2026-07-17T12:15:00Z", datasetMode: "strict_asof", status: "ready",
    previousSnapshotSetId: null, revision: 1, supersedesSnapshotSetId: null,
    sourceCutoffAt: "2026-07-17T12:15:00Z", contentHash: "hash", schemaVersion: 1,
    completeness: {}, traceId: "trace",
  };
  const actual = {
    id: uuid(510), predictionId: ids.prediction, revision: 1, matchResultId: 1,
    actualQuoteSnapshotId: 1,
    quoteBasis: "actual", outcome: "win", profitUnits: 0.9, isCounted: true,
    settlementBasis: "actual_quote", evidence: {},
    settledAt: "2026-07-17T15:00:00Z", settledBy: "tester", supersedes: null, traceId: "trace",
  };

  it("validates snapshot self references, checkpoint shape, revision shape and strict cutoff", () => {
    expect(createStrategyLabSnapshotSetSchema.safeParse(snapshot).success).toBe(true);
    expect(createStrategyLabSnapshotSetSchema.safeParse({ ...snapshot, previousSnapshotSetId: snapshot.id }).success).toBe(false);
    expect(createStrategyLabSnapshotSetSchema.safeParse({ ...snapshot, supersedesSnapshotSetId: snapshot.id, revision: 2 }).success).toBe(false);
    expect(createStrategyLabSnapshotSetSchema.safeParse({ ...snapshot, checkpointType: "T30" }).success).toBe(false);
    expect(createStrategyLabSnapshotSetSchema.safeParse({ ...snapshot, revision: 2 }).success).toBe(false);
    expect(createStrategyLabSnapshotSetSchema.safeParse({ ...snapshot, sourceCutoffAt: "2026-07-17T12:16:00Z" }).success).toBe(false);
  });

  it("validates actual/theoretical evidence, real result identity and outcome counting", () => {
    expect(createStrategyLabSettlementSchema.safeParse(actual).success).toBe(true);
    expect(createStrategyLabSettlementSchema.safeParse({ ...actual, actualQuoteSnapshotId: null }).success).toBe(false);
    expect(createStrategyLabSettlementSchema.safeParse({ ...actual, evidence: { actualQuoteSnapshotId: "q" } }).success).toBe(false);
    expect(createStrategyLabSettlementSchema.safeParse({ ...actual, evidence: { theoreticalQuote: { home: 1 } } }).success).toBe(false);
    const theoretical = { ...actual, actualQuoteSnapshotId: null, quoteBasis: "theoretical", settlementBasis: "theoretical_quote", evidence: { theoreticalQuote: { home: 0.9 } } };
    expect(createStrategyLabSettlementSchema.safeParse(theoretical).success).toBe(true);
    expect(createStrategyLabSettlementSchema.safeParse({ ...theoretical, matchResultId: null }).success).toBe(false);
    expect(createStrategyLabSettlementSchema.safeParse({ ...actual, isCounted: false }).success).toBe(false);
    expect(createStrategyLabSettlementSchema.safeParse({ ...actual, outcome: "unavailable", profitUnits: null, isCounted: false }).success).toBe(true);
    expect(createStrategyLabSettlementSchema.safeParse({ ...actual, revision: 2, supersedes: null }).success).toBe(false);
    for (const [outcome, profit] of [["win", 0.8], ["half_win", 0.4], ["push", 0], ["half_loss", -0.5], ["loss", -1]] as const) {
      expect(createStrategyLabSettlementSchema.safeParse({ ...actual, outcome, profitUnits: profit }).success).toBe(true);
    }
    for (const [outcome, profit] of [
      ["win", -0.1], ["half_win", 0], ["half_win", -0.1], ["push", 0.1], ["push", -0.1],
      ["half_loss", 0], ["half_loss", 0.1], ["loss", 0], ["loss", 0.1],
    ] as const) {
      expect(createStrategyLabSettlementSchema.safeParse({ ...actual, outcome, profitUnits: profit }).success).toBe(false);
    }
  });

  it("exposes only legal compare-and-set run transitions", () => {
    const running = {
      id: uuid(520), transition: "pending_to_running", expectedCurrentStatus: "pending",
      status: "running", errorSummary: null, createdAt: "2026-07-17T11:00:00Z",
      previousUpdatedAt: "2026-07-17T11:00:00Z", updatedAt: "2026-07-17T11:01:00Z",
      startedAt: "2026-07-17T11:01:00Z", finishedAt: null,
    };
    expect(updateStrategyLabRunSchema.safeParse(running).success).toBe(true);
    expect(updateStrategyLabRunSchema.safeParse({ ...running, expectedCurrentStatus: "running" }).success).toBe(false);
    expect(updateStrategyLabRunSchema.safeParse({ ...running, status: "succeeded" }).success).toBe(false);
    expect(updateStrategyLabRunSchema.safeParse({ ...running, finishedAt: "2026-07-17T12:01:00Z" }).success).toBe(false);
    expect(updateStrategyLabRunSchema.safeParse({ ...running, startedAt: "2026-07-17T10:59:00Z" }).success).toBe(false);
    expect(updateStrategyLabRunSchema.safeParse({ ...running, updatedAt: "2026-07-17T10:59:00Z" }).success).toBe(false);
    expect(createStrategyLabRunSchema.safeParse({
      id: uuid(521), runType: "shadow", status: "running", datasetMode: "strict_asof",
      startDate: "20260717", endDate: "20260717", datasetCutoffAt: "2026-07-17T12:00:00Z",
      strategyVersions: {}, configuration: {}, codeVersion: "c", idempotencyKey: "k", createdBy: "x", traceId: "t",
    }).success).toBe(false);
  });
});

describe("strategy lab command receipts and snapshot item completeness", () => {
  it("allows empty incomplete snapshots with reason but rejects empty ready/partial snapshots", async () => {
    await db.exec(snapshotSql({ id: uuid(6000), checkpointAt: "2026-07-17T12:19:00Z", hash: "empty-missing" }));
    await rejects(`INSERT INTO strategy_lab_snapshot_sets(
      id,run_id,match_id,match_date,checkpoint_type,checkpoint_at,dataset_mode,status,previous_snapshot_set_id,
      revision,supersedes_snapshot_set_id,source_cutoff_at,content_hash,schema_version,completeness,trace_id
    ) VALUES('${uuid(6001)}','${ids.run}','m1','20260717','T1215','2026-07-17T12:20:00Z','strict_asof',
      'ready',NULL,1,NULL,'2026-07-17T12:20:00Z','empty-ready',1,'{}','trace-empty-ready')`);
    await rejects(`INSERT INTO strategy_lab_snapshot_sets(
      id,run_id,match_id,match_date,checkpoint_type,checkpoint_at,dataset_mode,status,previous_snapshot_set_id,
      revision,supersedes_snapshot_set_id,source_cutoff_at,content_hash,schema_version,completeness,trace_id
    ) VALUES('${uuid(6002)}','${ids.run}','m1','20260717','T1215','2026-07-17T12:21:00Z','strict_asof',
      'insufficient',NULL,1,NULL,'2026-07-17T12:21:00Z','empty-no-reason',1,'{}','trace-empty-reason')`);
  });

  it("enforces receipt idempotency, payload conflicts, and controlled audit states", async () => {
    await db.exec(`INSERT INTO strategy_lab_command_receipts(
      id,action,operation_key,payload_hash,status,result_type,result_id,actor_id,request_id
    ) VALUES('${uuid(6100)}','run.create','receipt-key','${"a".repeat(64)}','audit_pending','strategy_lab_run','${ids.run}','admin','request')`);
    await rejects(`INSERT INTO strategy_lab_command_receipts(
      id,action,operation_key,payload_hash,status,result_type,result_id,actor_id,request_id
    ) VALUES('${uuid(6101)}','run.create','receipt-key','${"a".repeat(64)}','audit_pending','strategy_lab_run','${ids.run}','admin','request')`);
    await rejects(`INSERT INTO strategy_lab_command_receipts(
      id,action,operation_key,payload_hash,status,result_type,result_id,actor_id,request_id
    ) VALUES('${uuid(6102)}','run.create','receipt-key','${"b".repeat(64)}','audit_pending','strategy_lab_run','${ids.run}','admin','request')`);
    await rejects(`UPDATE strategy_lab_command_receipts SET actor_id='forged' WHERE id='${uuid(6100)}'`);
    await db.exec(`UPDATE strategy_lab_command_receipts SET status='audit_pending',audit_attempts=1,
      last_audit_error_code='AUDIT_UNAVAILABLE',updated_at=NOW() WHERE id='${uuid(6100)}'`);
    await db.exec(`UPDATE strategy_lab_command_receipts SET status='audited',audit_attempts=2,
      last_audit_error_code=NULL,audited_at=NOW(),updated_at=NOW() WHERE id='${uuid(6100)}'`);
    await rejects(`UPDATE strategy_lab_command_receipts SET status='audit_pending',audit_attempts=3,
      last_audit_error_code='REOPEN',audited_at=NULL,updated_at=NOW() WHERE id='${uuid(6100)}'`);
    const row = await db.query<{ status: string; audit_attempts: number }>("SELECT status,audit_attempts FROM strategy_lab_command_receipts WHERE id=$1", [uuid(6100)]);
    expect(row.rows[0]).toEqual({ status: "audited", audit_attempts: 2 });
  });

  it("restricts result types and enables receipt RLS", async () => {
    await rejects(`INSERT INTO strategy_lab_command_receipts(
      id,action,operation_key,payload_hash,status,result_type,result_id,actor_id,request_id
    ) VALUES('${uuid(6200)}','run.create','bad-result','${"c".repeat(64)}','audit_pending','arbitrary_table','${ids.run}','admin','request')`);
    const rls = await db.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE relname='strategy_lab_command_receipts'");
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
  });
});
