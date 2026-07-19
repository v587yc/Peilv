import type { FetchLike } from "./api-client";
import type { CompanyOddsData, CrownStoredOdds } from "./contracts";
import { canApplyDatabaseOdds } from "@/lib/odds-client-merge";
import { canApplyDatabaseObservation } from "@/lib/odds-refresh";

export interface DatabaseOddsMeta {
  source: string | null;
  sourceObservedAt: string | null;
  writeToken?: string | null;
}

export interface DatabaseOddsResult {
  date: string;
  matchIds: string[];
  oddsMap: Record<string, CompanyOddsData>;
  oddsMetaMap: Record<string, DatabaseOddsMeta>;
  crownLiveOddsMap: Record<string, CrownStoredOdds>;
  crown12OddsMap: Record<string, CrownStoredOdds>;
}

export interface MergedDatabaseOdds {
  odds: Map<string, CompanyOddsData>;
  metadata: Map<string, DatabaseOddsMeta>;
  fetched: Set<string>;
  crownLive: Map<string, CrownStoredOdds>;
  crownOpen: Map<string, CrownStoredOdds>;
  readyDates: string[];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function decodeResult(date: string, value: unknown): DatabaseOddsResult | null {
  const payload = object(value);
  if (payload.success !== true) return null;
  const data = object(payload.data);
  if (!Array.isArray(data.matchIds)) return null;
  return {
    date,
    matchIds: data.matchIds.filter((id): id is string => typeof id === "string"),
    oddsMap: object(data.oddsMap) as Record<string, CompanyOddsData>,
    oddsMetaMap: object(data.oddsMetaMap) as Record<string, DatabaseOddsMeta>,
    crownLiveOddsMap: object(data.crownLiveOddsMap) as Record<string, CrownStoredOdds>,
    crown12OddsMap: object(data.crown12OddsMap) as Record<string, CrownStoredOdds>,
  };
}

export async function fetchDatabaseOddsDate(fetcher: FetchLike, date: string): Promise<DatabaseOddsResult | null> {
  const response = await fetcher(`/api/data/odds-db?date=${encodeURIComponent(date)}&slim=1`);
  if (!response.ok) return null;
  try {
    return decodeResult(date, await response.json());
  } catch {
    return null;
  }
}

export function dateKeysInRange(startDate: string, endDate: string): string[] {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const dates: string[] = [];
  for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
    dates.push(date.toISOString().slice(0, 10).replace(/-/g, ""));
  }
  return dates;
}

export async function fetchDatabaseOddsRange(
  fetcher: FetchLike,
  startDate: string,
  endDate: string,
  batchSize = 3,
): Promise<DatabaseOddsResult[]> {
  const dates = dateKeysInRange(startDate, endDate);
  const results: DatabaseOddsResult[] = [];
  for (let index = 0; index < dates.length; index += batchSize) {
    const settled = await Promise.allSettled(
      dates.slice(index, index + batchSize).map(date => fetchDatabaseOddsDate(fetcher, date)),
    );
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) results.push(result.value);
    }
  }
  return results;
}

export function mergeDatabaseOddsResults(
  results: DatabaseOddsResult[],
  currentMetadata: Map<string, Pick<DatabaseOddsMeta, "sourceObservedAt">>,
): MergedDatabaseOdds {
  const merged: MergedDatabaseOdds = {
    odds: new Map(), metadata: new Map(), fetched: new Set(), crownLive: new Map(), crownOpen: new Map(),
    readyDates: results.map(result => result.date),
  };
  for (const result of results) {
    for (const matchId of result.matchIds) {
      const odds = result.oddsMap[matchId];
      const metadata = result.oddsMetaMap[matchId];
      if (!odds || !canApplyDatabaseObservation(metadata?.sourceObservedAt, currentMetadata.get(matchId)?.sourceObservedAt)) continue;
      merged.odds.set(matchId, odds);
      merged.metadata.set(matchId, metadata || { source: null, sourceObservedAt: null });
      if (Array.isArray(odds.companies) && odds.companies.length > 0) merged.fetched.add(matchId);
    }
    for (const [matchId, snapshot] of Object.entries(result.crownLiveOddsMap)) merged.crownLive.set(matchId, snapshot);
    for (const [matchId, snapshot] of Object.entries(result.crown12OddsMap)) merged.crownOpen.set(matchId, snapshot);
  }
  return merged;
}

export interface GenerationDatabaseLoadController {
  beginGeneration(): number;
  currentGeneration(): number;
  markOddsReady(date: string, generation: number): void;
  markPredictionsReady(date: string, generation: number): void;
  isReady(date: string): boolean;
  isCurrent(generation: number): boolean;
  loadPredictions<T>(
    date: string,
    generation: number,
    load: () => Promise<T>,
    apply: (value: T) => void,
    onError?: (error: unknown) => void,
  ): Promise<void>;
}

export function createGenerationDatabaseLoadController(): GenerationDatabaseLoadController {
  let generation = 0;
  let readiness = new Map<string, { odds: boolean; predictions: boolean }>();
  const readyEntry = (date: string) => readiness.get(date) ?? { odds: false, predictions: false };
  return {
    beginGeneration() {
      generation += 1;
      readiness = new Map();
      return generation;
    },
    currentGeneration: () => generation,
    isCurrent: candidate => candidate === generation,
    markOddsReady(date, candidate) {
      if (candidate !== generation) return;
      readiness.set(date, { ...readyEntry(date), odds: true });
    },
    markPredictionsReady(date, candidate) {
      if (candidate !== generation) return;
      readiness.set(date, { ...readyEntry(date), predictions: true });
    },
    isReady(date) {
      const entry = readiness.get(date);
      return Boolean(entry?.odds && entry.predictions);
    },
    async loadPredictions(date, candidate, load, apply, onError) {
      try {
        const value = await load();
        if (candidate === generation) apply(value);
      } catch (error) {
        if (candidate === generation) onError?.(error);
      } finally {
        if (candidate === generation) readiness.set(date, { ...readyEntry(date), predictions: true });
      }
    },
  };
}

export interface DatabaseOddsApplicationInput {
  results: DatabaseOddsResult[];
  currentMetadata: Map<string, Pick<DatabaseOddsMeta, "sourceObservedAt">>;
  requestStartVersion: number;
  refreshVersions: Map<string, number>;
  persistedVersions: Map<string, number>;
}

export function projectDatabaseOddsApplication(input: DatabaseOddsApplicationInput): MergedDatabaseOdds {
  const merged = mergeDatabaseOddsResults(input.results, input.currentMetadata);
  const canApply = (matchId: string) => canApplyDatabaseOdds(
    input.requestStartVersion,
    input.refreshVersions.get(matchId),
    input.persistedVersions.get(matchId),
  );
  return {
    odds: new Map([...merged.odds].filter(([matchId]) => canApply(matchId))),
    metadata: new Map([...merged.metadata].filter(([matchId]) => canApply(matchId))),
    fetched: new Set([...merged.fetched].filter(canApply)),
    crownLive: new Map([...merged.crownLive].filter(([matchId]) => canApply(matchId))),
    crownOpen: new Map([...merged.crownOpen].filter(([matchId]) => canApply(matchId))),
    readyDates: merged.readyDates,
  };
}
