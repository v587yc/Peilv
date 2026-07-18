import { randomUUID } from "node:crypto";
import type { StrategyLabSqlClient, StrategyLabSqlExecutor } from "./postgres-repository";
import { canonicalLeagueSet, leagueHistoryEvidenceHash, leaguePolicyHash, strategyLabHashSchema, strategyLabUuidSchema } from "./policy-schemas";

export class StrategyLabPolicyUnavailableError extends Error { constructor() { super("strategy laboratory league policy unavailable"); } }
type EventRow = { id: string; baseline_id: string; source: string; league_name_normalized: string; action: "add" | "remove"; source_observed_at: string; content_hash: string; revision: number };

export class PostgresLeaguePolicy {
  constructor(private readonly client: StrategyLabSqlClient) {}

  async capture(input: { datasetCutoffAt: string; createdBy: string; traceId: string }) {
    return this.client.transaction(async tx => { await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); return this.captureWithExecutor(tx, input); });
  }

  async captureWithExecutor(tx: StrategyLabSqlExecutor, input: { datasetCutoffAt: string; createdBy: string; traceId: string }) {
    const cutoff = new Date(input.datasetCutoffAt); if (!Number.isFinite(cutoff.valueOf())) throw new StrategyLabPolicyUnavailableError();
    const baseline = await tx.query<{ id:string;source_observed_at:string;completed_at:string;content_hash:string }>("SELECT id,source_observed_at,completed_at,content_hash FROM strategy_lab_focused_league_baselines WHERE is_complete=TRUE AND completed_at=source_observed_at AND source_observed_at<=$1 ORDER BY source_observed_at DESC,id DESC LIMIT 1", [cutoff.toISOString()]);
    if (baseline.rows.length !== 1) throw new StrategyLabPolicyUnavailableError();
    const events = await tx.query<EventRow>(`SELECT id,baseline_id,source,league_name_normalized,action,source_observed_at,content_hash,revision FROM strategy_lab_focused_league_events WHERE source_observed_at>=$1 AND source_observed_at<=$2 AND dataset_cutoff_at<=$2 ORDER BY source_observed_at ASC,convert_to(source,'UTF8'),convert_to(league_name_normalized,'UTF8'),revision ASC,id`, [baseline.rows[0].source_observed_at,cutoff.toISOString()]);
    const latestBySource = new Map<string,EventRow>();
    for(const event of events.rows) latestBySource.set(`${event.source}\u0000${event.league_name_normalized}`,event);
    const decisions=new Map<string,Set<"add"|"remove">>();
    for(const event of latestBySource.values()){const set=decisions.get(event.league_name_normalized)??new Set();set.add(event.action);decisions.set(event.league_name_normalized,set);}
    if([...decisions.values()].some(actions=>actions.size>1)) throw new StrategyLabPolicyUnavailableError();
    const active = [...decisions].filter(([,actions])=>actions.has("add")).map(([league])=>league);
    let leagues:readonly string[]; try{leagues=canonicalLeagueSet(active);}catch{throw new StrategyLabPolicyUnavailableError();}
    const artifactHash = leaguePolicyHash(leagues); const captureId = randomUUID(); const capturedAt = new Date().toISOString();
    const canonicalPayload = { schemaVersion: 1, mode: "user_focused_leagues", leagues };
    await tx.query(`INSERT INTO strategy_lab_league_policy_artifacts(content_hash,version_hash,mode,leagues,canonical_payload,source_row_count,schema_version) VALUES($1,$1,'user_focused_leagues',$2::jsonb,$3::jsonb,$4,1) ON CONFLICT(content_hash) DO NOTHING`, [artifactHash, JSON.stringify(leagues), JSON.stringify(canonicalPayload), leagues.length]);
    const evidenceHash = leagueHistoryEvidenceHash({schemaVersion:1,baseline:{id:baseline.rows[0].id,contentHash:baseline.rows[0].content_hash,completedAt:new Date(baseline.rows[0].completed_at).toISOString(),sourceObservedAt:new Date(baseline.rows[0].source_observed_at).toISOString()},datasetCutoffAt:cutoff.toISOString(),events:events.rows.map(row=>({id:row.id,contentHash:row.content_hash,action:row.action,league:row.league_name_normalized,source:row.source,sourceObservedAt:new Date(row.source_observed_at).toISOString(),revision:row.revision}))});
    await tx.query(`INSERT INTO strategy_lab_league_policy_captures(id,artifact_hash,dataset_cutoff_at,captured_at,source_history_cutoff,evidence_hash,created_by,trace_id) VALUES($1,$2,$3,$4,$3,$5,$6,$7)`, [captureId, artifactHash, cutoff.toISOString(), capturedAt, evidenceHash, input.createdBy, input.traceId]);
    return Object.freeze({ mode: "user_focused_leagues" as const, artifactHash, captureId, capturedAt, datasetCutoffAt: cutoff.toISOString(), evidenceHash });
  }

  async allows(input: { matchId: string; matchDate: string; policyArtifactHash: string; policyCaptureId: string; datasetCutoffAt: string }): Promise<boolean> {
    if (!input.matchId.trim() || !/^\d{8}$/.test(input.matchDate) || !strategyLabHashSchema.safeParse(input.policyArtifactHash).success || !strategyLabUuidSchema.safeParse(input.policyCaptureId).success) throw new StrategyLabPolicyUnavailableError();
    return this.client.transaction(async tx => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const policy = await tx.query<{ leagues: string[] }>(`SELECT a.leagues FROM strategy_lab_league_policy_captures c JOIN strategy_lab_league_policy_artifacts a ON a.content_hash=c.artifact_hash WHERE c.id=$1 AND c.artifact_hash=$2 AND c.dataset_cutoff_at=$3`, [input.policyCaptureId,input.policyArtifactHash,new Date(input.datasetCutoffAt).toISOString()]);
      if (policy.rows.length !== 1) throw new StrategyLabPolicyUnavailableError();
      const facts = await tx.query<{ league_name_normalized: string }>(`WITH latest AS (SELECT DISTINCT ON(source) source,league_name_normalized FROM strategy_lab_match_facts WHERE match_id=$1 AND match_date=$2 AND source_observed_at<=$3 AND dataset_cutoff_at<=$3 ORDER BY source,source_observed_at DESC,revision DESC) SELECT DISTINCT league_name_normalized FROM latest`, [input.matchId,input.matchDate,new Date(input.datasetCutoffAt).toISOString()]);
      if (facts.rows.length !== 1) throw new StrategyLabPolicyUnavailableError();
      return policy.rows[0].leagues.includes(facts.rows[0].league_name_normalized);
    });
  }
}
