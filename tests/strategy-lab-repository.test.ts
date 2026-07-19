import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  StrategyLabRepositoryError,
  type PredictionCreateCommand,
  type RunCreateCommand,
  type SettlementCreateCommand,
  type SnapshotItemCreateCommand,
  type SnapshotSetCreateCommand,
} from "@/features/strategy-lab";
import {
  PostgresStrategyLabRepository,
  type StrategyLabSqlClient,
  type StrategyLabSqlExecutor,
} from "@/features/strategy-lab/postgres-repository";
import { BUILT_IN_STRATEGY_ARTIFACTS } from "@/features/strategy-lab/strategy-artifacts";
import { canonicalJsonSha256 } from "@/lib/canonical-json";
import { computeMatchResultRevisionHash, computeSettlementEvidenceHash } from "@/features/strategy-lab/settlement-evidence";

const root = new URL("..", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const uuid = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const BASE_RUN_ID = uuid(9000);
const policy={mode:"user_focused_leagues" as const,artifactHash:"a".repeat(64),captureId:uuid(8000),capturedAt:"2026-07-17T12:15:00.000Z",datasetCutoffAt:"2026-07-17T12:15:00.000Z",evidenceHash:"b".repeat(64)};

class PGliteStrategyClient implements StrategyLabSqlClient {
  readonly calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  constructor(private readonly database: PGlite) {}

  async query<Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
    this.calls.push({ sql, parameters });
    const result = await this.database.query<Row>(sql, [...parameters]);
    return { rows: result.rows };
  }

  async transaction<T>(callback: (transaction: StrategyLabSqlExecutor) => Promise<T>): Promise<T> {
    return this.database.transaction(async transaction => callback({
      query: async <Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => {
        this.calls.push({ sql, parameters });
        const result = await transaction.query<Row>(sql, [...parameters]);
        return { rows: result.rows };
      },
    }));
  }
}

let db: PGlite;
let client: PGliteStrategyClient;
let idCounter = 1000;
let snapshotSecond = 0;
let now = new Date("2026-07-17T11:00:00.000Z");
let repository: PostgresStrategyLabRepository;

const nextId = () => uuid(idCounter++);
const tick = (iso: string) => { now = new Date(iso); };

function expectCode(code: StrategyLabRepositoryError["code"]) {
  return (error: unknown) => error instanceof StrategyLabRepositoryError && error.code === code;
}

function snapshot(overrides: Partial<SnapshotSetCreateCommand> = {}): SnapshotSetCreateCommand {
  const checkpoint = new Date(Date.UTC(2026, 6, 17, 12, 15, snapshotSecond++)).toISOString();
  return {
    runId: BASE_RUN_ID, matchId: "m1", matchDate: "20260717", checkpointType: "T1215",
    checkpointAt: checkpoint, datasetMode: "strict_asof", status: "ready",
    previousSnapshotSetId: null, revision: 1, supersedesSnapshotSetId: null,
    sourceCutoffAt: checkpoint, contentHash: `snapshot-${nextId()}`,
    schemaVersion: 1, completeness: { odds: true }, traceId: "trace-snapshot", ...overrides,
  };
}

function item(overrides: Partial<SnapshotItemCreateCommand> = {}): SnapshotItemCreateCommand {
  return {
    oddsSnapshotId: 1, role: "current", companyId: "3", marketType: "asian_handicap",
    snapshotType: "crown12", sourceObservedAt: "2026-07-17T11:59:00.000Z",
    collectedAt: "2026-07-17T12:00:00.000Z", ...overrides,
  };
}

function run(overrides: Partial<RunCreateCommand> = {}): RunCreateCommand {
  return {
    runType: "shadow", status: "pending", datasetMode: "strict_asof", startDate: "20260717",
    endDate: "20260717", datasetCutoffAt: "2026-07-17T12:15:00.000Z",
    strategyVersions: BUILT_IN_STRATEGY_ARTIFACTS, configuration: { policy },
    codeVersion: "code-v1", idempotencyKey: `run-${nextId()}`, createdBy: "repository-test",
    traceId: "trace-run", ...overrides,
  };
}

function prediction(runId: string, snapshotSetId: string, overrides: Partial<PredictionCreateCommand> = {}): PredictionCreateCommand {
  return {
    runId, matchId: "m1", matchDate: "20260717", checkpointType: "T1215", snapshotSetId,
    requestedStrategy: "A", executedStrategy: "A", strategyVersion: "A-v1",
    decisionStatus: "recommend", selection: "home", lockedDeterministic: true,
    reasonCode: "A_RULE", branchId: "A-BRANCH", inputHash: "input", outputHash: "output",
    decisionPayload: {
      current: {
        handicap: { raw: "半球", quarterUnits: 2 },
        homeWater: { raw: "0.90", basisPoints: 9000 }, awayWater: { raw: "0.98", basisPoints: 9800 },
      },
      previousEffective: null, waterDiffBasisPoints: 800, details: {},
    },
    fallbackReason: null, legacyPredictionId: null, source: "experiment",
    evidenceContractVersion:2,executionCutoffAt:"2026-07-17T12:15:00.000Z",executedActualQuoteSnapshotId:1,
    theoreticalHandicapRaw:"半球",theoreticalHandicapQuarterUnits:2,theoreticalSelectedWater:"0.900000",
    idempotencyKey: `prediction-${nextId()}`, traceId: "trace-prediction", ...overrides,
  } as PredictionCreateCommand;
}

