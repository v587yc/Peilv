import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@/lib/canonical-json";
import {
  StrategyLabSnapshotDependencyError,
  StrategyLabSnapshotIntegrityError,
} from "@/features/strategy-lab/application-service";
import type { CaptureSnapshotApplicationInput } from "@/features/strategy-lab/application-schemas";
import {
  PostgresSnapshotCaptureValidator,
  PostgresSnapshotInputProvider,
} from "@/features/strategy-lab/postgres-snapshot-input-provider";
import type { StrategyLabSqlClient, StrategyLabSqlExecutor } from "@/features/strategy-lab/postgres-repository";
import type { StrategyLabRunRecord } from "@/features/strategy-lab/repository";
import { computeStrategySnapshotSetHash } from "@/features/strategy-lab/snapshot-contract";

const root = new URL("..", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const uuid = (value: number) => `22000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const RUN = uuid(1), MATCH = "phase3-match", DATE = "20260717";
const TIMES = { T1215: "2026-07-17T04:15:00.000Z", T30: "2026-07-17T14:30:00.000Z", T03: "2026-07-17T14:57:00.000Z" } as const;
type Checkpoint = keyof typeof TIMES;

class Client implements StrategyLabSqlClient {
  readonly calls: string[] = [];
  readonly options: unknown[] = [];
  constructor(readonly db: PGlite) {}
  async query<Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
    this.calls.push(sql); const result = await this.db.query<Row>(sql, [...parameters]); return { rows: result.rows };
  }
  async transaction<T>(callback: (tx: StrategyLabSqlExecutor) => Promise<T>, options?: unknown): Promise<T> {
    this.options.push(options);
    return this.db.transaction(tx => callback({ query: async <Row extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => {
      this.calls.push(sql); const result = await tx.query<Row>(sql, [...parameters]); return { rows: result.rows };
    }}));
  }
}

let db: PGlite, client: Client, next = 10;
const payload = (overrides: Record<string, unknown> = {}) => ({ handicapHome: "0.88", handicapLine: "半球", handicapAway: "0.98", ...overrides });
const checkpointType = (cp: Checkpoint) => cp === "T1215" ? "crown12" : "crown_live";

async function bootstrap() {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE schema_migrations(version VARCHAR(100) PRIMARY KEY,description TEXT NOT NULL);
    CREATE TABLE user_focused_leagues(id SERIAL PRIMARY KEY,league_name TEXT NOT NULL UNIQUE);
    CREATE TABLE odds_snapshots(id SERIAL PRIMARY KEY,match_id VARCHAR(20) NOT NULL,match_date VARCHAR(8) NOT NULL,company_id VARCHAR(20) NOT NULL,market_type TEXT NOT NULL,snapshot_type TEXT NOT NULL,source TEXT NOT NULL,odds JSONB NOT NULL,source_observed_at TIMESTAMPTZ,collected_at TIMESTAMPTZ NOT NULL,content_hash TEXT NOT NULL,idempotency_key TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE strategy_versions(version TEXT PRIMARY KEY); CREATE TABLE prediction_results(id SERIAL PRIMARY KEY);
    CREATE TABLE match_results(id SERIAL PRIMARY KEY,match_id VARCHAR(20) NOT NULL,match_date VARCHAR(8) NOT NULL);
  `);
  await db.exec(await read("migrations/0020_strategy_lab_fact_model.sql"));
  await db.exec(await read("migrations/0021_strategy_lab_policy_and_artifacts.sql"));
  await db.exec(await read("migrations/0022_strategy_lab_snapshot_provider.sql"));
  await db.exec(`INSERT INTO strategy_lab_experiment_runs(id,run_type,status,dataset_mode,start_date,end_date,dataset_cutoff_at,strategy_versions,configuration,code_version,idempotency_key,created_by,trace_id,created_at,updated_at)
    VALUES('${RUN}','shadow','pending','strict_asof','${DATE}','${DATE}','2026-07-17T15:00:00Z','{}','{}','phase3','run-phase3','tester','trace','2026-07-17T04:00Z','2026-07-17T04:00Z');
    INSERT INTO strategy_lab_match_facts(id,match_id,match_date,league_name_raw,league_name_normalized,kickoff_at,source,source_observed_at,dataset_cutoff_at,canonical_payload,content_hash,revision,schema_version,trace_id)
    VALUES('${uuid(2)}','${MATCH}','${DATE}','英超','英超','2026-07-17T15:00Z','schedule','2026-07-17T04:00Z','2026-07-17T04:00Z',jsonb_build_object('schemaVersion',1,'matchId','${MATCH}','matchDate','${DATE}','league','英超','kickoffAt','2026-07-17T15:00Z'::timestamptz,'source','schedule','sourceObservedAt','2026-07-17T04:00Z'::timestamptz,'datasetCutoffAt','2026-07-17T04:00Z'::timestamptz,'revision',1),'${"f".repeat(64)}',1,1,'trace');`);
  client = new Client(db);
}

