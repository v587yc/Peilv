import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { stableStrategyJson } from "./normalization";
import { normalizeLeagueName } from "./policy-schemas";

export interface MatchFactFactoryInput {
  readonly id?: string; readonly matchId: string; readonly matchDate: string;
  readonly leagueNameRaw: string; readonly kickoffAt: string; readonly source: string;
  readonly sourceObservedAt: string; readonly datasetCutoffAt: string; readonly revision: number;
  readonly supersedesId: string | null; readonly schemaVersion?: 1; readonly traceId: string;
}

export function createCanonicalMatchFact(input: MatchFactFactoryInput) {
  const leagueNameNormalized = normalizeLeagueName(input.leagueNameRaw);
  if (!leagueNameNormalized || !input.matchId.trim() || !input.source.trim() || input.revision < 1) throw new TypeError("invalid match fact");
  const schemaVersion = input.schemaVersion ?? 1;
  const kickoffAt=new Date(input.kickoffAt).toISOString(); const sourceObservedAt=new Date(input.sourceObservedAt).toISOString(); const datasetCutoffAt=new Date(input.datasetCutoffAt).toISOString();
  if(!/^\d{8}$/.test(input.matchDate)||!Number.isFinite(Date.parse(kickoffAt))||!Number.isFinite(Date.parse(sourceObservedAt))||!Number.isFinite(Date.parse(datasetCutoffAt))||Date.parse(sourceObservedAt)>Date.parse(datasetCutoffAt)||(input.revision===1)!==(input.supersedesId===null)) throw new TypeError("invalid match fact");
  const canonicalPayload = {
    schemaVersion, matchId: input.matchId, matchDate: input.matchDate, league: leagueNameNormalized,
    kickoffAt, source: input.source,
    sourceObservedAt, datasetCutoffAt, revision: input.revision,
  } as const;
  return Object.freeze({ ...input, id: input.id ?? randomUUID(), schemaVersion, leagueNameNormalized, canonicalPayload: Object.freeze(canonicalPayload), contentHash: createHash("sha256").update(stableStrategyJson(canonicalPayload)).digest("hex") });
}