function actualSettlement(predictionId: string, overrides: Partial<SettlementCreateCommand> = {}): SettlementCreateCommand {
  return {
    predictionId, revision: 1, matchResultId: 1, actualQuoteSnapshotId: 2,
    matchResultRevisionId: null, calculatorVersion: null, evidenceHash: null,
    quoteHandicapRaw: null,quoteHandicapQuarterUnits:null,quoteSelectedWater:null,quoteSelectedWaterMillionths:null,
    quoteBasis: "actual", outcome: "win", profitUnits: 0.9, isCounted: true,
    settlementBasis: "actual_quote", evidence: { source: "closing" },
    settledAt: "2026-07-17T15:00:00.000Z", settledBy: "repository-test",
    supersedes: null, traceId: "trace-settlement", ...overrides,
  } as SettlementCreateCommand;
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
       canonical_content_hash TEXT,hash_version TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE strategy_versions(version TEXT PRIMARY KEY);
    CREATE TABLE prediction_results(id SERIAL PRIMARY KEY);
    CREATE TABLE match_results(id SERIAL PRIMARY KEY, match_id VARCHAR(20) NOT NULL, match_date VARCHAR(8) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',home_score INTEGER,away_score INTEGER,score_source TEXT NOT NULL DEFAULT 'official',
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),settled_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);
  await db.exec(await read("migrations/0020_strategy_lab_fact_model.sql"));
  await db.exec(await read("migrations/0021_strategy_lab_policy_and_artifacts.sql"));
  await db.exec(await read("migrations/0022_strategy_lab_snapshot_provider.sql"));
  await db.exec(await read("migrations/0023_strategy_lab_trusted_settlement.sql"));
  const actualOdds={handicapLine:"半球",handicapHome:"0.90",handicapAway:"0.98"};
  const actualHash=canonicalJsonSha256(actualOdds);
  await db.exec(`
    INSERT INTO strategy_versions(version) VALUES('A-v1'),('C-v1');
    INSERT INTO odds_snapshots(match_id,match_date,company_id,market_type,snapshot_type,source,odds,source_observed_at,collected_at,content_hash,idempotency_key,canonical_content_hash,hash_version)
    VALUES('m1','20260717','3','asian_handicap','crown12','source','${JSON.stringify(actualOdds)}','2026-07-17T11:59:00Z','2026-07-17T12:00:00Z','${actualHash}','o1','${actualHash}','canonical-json-v2'),
          ('m1','20260717','3','asian_handicap','crown_live','source','${JSON.stringify(actualOdds)}','2026-07-17T12:10:00Z','2026-07-17T12:11:00Z','${actualHash}','o2','${actualHash}','canonical-json-v2'),
          ('m2','20260717','3','asian_handicap','crown_live','source','${JSON.stringify(actualOdds)}','2026-07-17T12:10:00Z','2026-07-17T12:11:00Z','${actualHash}','o3','${actualHash}','canonical-json-v2'),
          ('m1','20260717','35','asian_handicap','crown12','source','${JSON.stringify(actualOdds)}','2026-07-17T11:58:00Z','2026-07-17T11:59:00Z','${actualHash}','o4','${actualHash}','canonical-json-v2');
    INSERT INTO match_results(match_id,match_date,status,home_score,away_score,score_source,observed_at,settled_at,updated_at)
      VALUES('m1','20260717','finished',1,0,'official','2026-07-17T14:00:00Z','2026-07-17T15:00:00Z','2026-07-17T15:00:00Z'),
            ('m2','20260717','pending',NULL,NULL,'official','2026-07-17T12:00:00Z',NULL,'2026-07-17T12:00:00Z');
    INSERT INTO strategy_lab_match_facts(id,match_id,match_date,league_name_raw,league_name_normalized,kickoff_at,source,source_observed_at,dataset_cutoff_at,canonical_payload,content_hash,revision,supersedes_id,schema_version,trace_id)
      VALUES('${uuid(7000)}','m1','20260717','League','League','2026-07-17T16:00:00Z','fixture','2026-07-17T11:00:00Z','2026-07-17T12:15:00Z',
        jsonb_build_object('schemaVersion',1,'matchId','m1','matchDate','20260717','league','League','kickoffAt','2026-07-17T16:00:00Z'::timestamptz,'source','fixture','sourceObservedAt','2026-07-17T11:00:00Z'::timestamptz,'datasetCutoffAt','2026-07-17T12:15:00Z'::timestamptz,'revision',1),'${"f".repeat(64)}',1,NULL,1,'fixture');
    INSERT INTO strategy_lab_experiment_runs(
      id,run_type,status,dataset_mode,start_date,end_date,dataset_cutoff_at,strategy_versions,configuration,
      code_version,idempotency_key,created_by,trace_id,created_at,updated_at
    ) VALUES('${BASE_RUN_ID}','shadow','pending','strict_asof','20260717','20260717','2026-07-17T15:00:00Z',
      '{"A":"A-v1","B":"B-v1","C":"C-v1","D":"D-v1"}','{}','code','base-run','tester','trace',
      '2026-07-17T11:00:00Z','2026-07-17T11:00:00Z');
    UPDATE strategy_lab_experiment_runs SET status='running',started_at='2026-07-17T11:01:00Z',updated_at='2026-07-17T11:01:00Z'
      WHERE id='${BASE_RUN_ID}';
  `);
  client = new PGliteStrategyClient(db);
  repository = new PostgresStrategyLabRepository(client, { idFactory: nextId, clock: () => new Date(now) });
}, 30_000);

afterAll(async () => db.close());