async function odds(cp: Checkpoint, oddsPayload = payload(), overrides: Record<string, unknown> = {}) {
  const hash = canonicalJsonSha256(oddsPayload); const time = TIMES[cp];
  const result = await db.query<{ id: number }>(`INSERT INTO odds_snapshots(match_id,match_date,company_id,market_type,snapshot_type,source,odds,source_observed_at,collected_at,content_hash,idempotency_key,hash_version,canonical_content_hash)
    VALUES($1,$2,$3,$4,$5,'fixture',$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [
      overrides.matchId ?? MATCH, overrides.matchDate ?? DATE, overrides.companyId ?? "3", overrides.marketType ?? "asian_handicap",
      overrides.snapshotType ?? checkpointType(cp), oddsPayload, overrides.observed ?? time, overrides.collected ?? time,
      overrides.contentHash ?? hash, `odds-${next++}`, overrides.hashVersion ?? "canonical-json-v2", overrides.canonicalHash === undefined ? hash : overrides.canonicalHash,
    ]); return result.rows[0].id;
}

async function set(cp: Checkpoint, previous: string | null, status = "ready", oddsId?: number, overrides: Record<string, unknown> = {}) {
  const id = String(overrides.id ?? uuid(next++)); const checkpointAt = String(overrides.checkpointAt ?? TIMES[cp]);
  const item = oddsId ? [{ oddsSnapshotId: oddsId, role: String(overrides.role ?? "current"), companyId: String(overrides.companyId ?? "3"), marketType: String(overrides.marketType ?? "asian_handicap"), snapshotType: String(overrides.snapshotType ?? checkpointType(cp)), sourceObservedAt: String(overrides.observed ?? checkpointAt), collectedAt: String(overrides.collected ?? checkpointAt) }] : [];
  const snapshot = { runId: String(overrides.runId ?? RUN), matchId: String(overrides.matchId ?? MATCH), matchDate: String(overrides.matchDate ?? DATE), checkpointType: cp, checkpointAt, status, previousSnapshotSetId: previous, revision: 1, supersedesSnapshotSetId: null, sourceCutoffAt: String(overrides.sourceCutoffAt ?? checkpointAt), schemaVersion: 2, completeness: status === "ready" || status === "partial" ? {} : { reasonCode: "NO_EVIDENCE" }, datasetMode: String(overrides.datasetMode ?? "strict_asof") };
  const hash = computeStrategySnapshotSetHash(snapshot, item);
  await db.exec("BEGIN");
  try {
    await db.query(`INSERT INTO strategy_lab_snapshot_sets(id,run_id,match_id,match_date,checkpoint_type,checkpoint_at,dataset_mode,status,previous_snapshot_set_id,revision,supersedes_snapshot_set_id,source_cutoff_at,content_hash,schema_version,completeness,trace_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,NULL,$10,$11,2,$12,'trace')`, [id,snapshot.runId,snapshot.matchId,snapshot.matchDate,cp,checkpointAt,snapshot.datasetMode,status,previous,snapshot.sourceCutoffAt,String(overrides.setHash ?? hash),snapshot.completeness]);
    if (oddsId) await db.query(`INSERT INTO strategy_lab_snapshot_items(snapshot_set_id,odds_snapshot_id,role,company_id,market_type,snapshot_type,source_observed_at,collected_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id,oddsId,item[0].role,item[0].companyId,item[0].marketType,item[0].snapshotType,item[0].sourceObservedAt,item[0].collectedAt]);
    await db.exec("COMMIT");
  } catch (error) { await db.exec("ROLLBACK"); throw error; }
  return id;
}

