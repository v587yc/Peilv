import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createCanonicalMatchFact } from "@/features/strategy-lab/match-fact";
import { PostgresLeaguePolicy, StrategyLabPolicyUnavailableError } from "@/features/strategy-lab/postgres-league-policy";
import { PostgresStrategyLabVersionProvider, registerBuiltInStrategyArtifacts, StrategyLabVersionUnavailableError } from "@/features/strategy-lab/postgres-version-provider";
import type { StrategyLabSqlClient, StrategyLabSqlExecutor } from "@/features/strategy-lab/postgres-repository";
import { BUILT_IN_STRATEGY_ARTIFACTS, STRATEGY_LAB_CODE_COMPATIBILITY } from "@/features/strategy-lab/strategy-artifacts";
import { strategyArtifactSetSchema } from "@/features/strategy-lab/strategy-runtime";
import { stableStrategyJson } from "@/features/strategy-lab/normalization";

const root = new URL("..", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const baseline = { id:"10000000-0000-4000-8000-000000000001", source_observed_at:"2026-07-17T10:00:00.000Z", completed_at:"2026-07-17T10:00:00.000Z", content_hash:hash("baseline") };
const event = (id:string, source:string, league:string, action:"add"|"remove", observed:string, revision=1) => ({ id, baseline_id:baseline.id, source, league_name_normalized:league, action, source_observed_at:observed, content_hash:hash(id), revision });
type SqlRow = Record<string, unknown>;
function executorFrom(handler:(sql:string,parameters:readonly unknown[])=>readonly SqlRow[]):StrategyLabSqlExecutor {
  return { async query<Row extends SqlRow>(sql:string,parameters:readonly unknown[]=[]){return {rows:handler(sql,parameters) as readonly Row[]};} };
}

function policyExecutor(events: readonly ReturnType<typeof event>[], hasBaseline = true) {
  const writes: { sql:string; parameters:readonly unknown[] }[] = [];
  const executor=executorFrom((sql,parameters) => {
    if (sql.includes("FROM strategy_lab_focused_league_baselines")) return hasBaseline ? [baseline] : [];
    if (sql.includes("FROM strategy_lab_focused_league_events")) return events;
    writes.push({ sql, parameters }); return [];
  });
  return { executor, writes };
}

type ArtifactDbRow = { strategy_id:"A"|"B"|"C"|"D";version:string;artifact_hash:string;engine_version:string;code_compatibility:string;behavior_corpus_hash:string;schema_version:number;definition:SqlRow;executable:boolean };
const artifactRows:ArtifactDbRow[] = Object.values(BUILT_IN_STRATEGY_ARTIFACTS).map(value => ({ strategy_id:value.strategyId, version:value.version, artifact_hash:value.artifactHash, engine_version:value.engineVersion, code_compatibility:value.codeCompatibility, behavior_corpus_hash:value.behaviorCorpusHash, schema_version:value.schemaVersion, definition:value.definition, executable:value.executable }));
const trusted = { buildId:"release-build", manifestDigest:hash("manifest"), commitSha:"a".repeat(40), releaseId:"r1-a1-aaaaaaaaaaaa", archiveSha256:hash("archive") };
function versionClient(rows:readonly ArtifactDbRow[] = artifactRows, builds:readonly SqlRow[] = [{ build_id:trusted.buildId, manifest_digest:trusted.manifestDigest, commit_sha:trusted.commitSha, release_id:trusted.releaseId, artifact_digest:trusted.archiveSha256, compatibility:STRATEGY_LAB_CODE_COMPATIBILITY }]) {
  const tx=executorFrom(sql => {
    if (sql.includes("strategy_lab_build_artifacts")) return builds;
    if (sql.includes("WITH eligible")) return rows;
    return [];
  });
  return { query:tx.query, transaction:async <T>(callback:(executor:StrategyLabSqlExecutor)=>Promise<T>)=>callback(tx) } satisfies StrategyLabSqlClient;
}

describe("Strategy Lab Phase2 final evidence", () => {
  it("keeps manifest ordered, setup synchronized and all eight tables hardened", async () => {
    const [migration, snapshotProviderMigration, setup, schema, manifestText] = await Promise.all([read("migrations/0021_strategy_lab_policy_and_artifacts.sql"), read("migrations/0022_strategy_lab_snapshot_provider.sql"), read("setup-database.sql"), read("src/storage/database/shared/schema.ts"), read("migrations/manifest.json")]);
    const manifest = JSON.parse(manifestText) as { migrations:{file:string;version:string;sha256:string}[] };
    const phase2Start=manifest.migrations.findIndex(item=>item.version==="0020_strategy_lab_fact_model");
    expect(manifest.migrations.slice(phase2Start,phase2Start+3).map(item=>item.file)).toEqual(["0020_strategy_lab_fact_model.sql", "0021_strategy_lab_policy_and_artifacts.sql", "0022_strategy_lab_snapshot_provider.sql"]);
    expect(manifest.migrations[phase2Start+1]?.sha256).toBe(hash(migration));
    expect(manifest.migrations[phase2Start+2]?.sha256).toBe(hash(snapshotProviderMigration));
    const tables = ["match_facts","focused_league_baselines","focused_league_events","league_policy_artifacts","league_policy_captures","strategy_artifacts","strategy_publications","build_artifacts"];
    for (const table of tables) {
      expect(migration).toContain(`CREATE TABLE strategy_lab_${table}`);
      expect(setup).toContain(`CREATE TABLE IF NOT EXISTS strategy_lab_${table}`);
      expect(schema).toContain(`"strategy_lab_${table}"`);
    }
    for (const field of ["canonical_payload","content_hash","revision","supersedes_id","evidence_hash","behavior_corpus_hash","engine_version","code_compatibility","effective_from","effective_to","manifest_digest"]) expect(setup).toContain(field);
    for (const contract of ["strategy_lab_canonicalize_text","strategy_lab_validate_match_fact_insert","strategy_lab_validate_focused_baseline_complete","strategy_lab_validate_publication_insert","DEFERRABLE INITIALLY DEFERRED","ENABLE ROW LEVEL SECURITY","FORCE ROW LEVEL SECURITY","REVOKE ALL ON TABLE","strategy_lab_match_facts_asof_idx","strategy_lab_policy_capture_asof_idx","strategy_lab_publication_supersedes_unique","0021_strategy_lab_policy_and_artifacts"]) { expect(migration).toContain(contract); expect(setup).toContain(contract); }
    expect(migration).not.toMatch(/CREATE POLICY/i); expect(setup).not.toMatch(/CREATE POLICY[^;]+strategy_lab_(?:match_facts|focused_league|league_policy|strategy_artifacts|strategy_publications|build_artifacts)/i);
  });

  it("keeps Drizzle and strict descriptor contracts synchronized without unknown casts", async () => {
    const [schema, runtime, artifacts] = await Promise.all([read("src/storage/database/shared/schema.ts"), read("src/features/strategy-lab/strategy-runtime.ts"), read("src/features/strategy-lab/strategy-artifacts.ts")]);
    for (const field of ["leagueNameRaw","leagueNameNormalized","canonicalPayload","contentHash","revision","supersedesId","evidenceHash","behaviorCorpusHash","effectiveFrom","manifestDigest"]) expect(schema).toContain(field);
    expect(`${runtime}\n${artifacts}`).not.toMatch(/as unknown|unknown as|\.passthrough\(|z\.unknown\(/);
    expect(() => strategyArtifactSetSchema.parse({ ...BUILT_IN_STRATEGY_ARTIFACTS, A:{ ...BUILT_IN_STRATEGY_ARTIFACTS.A, unexpected:true } })).toThrow();
  });

  it("builds match facts from raw input and rejects forged or reversed factory input", () => {
    const fact=createCanonicalMatchFact({id:"10000000-0000-4000-8000-000000000009",matchId:"m1",matchDate:"20260717",leagueNameRaw:" Cafe\u0301　联赛 ",kickoffAt:"2026-07-17T15:00Z",source:"schedule",sourceObservedAt:"2026-07-17T10:00Z",datasetCutoffAt:"2026-07-17T12:00Z",revision:1,supersedesId:null,traceId:"t"});
    expect(fact.leagueNameNormalized).toBe("Café 联赛"); expect(fact.canonicalPayload.league).toBe("Café 联赛"); expect(fact.contentHash).toBe(hash(stableStrategyJson(fact.canonicalPayload)));
    expect(() => createCanonicalMatchFact({ ...fact, leagueNameRaw:"英超", sourceObservedAt:"2026-07-17T13:00Z", datasetCutoffAt:"2026-07-17T12:00Z" })).toThrow();
  });

  it("fails policy closed without a complete nonempty baseline", async () => {
    for (const events of [[], [event("e1","admin","英超","remove","2026-07-17T11:00:00.000Z")]]) {
      const fixture=policyExecutor(events, events.length>0); const policy=new PostgresLeaguePolicy({query:fixture.executor.query,transaction:async callback=>callback(fixture.executor)});
      await expect(policy.captureWithExecutor(fixture.executor,{datasetCutoffAt:"2026-07-17T12:00:00Z",createdBy:"actor",traceId:"t"})).rejects.toBeInstanceOf(StrategyLabPolicyUnavailableError);
    }
  });

  it("applies add/remove history, freezes old captures and separates artifact from evidence hashes", async () => {
    const t1=policyExecutor([event("e1","admin","英超","add","2026-07-17T10:00:00.000Z")]);
    const t2=policyExecutor([event("e1","admin","英超","add","2026-07-17T10:00:00.000Z"),event("e2","admin","西甲","add","2026-07-17T11:00:00.000Z"),event("e3","admin","西甲","remove","2026-07-17T12:00:00.000Z",2)]);
    const policy=new PostgresLeaguePolicy({query:t1.executor.query,transaction:async callback=>callback(t1.executor)});
    const first=await policy.captureWithExecutor(t1.executor,{datasetCutoffAt:"2026-07-17T10:30:00Z",createdBy:"actor",traceId:"t1"});
    const second=await policy.captureWithExecutor(t2.executor,{datasetCutoffAt:"2026-07-17T12:30:00Z",createdBy:"actor",traceId:"t2"});
    expect(second.artifactHash).toBe(first.artifactHash); expect(second.captureId).not.toBe(first.captureId); expect(second.evidenceHash).not.toBe(first.evidenceHash); expect(first.datasetCutoffAt).toBe("2026-07-17T10:30:00.000Z");
    expect(JSON.parse(String(t1.writes[0].parameters[2]))).toEqual({schemaVersion:1,mode:"user_focused_leagues",leagues:["英超"]});
  });

  it("fails closed on multi-source conflict and recovers after a later source decision resolves it", async () => {
    const conflict=policyExecutor([event("e1","admin","英超","add","2026-07-17T10:00:00.000Z"),event("e2","sync","英超","remove","2026-07-17T11:00:00.000Z")]);
    const policy=new PostgresLeaguePolicy({query:conflict.executor.query,transaction:async callback=>callback(conflict.executor)});
    await expect(policy.captureWithExecutor(conflict.executor,{datasetCutoffAt:"2026-07-17T12:00:00Z",createdBy:"a",traceId:"t"})).rejects.toBeInstanceOf(StrategyLabPolicyUnavailableError);
    const resolved=policyExecutor([event("e1","admin","英超","add","2026-07-17T10:00:00.000Z"),event("e2","sync","英超","remove","2026-07-17T11:00:00.000Z"),event("e3","sync","英超","add","2026-07-17T12:00:00.000Z",2)]);
    await expect(policy.captureWithExecutor(resolved.executor,{datasetCutoffAt:"2026-07-17T13:00:00Z",createdBy:"a",traceId:"t"})).resolves.toMatchObject({mode:"user_focused_leagues"});
  });

  it.each([
    ["zero artifacts", []], ["multiple identity", [...artifactRows, artifactRows[0]]],
    ["hash mismatch", artifactRows.map((row,index)=>index?row:{...row,artifact_hash:"f".repeat(64)})],
    ["behavior mismatch", artifactRows.map((row,index)=>index?row:{...row,behavior_corpus_hash:"e".repeat(64)})],
    ["schema mismatch", artifactRows.map((row,index)=>index?row:{...row,schema_version:2})],
    ["engine mismatch", artifactRows.map((row,index)=>index?row:{...row,engine_version:"unknown"})],
  ])("rejects VersionProvider %s", async (_name, rows) => {
    const provider=new PostgresStrategyLabVersionProvider(versionClient(rows),{captureWithExecutor:vi.fn()} as never,"lookup",{load:vi.fn(async()=>trusted)});
    await expect(provider.load({datasetCutoffAt:"2026-07-17T12:00:00Z",createdBy:"a",traceId:"t"})).rejects.toBeInstanceOf(StrategyLabVersionUnavailableError);
  });

  it("rejects unknown build identity and preserves C deferred and D nonexecutable descriptors", async () => {
    const provider=new PostgresStrategyLabVersionProvider(versionClient(artifactRows,[]),{captureWithExecutor:vi.fn()} as never,"lookup",{load:vi.fn(async()=>trusted)});
    await expect(provider.load({datasetCutoffAt:"2026-07-17T12:00:00Z",createdBy:"a",traceId:"t"})).rejects.toBeInstanceOf(StrategyLabVersionUnavailableError);
    expect(BUILT_IN_STRATEGY_ARTIFACTS.C.definition).toMatchObject({fallback:"A",completeWithoutExecutor:"unavailable"}); expect(BUILT_IN_STRATEGY_ARTIFACTS.D.executable).toBe(false);
  });

  it("lets a valid v2 publication take over while an earlier cutoff remains on v1", async () => {
    const definition={...BUILT_IN_STRATEGY_ARTIFACTS.A.definition,version:"A-v2"};
    const canonical={schemaVersion:1,engineVersion:BUILT_IN_STRATEGY_ARTIFACTS.A.engineVersion,codeCompatibility:BUILT_IN_STRATEGY_ARTIFACTS.A.codeCompatibility,behaviorCorpusHash:BUILT_IN_STRATEGY_ARTIFACTS.A.behaviorCorpusHash,definition};
    const v2={...artifactRows[0],version:"A-v2",definition,artifact_hash:hash(stableStrategyJson(canonical))};
    const policyCapture={mode:"user_focused_leagues" as const,artifactHash:hash("policy"),captureId:"10000000-0000-4000-8000-000000000099",capturedAt:"2026-07-17T12:00:00.000Z",datasetCutoffAt:"2026-07-17T12:00:00.000Z",evidenceHash:hash("evidence")};
    const baseClient=versionClient();
    const client:StrategyLabSqlClient={query:baseClient.query,transaction:async callback=>callback(executorFrom((sql,parameters)=>{
      if(sql.includes("strategy_lab_build_artifacts")) return [{build_id:trusted.buildId,manifest_digest:trusted.manifestDigest,commit_sha:trusted.commitSha,release_id:trusted.releaseId,artifact_digest:trusted.archiveSha256,compatibility:STRATEGY_LAB_CODE_COMPATIBILITY}];
      if(sql.includes("WITH eligible")) return new Date(String(parameters[0])).getUTCHours()<13?artifactRows:[v2,...artifactRows.slice(1)];
      return [];
    }))};
    const provider=new PostgresStrategyLabVersionProvider(client,{captureWithExecutor:vi.fn(async()=>policyCapture)} as never,"lookup",{load:vi.fn(async()=>trusted)});
    const historical=await provider.load({datasetCutoffAt:"2026-07-17T12:00:00Z",createdBy:"a",traceId:"t1"});
    const current=await provider.load({datasetCutoffAt:"2026-07-17T14:00:00Z",createdBy:"a",traceId:"t2"});
    expect(historical.strategyVersions.A.version).toBe("A-v1"); expect(current.strategyVersions.A.version).toBe("A-v2"); expect(historical.strategyVersions.A.version).toBe("A-v1");
  });

  it("registers builtins idempotently and fails closed on identity conflict", async () => {
    const inserts:string[]=[]; const executor=executorFrom((sql,parameters)=>{if(sql.startsWith("SELECT artifact_hash")){const id=String(parameters[0]) as keyof typeof BUILT_IN_STRATEGY_ARTIFACTS;return [{artifact_hash:BUILT_IN_STRATEGY_ARTIFACTS[id].artifactHash}];}if(sql.includes("WITH latest")) return [{artifact_hash:"published"}];inserts.push(sql);return [];});
    const client={query:executor.query,transaction:async<T>(callback:(tx:StrategyLabSqlExecutor)=>Promise<T>)=>callback(executor)} satisfies StrategyLabSqlClient;
    await registerBuiltInStrategyArtifacts({client,effectiveFrom:"2026-07-17T10:00:00Z",createdBy:"a",traceId:"t"});
    const conflict=executorFrom(sql=>sql.startsWith("SELECT artifact_hash")?[{artifact_hash:"f".repeat(64)}]:[]);
    await expect(registerBuiltInStrategyArtifacts({client:{query:conflict.query,transaction:async callback=>callback(conflict)},effectiveFrom:"2026-07-17T10:00:00Z",createdBy:"a",traceId:"t"})).rejects.toBeInstanceOf(StrategyLabVersionUnavailableError);
    expect(inserts.filter(sql=>sql.startsWith("INSERT INTO strategy_lab_strategy_publications"))).toHaveLength(0);
  });

  it("keeps server-only providers out of the public index and production fail-closed", async () => {
    const [index, composition, health] = await Promise.all([read("src/features/strategy-lab/index.ts"),read("tests/strategy-lab-production-composition.test.ts"),read("tests/strategy-lab-production-health.test.ts")]);
    expect(index).not.toMatch(/postgres-|production-server|match-fact|trusted-build/); expect(composition).toContain("snapshotProvider"); expect(composition).toContain("service).toBeNull"); expect(health).toContain("STRATEGY_LAB_DEPENDENCIES_INCOMPLETE"); expect(health).toContain("503");
  });
});
