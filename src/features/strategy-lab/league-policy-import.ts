import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { canonicalLeagueSet, normalizeLeagueName } from "./policy-schemas";
import { stableStrategyJson } from "./normalization";
import type { StrategyLabSqlClient } from "./postgres-repository";

const hash = (value: unknown) => createHash("sha256").update(stableStrategyJson(value)).digest("hex");

/** Imports the mutable whitelist only as a complete baseline observed now; it cannot backdate history. */
export async function importCurrentFocusedLeagueBaseline(input: { client: StrategyLabSqlClient; source: string; actor: string; traceId: string; clock?: () => Date }) {
  const startedAt=(input.clock ?? (() => new Date()))(); if(!Number.isFinite(startedAt.valueOf())||!input.source.trim())throw new TypeError("invalid current baseline import");
  const observedAt = startedAt.toISOString();
  return input.client.transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    const rows = await tx.query<{ league_name: string }>("SELECT league_name FROM user_focused_leagues ORDER BY league_name");
    const leagues = canonicalLeagueSet(rows.rows.map(row => row.league_name));
    const baselineId = randomUUID();
    const canonicalPayload = { schemaVersion: 1, baselineId, source: input.source, sourceObservedAt: observedAt, leagues } as const;
    const contentHash = hash(canonicalPayload);
    await tx.query(`INSERT INTO strategy_lab_focused_league_baselines(id,source,source_observed_at,dataset_cutoff_at,canonical_payload,content_hash,member_count,is_complete,completed_at,actor,trace_id)
      VALUES($1,$2,$3,$3,$4::jsonb,$5,$6,TRUE,$3,$7,$8)`, [baselineId,input.source,observedAt,JSON.stringify(canonicalPayload),contentHash,leagues.length,input.actor,input.traceId]);
    for (const league of leagues) {
      const eventId=randomUUID(); const eventPayload={schemaVersion:1,baselineId,source:input.source,league,action:"add",sourceObservedAt:observedAt,datasetCutoffAt:observedAt,revision:1};
      await tx.query(`INSERT INTO strategy_lab_focused_league_events(id,baseline_id,source,league_name_raw,league_name_normalized,action,source_observed_at,dataset_cutoff_at,canonical_payload,content_hash,revision,supersedes_id,actor,trace_id)
        VALUES($1,$2,$3,$4,$4,'add',$5,$5,$6::jsonb,$7,1,NULL,$8,$9)`,[eventId,baselineId,input.source,league,observedAt,JSON.stringify(eventPayload),hash(eventPayload),input.actor,input.traceId]);
    }
    return Object.freeze({ baselineId, observedAt, contentHash, memberCount: leagues.length });
  });
}

export function createFocusedLeagueEvent(input: { baselineId: string; source: string; leagueNameRaw: string; action: "add"|"remove"; sourceObservedAt: string; datasetCutoffAt: string; revision: number; supersedesId: string|null; actor: string; traceId: string }) {
  const leagueNameNormalized=normalizeLeagueName(input.leagueNameRaw); if(!leagueNameNormalized) throw new TypeError("invalid league event");
  const canonicalPayload={schemaVersion:1,baselineId:input.baselineId,source:input.source,league:leagueNameNormalized,action:input.action,sourceObservedAt:new Date(input.sourceObservedAt).toISOString(),datasetCutoffAt:new Date(input.datasetCutoffAt).toISOString(),revision:input.revision};
  return Object.freeze({...input,id:randomUUID(),leagueNameNormalized,canonicalPayload:Object.freeze(canonicalPayload),contentHash:hash(canonicalPayload)});
}