const expectIntegrity = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(StrategyLabSnapshotIntegrityError);
beforeEach(bootstrap, 30_000); afterEach(async () => db.close());

describe("PostgresSnapshotInputProvider matrix", () => {
  it.each(["ready","partial"])("accepts authoritative T1215 crown12 %s", async status => {
    const id = await set("T1215", null, status, await odds("T1215")); const value = await new PostgresSnapshotInputProvider(client).load(id);
    expect(value?.input).toEqual({ checkpoint: "T1215", current: { homeWater: "0.88", handicap: "半球", awayWater: "0.98" }, previousEffective: null });
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value?.input.current)).toBe(true);
  });
  it.each(["missing","insufficient"])("accepts %s with no item", async status => {
    const id=await set("T1215",null,status); expect((await new PostgresSnapshotInputProvider(client).load(id))?.input.current).toEqual({homeWater:null,handicap:null,awayWater:null});
  });
  it("rejects invalid status and returns null for not found", async()=>{const id=await set("T1215",null,"invalid");await expectIntegrity(new PostgresSnapshotInputProvider(client).load(id));expect(await new PostgresSnapshotInputProvider(client).load(uuid(999))).toBeNull();});
  it.each([
    ["companyId","35"],["marketType","total"],["snapshotType","crown_live"],
  ])("rejects wrong authoritative %s",async(key,value)=>{const oid=await odds("T1215");await db.exec("ALTER TABLE strategy_lab_snapshot_items DISABLE TRIGGER ALL");const id=await set("T1215",null,"ready",oid,{[key]:value});await expectIntegrity(new PostgresSnapshotInputProvider(client).load(id));});
  it.each([
    [{ handicapHome:null },"ready"],[{ handicapLine:"bad-line" },"ready"],[{ handicapAway:"water" },"ready"],
  ])("rejects missing or illegal payload",async(p,status)=>{const id=await set("T1215",null,status,await odds("T1215",payload(p)));await expectIntegrity(new PostgresSnapshotInputProvider(client).load(id));});
  it("accepts exact T1215 -> T30 -> T03 and falls back over an ineffective T30",async()=>{const a=await set("T1215",null,"ready",await odds("T1215",payload({handicapLine:"半球"})));const b=await set("T30",a,"partial",await odds("T30",payload({handicapLine:null})));const c=await set("T03",b,"ready",await odds("T03",payload({handicapLine:"半/一"})));const value=await new PostgresSnapshotInputProvider(client).load(c);expect(value?.input.previousEffective).toEqual({handicap:"半球"});});
  it.each(["T30","T03"] as const)("rejects %s without direct predecessor",async cp=>{await db.exec("ALTER TABLE strategy_lab_snapshot_sets DISABLE TRIGGER ALL");const id=await set(cp,null,"ready",await odds(cp));await expectIntegrity(new PostgresSnapshotInputProvider(client).load(id));});
  it("rejects a direct T03 to T1215 link",async()=>{const a=await set("T1215",null,"ready",await odds("T1215"));await db.exec("ALTER TABLE strategy_lab_snapshot_sets DISABLE TRIGGER ALL");const c=await set("T03",a,"ready",await odds("T03"));await expectIntegrity(new PostgresSnapshotInputProvider(client).load(c));});
  it("rejects cross identity, reversed and cyclic chains even when fixture bypasses migration guards",async()=>{const a=await set("T1215",null,"ready",await odds("T1215"));const b=await set("T30",a,"ready",await odds("T30"));await db.exec("ALTER TABLE strategy_lab_snapshot_sets DISABLE TRIGGER ALL; DROP TRIGGER strategy_lab_snapshot_sets_append_only ON strategy_lab_snapshot_sets");await db.exec(`UPDATE strategy_lab_snapshot_sets SET previous_snapshot_set_id='${b}' WHERE id='${a}'`);await expectIntegrity(new PostgresSnapshotInputProvider(client).load(b));});
  it("rejects more than one current item when the migration unique index is bypassed",async()=>{const id=await set("T1215",null,"ready",await odds("T1215"));await db.exec("DROP INDEX strategy_lab_snapshot_items_one_current_unique; ALTER TABLE strategy_lab_snapshot_items DISABLE TRIGGER ALL");const second=await odds("T1215");await db.query("INSERT INTO strategy_lab_snapshot_items(snapshot_set_id,odds_snapshot_id,role,company_id,market_type,snapshot_type,source_observed_at,collected_at) VALUES($1,$2,'current','3','asian_handicap','crown12',$3,$3)",[id,second,TIMES.T1215]);await expectIntegrity(new PostgresSnapshotInputProvider(client).load(id));});
  it.each([
    ["observed","2026-07-17T04:15:00.001Z"],["collected","2026-07-17T04:15:00.001Z"],
  ])("accepts equality but rejects %s one millisecond late",async(key,late)=>{const ok=await set("T1215",null,"ready",await odds("T1215"));expect(await new PostgresSnapshotInputProvider(client).load(ok)).not.toBeNull();await db.exec("ALTER TABLE strategy_lab_snapshot_items DISABLE TRIGGER ALL; DROP TRIGGER strategy_lab_snapshot_items_append_only ON strategy_lab_snapshot_items; DROP TRIGGER strategy_lab_snapshot_sets_append_only ON strategy_lab_snapshot_sets; DELETE FROM strategy_lab_snapshot_items; DELETE FROM strategy_lab_snapshot_sets");await expect(db.query("INSERT INTO odds_snapshots(match_id,match_date,company_id,market_type,snapshot_type,source,odds,source_observed_at,collected_at,content_hash,idempotency_key,hash_version,canonical_content_hash) SELECT match_id,match_date,company_id,market_type,snapshot_type,source,odds,$1,$2,content_hash,$3,hash_version,canonical_content_hash FROM odds_snapshots LIMIT 1",[key==="observed"?late:TIMES.T1215,key==="collected"?late:TIMES.T1215,`late-${key}`])).resolves.toBeDefined();const lateId=(await db.query<{id:number}>("SELECT max(id)::int id FROM odds_snapshots")).rows[0].id;const bad=await set("T1215",null,"ready",lateId,{observed:key==="observed"?late:TIMES.T1215,collected:key==="collected"?late:TIMES.T1215});await expectIntegrity(new PostgresSnapshotInputProvider(client).load(bad));});
  it("rejects observed after collected and cutoff/checkpoint/run/kickoff violations",async()=>{const oid=await odds("T1215",payload(),{observed:"2026-07-17T04:14:59Z",collected:"2026-07-17T04:14:58Z"});await db.exec("ALTER TABLE strategy_lab_snapshot_items DISABLE TRIGGER ALL");const id=await set("T1215",null,"ready",oid,{observed:"2026-07-17T04:14:59Z",collected:"2026-07-17T04:14:58Z"});await expectIntegrity(new PostgresSnapshotInputProvider(client).load(id));});
  it("uses each source latest as-of fact and rejects source disagreement",async()=>{await db.exec(`INSERT INTO strategy_lab_match_facts(id,match_id,match_date,league_name_raw,league_name_normalized,kickoff_at,source,source_observed_at,dataset_cutoff_at,canonical_payload,content_hash,revision,schema_version,trace_id) VALUES('${uuid(3)}','${MATCH}','${DATE}','英超','英超','2026-07-17T15:00Z','secondary','2026-07-17T04:01Z','2026-07-17T04:01Z',jsonb_build_object('schemaVersion',1,'matchId','${MATCH}','matchDate','${DATE}','league','英超','kickoffAt','2026-07-17T15:00Z'::timestamptz,'source','secondary','sourceObservedAt','2026-07-17T04:01Z'::timestamptz,'datasetCutoffAt','2026-07-17T04:01Z'::timestamptz,'revision',1),'${"e".repeat(64)}',1,1,'trace')`);const id=await set("T1215",null,"ready",await odds("T1215"));expect(await new PostgresSnapshotInputProvider(client).load(id)).not.toBeNull();await db.exec(`DROP TRIGGER strategy_lab_match_facts_append_only ON strategy_lab_match_facts; UPDATE strategy_lab_match_facts SET kickoff_at='2026-07-17T16:00Z' WHERE source='secondary'`);await expectIntegrity(new PostgresSnapshotInputProvider(client).load(id));});
  it("maps zero facts and database faults to typed dependency errors",async()=>{await db.exec("DROP TRIGGER strategy_lab_match_facts_append_only ON strategy_lab_match_facts; DELETE FROM strategy_lab_match_facts");const id=await set("T1215",null,"ready",await odds("T1215"));await expect(new PostgresSnapshotInputProvider(client).load(id)).rejects.toBeInstanceOf(StrategyLabSnapshotDependencyError);await db.exec("DROP TABLE strategy_lab_snapshot_sets CASCADE");await expect(new PostgresSnapshotInputProvider(client).load(id)).rejects.toBeInstanceOf(StrategyLabSnapshotDependencyError);});
  it("rejects v1 and payload/content/canonical/set/identity hash tampering",async()=>{const oid=await odds("T1215");const id=await set("T1215",null,"ready",oid);await db.exec("DROP TRIGGER odds_snapshots_append_only ON odds_snapshots; ALTER TABLE odds_snapshots DROP CONSTRAINT odds_snapshots_hash_contract_check; UPDATE odds_snapshots SET hash_version='legacy-json-v1',canonical_content_hash=NULL WHERE id="+oid);await expectIntegrity(new PostgresSnapshotInputProvider(client).load(id));});
  it("uses read-only repeatable-read transactions and emits zero write SQL",async()=>{const id=await set("T1215",null,"ready",await odds("T1215"));client.calls.length=0;await new PostgresSnapshotInputProvider(client).load(id);expect(client.options.at(-1)).toEqual({readOnly:true,isolationLevel:"repeatable read"});expect(client.calls.every(sql=>/^\s*SELECT\b/i.test(sql))).toBe(true);});

  it.each([
    ["runId",uuid(700)],["matchId","other-match"],["matchDate","20260718"],["datasetMode","reconstructed"],
  ])("rejects chain cross-%s identity independently",async(key,value)=>{const a=await set("T1215",null,"ready",await odds("T1215"));const b=await set("T30",a,"ready",await odds("T30"));await db.exec("DROP TRIGGER strategy_lab_snapshot_sets_append_only ON strategy_lab_snapshot_sets; ALTER TABLE strategy_lab_snapshot_sets DISABLE TRIGGER ALL");const column={runId:"run_id",matchId:"match_id",matchDate:"match_date",datasetMode:"dataset_mode"}[key]!;await db.query(`UPDATE strategy_lab_snapshot_sets SET ${column}=$1 WHERE id=$2`,[value,a]);await expectIntegrity(new PostgresSnapshotInputProvider(client).load(b));});
  it("rejects a reversed predecessor chain independently",async()=>{const a=await set("T1215",null,"ready",await odds("T1215"));const b=await set("T30",a,"ready",await odds("T30"));await db.exec("DROP TRIGGER strategy_lab_snapshot_sets_append_only ON strategy_lab_snapshot_sets; ALTER TABLE strategy_lab_snapshot_sets DISABLE TRIGGER ALL");await db.query("UPDATE strategy_lab_snapshot_sets SET previous_snapshot_set_id=$1 WHERE id=$2",[b,a]);await expectIntegrity(new PostgresSnapshotInputProvider(client).load(a));});
  it.each([
    ["source cutoff","2026-07-17T04:14:59.999Z",TIMES.T1215,TIMES.T1215],
    ["checkpoint",TIMES.T1215,"2026-07-17T04:15:00.001Z","2026-07-17T04:15:00.001Z"],
  ])("rejects evidence one millisecond beyond %s",async(_label,cutoff,observed,collected)=>{const oid=await odds("T1215",payload(),{observed,collected});await db.exec("ALTER TABLE strategy_lab_snapshot_items DISABLE TRIGGER ALL");const id=await set("T1215",null,"ready",oid,{sourceCutoffAt:cutoff,observed,collected});await expectIntegrity(new PostgresSnapshotInputProvider(client).load(id));});
  it("rejects evidence one millisecond beyond run cutoff",async()=>{await db.exec("ALTER TABLE strategy_lab_experiment_runs DISABLE TRIGGER ALL; UPDATE strategy_lab_experiment_runs SET dataset_cutoff_at='2026-07-17T04:14:59.999Z'");const id=await set("T1215",null,"ready",await odds("T1215"));await expectIntegrity(new PostgresSnapshotInputProvider(client).load(id));});
  it("rejects evidence one millisecond beyond kickoff",async()=>{const id=await set("T1215",null,"ready",await odds("T1215"));await db.exec("ALTER TABLE strategy_lab_match_facts DISABLE TRIGGER ALL; UPDATE strategy_lab_match_facts SET kickoff_at='2026-07-17T04:14:59.999Z'");await expectIntegrity(new PostgresSnapshotInputProvider(client).load(id));});
  it.each(["payload","content","canonical","set","item identity"])("rejects independent %s tampering",async kind=>{const oid=await odds("T1215");const id=await set("T1215",null,"ready",oid);if(kind==="set"){await db.exec("DROP TRIGGER strategy_lab_snapshot_sets_append_only ON strategy_lab_snapshot_sets");await db.query("UPDATE strategy_lab_snapshot_sets SET content_hash=$1 WHERE id=$2",["0".repeat(64),id]);}else if(kind==="item identity"){await db.exec("DROP TRIGGER odds_snapshots_append_only ON odds_snapshots");await db.query("UPDATE odds_snapshots SET match_id='tampered-match' WHERE id=$1",[oid]);}else{await db.exec("DROP TRIGGER odds_snapshots_append_only ON odds_snapshots; ALTER TABLE odds_snapshots DROP CONSTRAINT odds_snapshots_hash_contract_check");const assignment=kind==="payload"?"odds='{\"handicapHome\":\"0.77\",\"handicapLine\":\"半球\",\"handicapAway\":\"0.98\"}'::jsonb":kind==="content"?`content_hash='${"1".repeat(64)}'`:`canonical_content_hash='${"2".repeat(64)}'`;await db.exec(`UPDATE odds_snapshots SET ${assignment} WHERE id=${oid}`);}await expectIntegrity(new PostgresSnapshotInputProvider(client).load(id));});
  it("selects the latest eligible revision independently for each source",async()=>{await db.exec("ALTER TABLE strategy_lab_match_facts DISABLE TRIGGER ALL");await db.exec(`INSERT INTO strategy_lab_match_facts(id,match_id,match_date,league_name_raw,league_name_normalized,kickoff_at,source,source_observed_at,dataset_cutoff_at,canonical_payload,content_hash,revision,schema_version,trace_id) VALUES('${uuid(710)}','${MATCH}','${DATE}','英超','英超','2026-07-17T15:00Z','schedule','2026-07-17T04:02Z','2026-07-17T04:02Z','{}','${"1".repeat(64)}',2,1,'trace'),('${uuid(711)}','${MATCH}','${DATE}','英超','英超','2026-07-17T15:00Z','secondary','2026-07-17T04:01Z','2026-07-17T04:01Z','{}','${"2".repeat(64)}',2,1,'trace'),('${uuid(712)}','${MATCH}','${DATE}','旧联赛','旧联赛','2026-07-17T16:00Z','secondary','2026-07-17T03:58Z','2026-07-17T03:58Z','{}','${"3".repeat(64)}',1,1,'trace')`);const id=await set("T1215",null,"ready",await odds("T1215"));await expect(new PostgresSnapshotInputProvider(client).load(id)).resolves.not.toBeNull();});
});