describe("snapshot set transaction and idempotency", () => {
  it("creates a set and items atomically and returns a frozen typed snapshot", async () => {
    const command = snapshot({ id: uuid(1), contentHash: "snapshot-success" });
    const result = await repository.createSnapshotSetWithItems(command, [item()]);
    expect(result.status).toBe("created");
    expect(result.value.id).toBe(uuid(1));
    expect(Object.isFrozen(result.value)).toBe(true);
    const rows = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM strategy_lab_snapshot_items WHERE snapshot_set_id=$1", [uuid(1)]);
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("rolls the set back when any item fails and maps integrity safely", async () => {
    const id = uuid(2);
    await expect(repository.createSnapshotSetWithItems(snapshot({ id, contentHash: "snapshot-rollback" }), [item({ oddsSnapshotId: 999 })]))
      .rejects.toSatisfy(expectCode("integrity_error"));
    expect(await repository.getSnapshotSetById(id)).toBeNull();
  });

  it("returns existing only for the same immutable payload, JSON semantics, and authoritative current item", async () => {
    const command = snapshot({ id: uuid(3), contentHash: "snapshot-idempotent", completeness: { z: true, a: { y: 2, x: 1 } } });
    const items = [item()];
    await repository.createSnapshotSetWithItems(command, items);
    const existing = await repository.createSnapshotSetWithItems({
      ...command, id: uuid(4), completeness: { a: { x: 1, y: 2 }, z: true },
    }, [...items]);
    expect(existing.status).toBe("existing");
    expect(existing.value.id).toBe(uuid(3));
  });

  it("conflicts when the same revision has a different content hash", async () => {
    const command = snapshot({ id: uuid(5), contentHash: "snapshot-revision-content" });
    await repository.createSnapshotSetWithItems(command, [item()]);
    await expect(repository.createSnapshotSetWithItems({ ...command, id: uuid(5), contentHash: "snapshot-competing" }, [item()]))
      .rejects.toSatisfy(expectCode("idempotency_conflict"));
  });

  it("conflicts when the same content hash competes at another revision", async () => {
    const command = snapshot({ id: uuid(6), contentHash: "snapshot-content-revision" });
    await repository.createSnapshotSetWithItems(command, [item()]);
    await expect(repository.createSnapshotSetWithItems({ ...command, id: uuid(7), revision: 2, supersedesSnapshotSetId: uuid(6) }, [item()]))
      .rejects.toSatisfy(expectCode("idempotency_conflict"));
  });

  it("conflicts when supersedes identity differs", async () => {
    const first = snapshot({ id: uuid(8), contentHash: "snapshot-first-revision" });
    const second = { ...first, id: uuid(9), revision: 2, supersedesSnapshotSetId: uuid(8), contentHash: "snapshot-second-revision" };
    await repository.createSnapshotSetWithItems(first, [item()]);
    await repository.createSnapshotSetWithItems(second, [item()]);
    await expect(repository.createSnapshotSetWithItems({ ...second, id: uuid(10), supersedesSnapshotSetId: uuid(999) }, [item()]))
      .rejects.toSatisfy(expectCode("idempotency_conflict"));
  });

  it.each([
    ["missing", []],
    ["extra", [item(), item({ oddsSnapshotId: 4, companyId: "35", sourceObservedAt: "2026-07-17T11:58:00.000Z", collectedAt: "2026-07-17T11:59:00.000Z" })]],
    ["duplicate", [item(), item()]],
  ])("conflicts when replay items are %s", async (_label, replayItems) => {
    const command = snapshot({ id: nextId(), contentHash: `snapshot-items-${_label}` });
    await repository.createSnapshotSetWithItems(command, [item()]);
    await expect(repository.createSnapshotSetWithItems({ ...command, id: nextId() }, replayItems))
      .rejects.toSatisfy(expectCode("idempotency_conflict"));
  });

  it("classifies duplicate snapshot items as integrity rather than idempotency", async () => {
    const command = snapshot({ id: uuid(53), contentHash: "snapshot-duplicate-items" });
    await expect(repository.createSnapshotSetWithItems(command, [item(), item()]))
      .rejects.toSatisfy(expectCode("integrity_error"));
    expect(await repository.getSnapshotSetById(uuid(53))).toBeNull();
  });

  it("rolls back a strict-as-of trigger failure", async () => {
    const id = uuid(60);
    await expect(repository.createSnapshotSetWithItems(snapshot({ id, contentHash: "snapshot-late" }), [item({
      oddsSnapshotId: 2, sourceObservedAt: "2026-07-17T14:59:00.000Z", collectedAt: "2026-07-17T15:00:00.000Z",
    })])).rejects.toSatisfy(expectCode("integrity_error"));
    expect(await repository.getSnapshotSetById(id)).toBeNull();
  });
});

describe("run idempotency and compare-and-set transitions", () => {
  it("returns existing only for the same immutable run payload", async () => {
    tick("2026-07-17T11:00:00.000Z");
    const command = run({
      id: uuid(10), idempotencyKey: "run-idempotent",
      strategyVersions: BUILT_IN_STRATEGY_ARTIFACTS, configuration: { policy },
    });
    expect((await repository.createRun(command)).status).toBe("created");
    expect((await repository.createRun({
      ...command, id: uuid(11), strategyVersions: BUILT_IN_STRATEGY_ARTIFACTS,
      configuration: { policy },
    })).status).toBe("existing");
    await expect(repository.createRun({ ...command, id: uuid(12), codeVersion: "different" }))
      .rejects.toSatisfy(expectCode("idempotency_conflict"));
  });

  it("transitions pending to running to succeeded using server time", async () => {
    const createCommand = run({ id: uuid(13), idempotencyKey: "run-lifecycle" });
    const created = await repository.createRun(createCommand);
    tick("2026-07-17T11:01:00.000Z");
    const running = await repository.transitionRun({
      id: created.value.id, transition: "pending_to_running", expectedCurrentStatus: "pending",
      previousUpdatedAt: created.value.updatedAt,
    });
    expect(running.status).toBe("running");
    expect(running.startedAt).toBe("2026-07-17T11:01:00.000Z");
    expect((await repository.createRun({ ...createCommand, id: uuid(131) })).status).toBe("existing");
    tick("2026-07-17T11:02:00.000Z");
    const succeeded = await repository.transitionRun({
      id: running.id, transition: "running_to_succeeded", expectedCurrentStatus: "running",
      previousUpdatedAt: running.updatedAt,
    });
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.finishedAt).toBe("2026-07-17T11:02:00.000Z");
    expect((await repository.createRun({ ...createCommand, id: uuid(132) })).status).toBe("existing");
  });

  it("distinguishes not-found and stale status/timestamp CAS conflicts", async () => {
    let before = client.calls.length;
    await expect(repository.transitionRun({ id: uuid(999), transition: "pending_to_running", expectedCurrentStatus: "pending", previousUpdatedAt: now.toISOString() }))
      .rejects.toSatisfy(expectCode("not_found"));
    expect(client.calls.slice(before)).toHaveLength(1);
    const created = await repository.createRun(run({ id: uuid(14), idempotencyKey: "run-cas" }));
    tick("2026-07-17T11:03:00.000Z");
    before = client.calls.length;
    const running = await repository.transitionRun({ id: created.value.id, transition: "pending_to_running", expectedCurrentStatus: "pending", previousUpdatedAt: created.value.updatedAt });
    expect(client.calls.slice(before)).toHaveLength(1);
    before = client.calls.length;
    await expect(repository.transitionRun({ id: running.id, transition: "pending_to_running", expectedCurrentStatus: "pending", previousUpdatedAt: created.value.updatedAt }))
      .rejects.toSatisfy(expectCode("concurrency_conflict"));
    expect(client.calls.slice(before)).toHaveLength(1);
    before = client.calls.length;
    await expect(repository.transitionRun({ id: running.id, transition: "running_to_succeeded", expectedCurrentStatus: "running", previousUpdatedAt: created.value.updatedAt }))
      .rejects.toSatisfy(expectCode("concurrency_conflict"));
    expect(client.calls.slice(before)).toHaveLength(1);
  });

  it("canonicalizes database microseconds and CASes at millisecond precision", async () => {
    await db.exec(`INSERT INTO strategy_lab_experiment_runs(
      id,run_type,status,dataset_mode,start_date,end_date,dataset_cutoff_at,strategy_versions,configuration,
      code_version,idempotency_key,created_by,trace_id,created_at,updated_at
    ) VALUES('${uuid(17)}','shadow','pending','strict_asof','20260717','20260717','2026-07-17T12:15:00Z',
      '${JSON.stringify(BUILT_IN_STRATEGY_ARTIFACTS).replaceAll("'","''")}','${JSON.stringify({ policy }).replaceAll("'","''")}','code','run-microseconds','tester','trace','2026-07-17T11:00:00.123456Z','2026-07-17T11:00:00.123456Z')`);
    const record = await repository.getRunById(uuid(17));
    expect(record?.createdAt).toBe("2026-07-17T11:00:00.123Z");
    expect(record?.updatedAt).toBe("2026-07-17T11:00:00.123Z");
    tick("2026-07-17T11:00:01.000Z");
    const before = client.calls.length;
    const transitioned = await repository.transitionRun({
      id: uuid(17), transition: "pending_to_running", expectedCurrentStatus: "pending",
      previousUpdatedAt: "2026-07-17T11:00:00.123Z",
    });
    expect(transitioned.status).toBe("running");
    expect(client.calls.slice(before)).toHaveLength(1);
    await expect(repository.transitionRun({
      id: uuid(17), transition: "running_to_succeeded", expectedCurrentStatus: "running",
      previousUpdatedAt: "2026-07-17T11:00:00.122Z",
    })).rejects.toSatisfy(expectCode("concurrency_conflict"));
    await expect(repository.transitionRun({
      id: uuid(17), transition: "running_to_succeeded", expectedCurrentStatus: "running",
      previousUpdatedAt: "2026-07-17T11:00:01Z",
    })).rejects.toSatisfy(expectCode("validation_error"));
  });

  it("allows only one of two concurrent transitions", async () => {
    const created = await repository.createRun(run({ id: uuid(15), idempotencyKey: "run-race" }));
    tick("2026-07-17T11:04:00.000Z");
    const command = { id: created.value.id, transition: "pending_to_running" as const, expectedCurrentStatus: "pending" as const, previousUpdatedAt: created.value.updatedAt };
    const outcomes = await Promise.allSettled([repository.transitionRun(command), repository.transitionRun(command)]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(expectCode("concurrency_conflict")(rejected.reason)).toBe(true);
  });

  it("rejects an invalid transition command before SQL mutation", async () => {
    const created = await repository.createRun(run({ id: uuid(16), idempotencyKey: "run-invalid-transition" }));
    await expect(repository.transitionRun({
      id: created.value.id, transition: "running_to_succeeded", expectedCurrentStatus: "pending" as never,
      previousUpdatedAt: created.value.updatedAt,
    })).rejects.toSatisfy(expectCode("validation_error"));
  });
});

describe("prediction and settlement create-only persistence", () => {
  async function context(seed: number) {
    const runRecord = await repository.createRun(run({ id: uuid(seed + 1), idempotencyKey: `context-run-${seed}` }));
    const set = await repository.createSnapshotSetWithItems(snapshot({ id: uuid(seed), runId: runRecord.value.id, contentHash: `context-${seed}` }), [item()]);
    return { snapshotId: set.value.id, runId: runRecord.value.id };
  }

  it("creates predictions idempotently and rejects different payloads and cross-snapshot identity", async () => {
    const value = await context(100);
    const command = prediction(value.runId, value.snapshotId, { id: uuid(102), idempotencyKey: "prediction-idempotent" });
    expect((await repository.createPrediction(command)).status).toBe("created");
    expect((await repository.createPrediction({ ...command, id: uuid(103) })).status).toBe("existing");
    await expect(repository.createPrediction({ ...command, id: uuid(104), outputHash: "different" }))
      .rejects.toSatisfy(expectCode("idempotency_conflict"));
    await expect(repository.createPrediction(prediction(value.runId, value.snapshotId, {
      id: uuid(105), idempotencyKey: "prediction-cross", matchId: "m2",
    }))).rejects.toSatisfy(expectCode("integrity_error"));
  });

  it("persists an explicit C to A fallback without rewriting identity", async () => {
    const value = await context(110);
    const result = await repository.createPrediction(prediction(value.runId, value.snapshotId, {
      id: uuid(112), idempotencyKey: "prediction-fallback", requestedStrategy: "C", executedStrategy: "A",
      fallbackReason: "missing_critical_data", strategyVersion: "C-v1",
    }));
    expect(result.value.requestedStrategy).toBe("C");
    expect(result.value.executedStrategy).toBe("A");
  });

  it("rejects non-JSON finite prediction data before querying", async () => {
    const value = await context(120);
    const command = prediction(value.runId, value.snapshotId, { id: uuid(122), idempotencyKey: "prediction-nan" });
    const invalid = { ...command, decisionPayload: { ...command.decisionPayload, details: { unsafe: Number.NaN } } };
    await expect(repository.createPrediction(invalid)).rejects.toSatisfy(expectCode("validation_error"));
  });

  it("creates actual/theoretical settlements, revisions, and idempotent revision replay", async () => {
    const value = await context(130);
    const createdPrediction = await repository.createPrediction(prediction(value.runId, value.snapshotId, { id: uuid(132), idempotencyKey: "settlement-prediction" }));
    const actual = actualSettlement(createdPrediction.value.id, { id: uuid(133) });
    const first = await repository.createSettlement(actual);
    expect(first.status).toBe("created");
    expect((await repository.createSettlement({ ...actual, id: uuid(134) })).status).toBe("existing");
    await expect(repository.createSettlement({ ...actual, id: uuid(135), profitUnits: 0.8 }))
      .rejects.toSatisfy(expectCode("idempotency_conflict"));
    const revision = await repository.createSettlement({
      ...actual, id: uuid(136), revision: 2, supersedes: first.value.id, outcome: "loss", profitUnits: -1,
    });
    expect(revision.value.revision).toBe(2);

    const secondContext = await context(140);
    const theoreticalPrediction = await repository.createPrediction(prediction(secondContext.runId, secondContext.snapshotId, { id: uuid(142), idempotencyKey: "theoretical-prediction" }));
    const theoretical = await repository.createSettlement({
      id: uuid(143), predictionId: theoreticalPrediction.value.id, revision: 1, matchResultId: 1,
      matchResultRevisionId: null, calculatorVersion: null, evidenceHash: null,
      quoteHandicapRaw:null,quoteHandicapQuarterUnits:null,quoteSelectedWater:null,quoteSelectedWaterMillionths:null,
      actualQuoteSnapshotId: null, quoteBasis: "theoretical", outcome: "push", profitUnits: 0,
      isCounted: true, settlementBasis: "theoretical_quote", evidence: { theoreticalQuote: { home: 0.92 } },
      settledAt: "2026-07-17T15:00:00.000Z", settledBy: "repository-test", supersedes: null,
      traceId: "trace-theoretical",
    });
    expect(theoretical.value.quoteBasis).toBe("theoretical");
  });

  it("round-trips NUMERIC(12,6) canonically and rejects excess scale or range", async () => {
    const value = await context(160);
    const createdPrediction = await repository.createPrediction(prediction(value.runId, value.snapshotId, { id: uuid(162), idempotencyKey: "numeric-prediction" }));
    const precise = await repository.createSettlement(actualSettlement(createdPrediction.value.id, { id: uuid(163), profitUnits: 0.123456 }));
    expect(precise.value.profitUnits).toBe(0.123456);
    expect((await repository.createSettlement({ ...actualSettlement(createdPrediction.value.id), id: uuid(164), profitUnits: 0.123456, traceId: precise.value.traceId })).status).toBe("existing");
    await expect(repository.createSettlement(actualSettlement(createdPrediction.value.id, { id: uuid(165), revision: 2, supersedes: precise.value.id, profitUnits: 0.1234567 })))
      .rejects.toSatisfy(expectCode("validation_error"));
    await expect(repository.createSettlement(actualSettlement(createdPrediction.value.id, { id: uuid(166), revision: 2, supersedes: precise.value.id, profitUnits: 1_000_000 })))
      .rejects.toSatisfy(expectCode("validation_error"));

    const boundaryContext = await context(170);
    const boundaryPrediction = await repository.createPrediction(prediction(boundaryContext.runId, boundaryContext.snapshotId, { id: uuid(172), idempotencyKey: "numeric-boundary-prediction" }));
    const boundary = await repository.createSettlement(actualSettlement(boundaryPrediction.value.id, { id: uuid(173), profitUnits: 999_999.999_999 }));
    expect(boundary.value.profitUnits).toBe(999_999.999_999);
  });

  it("maps invalid settlement evidence, sign, and match identity to safe errors", async () => {
    const value = await context(150);
    const createdPrediction = await repository.createPrediction(prediction(value.runId, value.snapshotId, { id: uuid(152), idempotencyKey: "invalid-settlement-prediction" }));
    await expect(repository.createSettlement(actualSettlement(createdPrediction.value.id, { id: uuid(153), profitUnits: -1 })))
      .rejects.toSatisfy(expectCode("validation_error"));
    await expect(repository.createSettlement(actualSettlement(createdPrediction.value.id, { id: uuid(154), actualQuoteSnapshotId: 3 })))
      .rejects.toSatisfy(expectCode("integrity_error"));
    await expect(repository.createSettlement(actualSettlement(createdPrediction.value.id, { id: uuid(155), matchResultId: 2 })))
      .rejects.toSatisfy(expectCode("integrity_error"));
  });
});

describe("query isolation and parameterized SQL boundary", () => {
  it("returns independent frozen records", async () => {
    const created = await repository.createRun(run({ id: uuid(200), idempotencyKey: "query-frozen" }));
    const first = await repository.getRunById(created.value.id);
    const second = await repository.getRunById(created.value.id);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.configuration)).toBe(true);
  });

  it("keeps malicious text in parameters instead of SQL structure", async () => {
    const malicious = `trace'); DROP TABLE strategy_lab_experiment_runs; --`;
    const before = client.calls.length;
    const result = await repository.createRun(run({ id: uuid(201), idempotencyKey: "parameterized-run", traceId: malicious }));
    expect(result.value.traceId).toBe(malicious);
    const insert = client.calls.slice(before).find(call => call.sql.includes("INSERT INTO strategy_lab_experiment_runs"));
    expect(insert?.sql).not.toContain(malicious);
    expect(insert?.parameters).toContain(malicious);
    expect(await repository.getRunById(result.value.id)).not.toBeNull();
  });

  it("does not retain raw database causes, SQL, parameters, or secrets", async () => {
    const raw = Object.assign(new Error("SELECT secret FROM vault WHERE token='top-secret'"), {
      code: "XX999", constraint: "secret_constraint", parameters: ["top-secret"],
      cause: { password: "top-secret" },
    });
    const failingClient: StrategyLabSqlClient = {
      query: async () => { throw raw; },
      transaction: async callback => callback({ query: async () => { throw raw; } }),
    };
    const failing = new PostgresStrategyLabRepository(failingClient, { idFactory: nextId, clock: () => now });
    let captured: unknown;
    try { await failing.getRunById(uuid(900)); } catch (error) { captured = error; }
    expect(captured).toBeInstanceOf(StrategyLabRepositoryError);
    const properties = Object.getOwnPropertyNames(captured as object);
    expect(properties.sort()).toEqual(["code", "message", "name"]);
    const serialized = JSON.stringify(captured);
    const traversed = properties.map(key => String((captured as Record<string, unknown>)[key])).join(" ");
    expect(`${serialized} ${traversed}`).not.toMatch(/top-secret|SELECT|vault|parameters|constraint/i);
    expect("cause" in (captured as object)).toBe(false);
  });

  it.each([
    "strategy_lab_snapshot_sets_pkey",
    "strategy_lab_snapshot_sets_supersedes_unique",
    "strategy_lab_snapshot_items_pkey",
    "strategy_lab_experiment_runs_pkey",
    "strategy_lab_predictions_pkey",
    "strategy_lab_settlements_pkey",
    "strategy_lab_settlements_supersedes_unique",
    null,
  ])("fails closed for non-idempotent unique constraint %s", async constraint => {
    const raw = { code: "23505", constraint, detail: "secret SQL detail" };
    const failingClient: StrategyLabSqlClient = {
      query: async () => { throw raw; },
      transaction: async callback => callback({ query: async () => { throw raw; } }),
    };
    const failing = new PostgresStrategyLabRepository(failingClient, { idFactory: nextId, clock: () => now });
    await expect(failing.createRun(run({ id: uuid(901), idempotencyKey: `constraint-${String(constraint)}` })))
      .rejects.toSatisfy(expectCode("integrity_error"));
  });
});