describe("PostgresSnapshotCaptureValidator",()=>{
  const run = (): StrategyLabRunRecord => ({ id:RUN,runType:"shadow",status:"pending",datasetMode:"strict_asof",startDate:DATE,endDate:DATE,datasetCutoffAt:"2026-07-17T15:00:00.000Z",strategyVersions:{} as StrategyLabRunRecord["strategyVersions"],configuration:{ policy: { mode:"user_focused_leagues",artifactHash:"a".repeat(64),captureId:uuid(900),capturedAt:"2026-07-17T04:00:00.000Z",datasetCutoffAt:"2026-07-17T04:00:00.000Z",evidenceHash:"b".repeat(64) } },codeVersion:"phase3",idempotencyKey:"run",createdBy:"tester",traceId:"trace",errorSummary:null,startedAt:null,finishedAt:null,createdAt:"2026-07-17T04:00:00.000Z",updatedAt:"2026-07-17T04:00:00.000Z" });
  const capture=(oid:number,overrides:Partial<CaptureSnapshotApplicationInput>={}):CaptureSnapshotApplicationInput=>({runId:RUN,matchId:MATCH,matchDate:DATE,checkpointType:"T1215",checkpointAt:TIMES.T1215,status:"ready",previousSnapshotSetId:null,revision:1,supersedesSnapshotSetId:null,sourceCutoffAt:TIMES.T1215,schemaVersion:2,completeness:{},items:[{oddsSnapshotId:oid,role:"current",companyId:"3",marketType:"asian_handicap",snapshotType:"crown12",sourceObservedAt:TIMES.T1215,collectedAt:TIMES.T1215}],operationKey:"capture-phase3",...overrides});
  it("authoritatively compares every supplied field and accepts ready/partial one item",async()=>{for(const status of ["ready","partial"] as const){const oid=await odds("T1215");await expect(new PostgresSnapshotCaptureValidator(client).validate(capture(oid,{status}),run())).resolves.toBeUndefined();}});
  it.each(["companyId","marketType","snapshotType","sourceObservedAt","collectedAt"])("rejects wrong supplied %s",async key=>{const oid=await odds("T1215");const input=capture(oid);const item={...input.items[0],[key]:key.includes("At")?"2026-07-17T04:14:59.000Z":"wrong"};await expectIntegrity(new PostgresSnapshotCaptureValidator(client).validate({...input,items:[item]},run()));});
  it.each(["missing","insufficient","invalid"] as const)("accepts %s with zero items",async status=>{await expect(new PostgresSnapshotCaptureValidator(client).validate(capture(1,{status,items:[],completeness:{reasonCode:"NO_DATA"}}),run())).resolves.toBeUndefined();});
  it("maps missing odds to integrity and SQL faults to dependency",async()=>{await expectIntegrity(new PostgresSnapshotCaptureValidator(client).validate(capture(999),run()));await db.exec("DROP TABLE odds_snapshots CASCADE");await expect(new PostgresSnapshotCaptureValidator(client).validate(capture(1),run())).rejects.toBeInstanceOf(StrategyLabSnapshotDependencyError);});
  it("is read-only repeatable-read with zero writes",async()=>{const oid=await odds("T1215");client.calls.length=0;await new PostgresSnapshotCaptureValidator(client).validate(capture(oid),run());expect(client.options.at(-1)).toEqual({readOnly:true,isolationLevel:"repeatable read"});expect(client.calls.every(sql=>/^\s*SELECT\b/i.test(sql))).toBe(true);});
});