describe("persistent command receipts and atomic next settlements", () => {
  const context = (action: "run.create" | "snapshot.capture" | "settlement.create", key: string, hash = "a".repeat(64)) => ({
    action, operationKey: key, payloadHash: hash, actorId: "receipt-admin", requestId: `request-${key}`,
  });

  it("replays the same action/key/payload without repeating the fact effect", async () => {
    const command = run({ id: uuid(300), idempotencyKey: "receipt-run-idempotency" });
    const first = await repository.createRunWithReceipt(command, context("run.create", "receipt-run-0001"));
    const insertCount = client.calls.filter(call => call.sql.includes("INSERT INTO strategy_lab_experiment_runs")).length;
    const replay = await repository.createRunWithReceipt({ ...command, id: uuid(301) }, context("run.create", "receipt-run-0001"));
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ status: "existing", replayed: true, value: { id: first.value.id } });
    expect(client.calls.filter(call => call.sql.includes("INSERT INTO strategy_lab_experiment_runs"))).toHaveLength(insertCount);
  });

  it("rejects the same action/key with a different payload hash", async () => {
    await expect(repository.createRunWithReceipt(
      run({ id: uuid(302), idempotencyKey: "receipt-run-conflict" }),
      context("run.create", "receipt-run-0001", "b".repeat(64)),
    )).rejects.toSatisfy(expectCode("idempotency_conflict"));
  });

  it("rolls facts and receipt back together when an item fails", async () => {
    const setId = uuid(303);
    await expect(repository.createSnapshotSetWithItemsAndReceipt(
      snapshot({ id: setId, contentHash: "receipt-rollback-set" }),
      [item({ oddsSnapshotId: 999 })],
      context("snapshot.capture", "receipt-snapshot-rollback"),
    )).rejects.toSatisfy(expectCode("integrity_error"));
    expect(await repository.getSnapshotSetById(setId)).toBeNull();
    expect(await repository.getCommandReceipt("snapshot.capture", "receipt-snapshot-rollback")).toBeNull();
  });

  it("moves audit_pending to audited and records failed attempts safely", async () => {
    const failed = await repository.createRunWithReceipt(
      run({ id: uuid(304), idempotencyKey: "receipt-audit-failed" }),
      context("run.create", "receipt-audit-failed"),
    );
    const pending = await repository.markCommandReceiptAudit("run.create", "receipt-audit-failed", false, "AUDIT_BACKEND_UNAVAILABLE");
    expect(pending).toMatchObject({ status: "audit_pending", auditAttempts: 1, lastAuditErrorCode: "AUDIT_BACKEND_UNAVAILABLE", auditedAt: null });
    const audited = await repository.markCommandReceiptAudit("run.create", "receipt-audit-failed", true);
    expect(audited).toMatchObject({ status: "audited", auditAttempts: 2, lastAuditErrorCode: null });
    expect(audited.auditedAt).not.toBeNull();
    expect(failed.receipt.status).toBe("audit_pending");
  });

  it("rejects receipt identity mutation and enables RLS", async () => {
    await expect(db.exec("UPDATE strategy_lab_command_receipts SET actor_id='forged' WHERE action='run.create' AND operation_key='receipt-audit-failed'"))
      .rejects.toThrow("command receipt immutable fields cannot change");
    const rls = await db.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE relname='strategy_lab_command_receipts'");
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
  });

  it("replays interleaved identical receipts without duplicating facts on PGlite", async () => {
    const command = run({ id: uuid(305), idempotencyKey: "receipt-concurrent-run" });
    const receiptContext = context("run.create", "receipt-concurrent-0001");
    const outcomes = [];
    for (let index = 0; index < 20; index++) {
      outcomes.push(await repository.createRunWithReceipt({ ...command, id: uuid(306 + index) }, receiptContext));
      await repository.getCommandReceipt("run.create", receiptContext.operationKey);
    }
    expect(outcomes.filter(result => result.replayed)).toHaveLength(19);
    const count = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM strategy_lab_experiment_runs WHERE idempotency_key='receipt-concurrent-run'");
    expect(count.rows[0]?.count).toBe(1);
  });

  it("builds twenty continuous settlement revisions and replays without recalculation on PGlite", async () => {
    const runRecord = await repository.createRun(run({ id: uuid(310), idempotencyKey: "next-settlement-run" }));
    const runningRun=await repository.transitionRun({id:runRecord.value.id,transition:"pending_to_running",expectedCurrentStatus:"pending",previousUpdatedAt:runRecord.value.updatedAt});
    const setRecord = await repository.createSnapshotSetWithItems(snapshot({ id: uuid(311), runId: runningRun.id, contentHash: "next-settlement-set" }), [item()]);
    const predictionRecord = await repository.createPrediction(prediction(runRecord.value.id, setRecord.value.id, { id: uuid(312), idempotencyKey: "next-settlement-prediction" }));
    const revisionDraft={sourceMatchResultId:1,matchId:"m1",matchDate:"20260717",status:"finished" as const,homeScore:1,awayScore:0,scoreSource:"official",sourceObservedAt:"2026-07-17T14:00:00.000Z",sourceSettledAt:"2026-07-17T15:00:00.000Z",sourceUpdatedAt:"2026-07-17T15:00:00.000Z"};
    const revisionHash=computeMatchResultRevisionHash(revisionDraft);
    const legs=[{handicapQuarterUnits:2,stakeMicros:1000000,result:"win" as const,profitMicros:900000}];
    const evidence={schemaVersion:"strategy-lab-settlement-evidence-v2",reasonCode:"finished",selection:"home",handicapQuarterUnits:2,selectedWaterMillionths:900000,selectedWater:"0.900000",legs,
      actualQuote:{snapshotId:1,contentHash:canonicalJsonSha256({handicapLine:"半球",handicapHome:"0.90",handicapAway:"0.98"}),source:"source",observedAt:"2026-07-17T11:59:00.000Z",collectedAt:"2026-07-17T12:00:00.000Z",handicapRaw:"半球",handicapQuarterUnits:2,selectedWaterRaw:"0.90",selectedWater:"0.900000",selectedWaterMillionths:900000},operationBinding:"binding"};
    const base = {
      predictionId: predictionRecord.value.id, matchResultId: 1, actualQuoteSnapshotId: 1,
      calculatorVersion: "calculator-v2",
      quoteHandicapRaw:"半球",quoteHandicapQuarterUnits:2,quoteSelectedWater:"0.900000",quoteSelectedWaterMillionths:900000,
      profitMicros:900000,profitDecimal:"0.900000",legs,matchResultRevisionDraft:{...revisionDraft,contentHash:revisionHash},
      quoteBasis: "actual" as const, outcome: "win" as const, profitUnits: 0.9, isCounted: true,
      settlementBasis: "actual_quote" as const, evidence, settledAt: "2026-07-17T15:00:00.000Z",
      settledBy: "receipt-admin", traceId: "receipt-settlement",
    };
    const results=[];
    for(let index=1;index<=20;index++){
      const evidenceHash=computeSettlementEvidenceHash({calculatorVersion:base.calculatorVersion,operationBinding:"binding",predictionId:base.predictionId,
        matchResultRevisionHash:revisionHash,quoteBasis:"actual",actualQuoteSnapshotId:1,quoteHandicapRaw:"半球",quoteHandicapQuarterUnits:2,
        quoteSelectedWater:"0.900000",quoteSelectedWaterMillionths:900000,outcome:"win",profitMicros:900000,profitDecimal:"0.900000",legs,evidence});
      results.push(await repository.createNextSettlementWithReceipt({...base,evidenceHash},context("settlement.create",`next-settlement-${index}`,String(index).padStart(64,"0"))));
    }
    expect(results.map(result=>result.value.revision)).toEqual(Array.from({length:20},(_,index)=>index+1));
    const rows = await db.query<{ revision: number; supersedes: string | null }>("SELECT revision,supersedes FROM strategy_lab_settlements WHERE prediction_id=$1 ORDER BY revision", [predictionRecord.value.id]);
    expect(rows.rows[0]).toMatchObject({ revision: 1, supersedes: null });
    expect(rows.rows.slice(1).every(row=>typeof row.supersedes==="string")).toBe(true);
    const replay = await repository.createNextSettlementWithReceipt({...base,evidenceHash:results[0].value.evidenceHash!}, context("settlement.create", "next-settlement-1", "1".padStart(64,"0")));
    expect(replay).toMatchObject({ replayed: true, value: { id: results[0].value.id } });
    expect((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM strategy_lab_settlements WHERE prediction_id=$1", [predictionRecord.value.id])).rows[0]?.count).toBe(20);

    const beforeRevisionCount=(await db.query<{count:number}>("SELECT count(*)::int count FROM strategy_lab_match_result_revisions")).rows[0]!.count;
    const tamperedCommands = [
      { name:"outcome", command:{...base,outcome:"push" as const,evidenceHash:results[0].value.evidenceHash!} },
      { name:"profitMicros", command:{...base,profitMicros:899999,evidenceHash:results[0].value.evidenceHash!} },
      { name:"profitDecimal", command:{...base,profitDecimal:"0.899999",evidenceHash:results[0].value.evidenceHash!} },
      { name:"quoteRaw", command:{...base,quoteHandicapRaw:"平手",evidenceHash:results[0].value.evidenceHash!} },
      { name:"quarterUnits", command:{...base,quoteHandicapQuarterUnits:0,evidenceHash:results[0].value.evidenceHash!} },
      { name:"waterDecimal", command:{...base,quoteSelectedWater:"0.899999",evidenceHash:results[0].value.evidenceHash!} },
      { name:"waterMillionths", command:{...base,quoteSelectedWaterMillionths:899999,evidenceHash:results[0].value.evidenceHash!} },
      { name:"legs", command:{...base,legs:[{...legs[0],profitMicros:899999}],evidenceHash:results[0].value.evidenceHash!} },
      { name:"revisionHash", command:{...base,matchResultRevisionDraft:{...base.matchResultRevisionDraft,contentHash:"f".repeat(64)},evidenceHash:results[0].value.evidenceHash!} },
      { name:"finalEvidenceHash", command:{...base,evidenceHash:"f".repeat(64)} },
    ];
    for (const tamper of tamperedCommands) {
      const key=`tamper-${tamper.name}`;
      await expect(repository.createNextSettlementWithReceipt(tamper.command,context("settlement.create",key,"e".repeat(64))))
        .rejects.toSatisfy(expectCode("integrity_error"));
      expect(await repository.getCommandReceipt("settlement.create",key)).toBeNull();
      expect((await db.query<{count:number}>("SELECT count(*)::int count FROM strategy_lab_settlements WHERE prediction_id=$1",[predictionRecord.value.id])).rows[0]?.count).toBe(20);
      expect((await db.query<{count:number}>("SELECT count(*)::int count FROM strategy_lab_match_result_revisions")).rows[0]?.count).toBe(beforeRevisionCount);
    }
    expect(beforeRevisionCount).toBe(1);
    await db.exec("UPDATE match_results SET home_score=2,updated_at='2026-07-17T15:01:00Z' WHERE id=1");
    const correctedDraft={...revisionDraft,homeScore:2,sourceUpdatedAt:"2026-07-17T15:01:00.000Z"};
    const correctedHash=computeMatchResultRevisionHash(correctedDraft);
    const correctedEvidenceHash=computeSettlementEvidenceHash({calculatorVersion:base.calculatorVersion,operationBinding:"binding",predictionId:base.predictionId,
      matchResultRevisionHash:correctedHash,quoteBasis:"actual",actualQuoteSnapshotId:1,quoteHandicapRaw:"半球",quoteHandicapQuarterUnits:2,
      quoteSelectedWater:"0.900000",quoteSelectedWaterMillionths:900000,outcome:"win",profitMicros:900000,profitDecimal:"0.900000",legs,evidence});
    const corrected=await repository.createNextSettlementWithReceipt({...base,matchResultRevisionDraft:{...correctedDraft,contentHash:correctedHash},evidenceHash:correctedEvidenceHash},context("settlement.create","next-settlement-correction","c".repeat(64)));
    expect(corrected.value.revision).toBe(21);
    const revisions=await db.query<{revision:number;supersedes:string|null}>("SELECT revision,supersedes FROM strategy_lab_match_result_revisions ORDER BY revision");
    expect(revisions.rows.map(row=>row.revision)).toEqual([1,2]);
    expect(revisions.rows[1]?.supersedes).toBeTruthy();
    await expect(db.exec("UPDATE strategy_lab_match_result_revisions SET score_source='tampered' WHERE revision=1")).rejects.toThrow(/append-only/);
    await expect(db.exec("DELETE FROM strategy_lab_match_result_revisions WHERE revision=1")).rejects.toThrow(/append-only/);
  });
});
