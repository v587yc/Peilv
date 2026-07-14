import type { FetchLike } from "./api-client";
import type { CompanyOddsData, MatchData } from "./contracts";
import type { OddsScheduleMode } from "./automatic-odds-fetch";
import { isLeagueSelected } from "./league-matching";

export interface CrownSnapshot {
  handicapHome: string | null;
  handicapLine: string | null;
  handicapAway: string | null;
  totalOver: string | null;
  totalLine: string | null;
  totalUnder: string | null;
  euroHome?: string | null;
  euroDraw?: string | null;
  euroAway?: string | null;
  handicapObservedAt?: string | null;
  totalObservedAt?: string | null;
  euroObservedAt?: string | null;
}

export interface SupplementalOddsResult {
  openTimes: Record<string, string>;
  crownOpen: CrownSnapshot | null;
  crownFinal: CrownSnapshot | null;
}

export interface SupplementalOddsRequest {
  matchId: string;
  companyIds: string[];
  includeCrownOpen: boolean;
}

export interface SupplementalPersistenceRequest {
  matchId: string;
  matchDate: string;
  openTimesData?: Record<string, string>;
  crown12Odds?: CrownSnapshot | null;
  crownLiveOdds?: CrownSnapshot | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function snapshot(value: unknown): CrownSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  return {
    handicapHome: text(item.handicapHome) || null,
    handicapLine: text(item.handicapLine) || null,
    handicapAway: text(item.handicapAway) || null,
    totalOver: text(item.totalOver) || null,
    totalLine: text(item.totalLine) || null,
    totalUnder: text(item.totalUnder) || null,
    ...(typeof item.euroHome === "string" ? { euroHome: item.euroHome || null } : {}),
    ...(typeof item.euroDraw === "string" ? { euroDraw: item.euroDraw || null } : {}),
    ...(typeof item.euroAway === "string" ? { euroAway: item.euroAway || null } : {}),
    ...(typeof item.handicapObservedAt === "string" ? { handicapObservedAt: item.handicapObservedAt || null } : {}),
    ...(typeof item.totalObservedAt === "string" ? { totalObservedAt: item.totalObservedAt || null } : {}),
    ...(typeof item.euroObservedAt === "string" ? { euroObservedAt: item.euroObservedAt || null } : {}),
  };
}

export type SupplementalFetchType = "opentimes" | "crownOpen" | "odds" | "crownFinal" | "revalidate";

export function selectSupplementalTargets(input: {
  type: SupplementalFetchType;
  matches: MatchData[];
  selectedLeagues: Set<string>;
  scheduleMode: OddsScheduleMode;
  fetchedMatchIds: Set<string>;
  oddsByMatch: Map<string, CompanyOddsData>;
  crownOpenByMatch: ReadonlyMap<string, unknown>;
}): MatchData[] {
  return input.matches.filter(match => {
    if (input.selectedLeagues.size > 0 && !isLeagueSelected(match.league, input.selectedLeagues)) return false;
    if (input.type !== "crownFinal" && input.scheduleMode !== "history" && match.state !== "0") return false;
    const fetched = input.fetchedMatchIds.has(match.id);
    if (input.type === "odds") return !fetched;
    if (input.type === "revalidate") return fetched;
    if (input.type === "crownOpen") return fetched && !input.crownOpenByMatch.has(match.id);
    if (input.type === "opentimes") {
      const companies = input.oddsByMatch.get(match.id)?.companies || [];
      return fetched && companies.every(company => !company.openTime);
    }
    if (!fetched) return false;
    if (input.scheduleMode !== "history" && !(input.scheduleMode === "today" && match.state !== "0")) return false;
    const crown = input.oddsByMatch.get(match.id)?.companies.find(company => company.companyId === "3");
    return !(crown?.ftHandicapLineLive || crown?.ftTotalLineLive);
  });
}

export interface SupplementalTargetCounts {
  odds: number;
  opentimes: number;
  crownOpen: number;
  crownFinal: number;
}

export function countSupplementalTargets(
  input: Omit<Parameters<typeof selectSupplementalTargets>[0], "type">,
): SupplementalTargetCounts {
  return {
    odds: selectSupplementalTargets({ ...input, type: "odds" }).length,
    opentimes: selectSupplementalTargets({ ...input, type: "opentimes" }).length,
    crownOpen: selectSupplementalTargets({ ...input, type: "crownOpen" }).length,
    crownFinal: selectSupplementalTargets({ ...input, type: "crownFinal" }).length,
  };
}

export function buildSupplementalPersistence(
  matchId: string,
  matchDate: string,
  result: SupplementalOddsResult,
): SupplementalPersistenceRequest {
  return {
    matchId,
    matchDate,
    ...(Object.keys(result.openTimes).length ? { openTimesData: result.openTimes } : {}),
    ...(result.crownOpen && (result.crownOpen.handicapLine || result.crownOpen.totalLine) ? { crown12Odds: result.crownOpen } : {}),
    ...(result.crownFinal && (result.crownFinal.handicapLine || result.crownFinal.totalLine) ? { crownLiveOdds: result.crownFinal } : {}),
  };
}

export interface SupplementalUpdateOutcome {
  matchId: string;
  odds?: CompanyOddsData;
  crownOpen?: CrownSnapshot;
  crownFinal?: CrownSnapshot;
}

export async function runSupplementalOddsUpdate(input: {
  match: MatchData;
  currentDate: string;
  companyIds: string[];
  includeCrownOpen: boolean;
  generation: number;
  currentGeneration(): number;
  readOdds(matchId: string): CompanyOddsData | undefined;
  fetch(request: SupplementalOddsRequest): Promise<SupplementalOddsResult>;
  persist(request: SupplementalPersistenceRequest): Promise<void>;
}): Promise<SupplementalUpdateOutcome | null> {
  const result = await input.fetch({
    matchId: input.match.id,
    companyIds: input.companyIds,
    includeCrownOpen: input.includeCrownOpen,
  });
  if (input.generation !== input.currentGeneration()) return null;

  const latest = input.readOdds(input.match.id);
  const matchDate = input.match.matchDate || input.currentDate;
  if (!matchDate) return null;
  const persistence = buildSupplementalPersistence(input.match.id, matchDate, result);
  if (persistence.openTimesData || persistence.crown12Odds || persistence.crownLiveOdds) {
    await input.persist(persistence);
  }
  if (input.generation !== input.currentGeneration()) return null;

  let reconciled: CompanyOddsData | undefined;
  if (latest && Object.keys(result.openTimes).length > 0) {
    reconciled = {
      ...latest,
      openTime: result.openTimes["3"] || latest.openTime,
      companies: (latest.companies || []).map(company => ({
        ...company,
        openTime: result.openTimes[company.companyId] || company.openTime,
      })),
    };
  }
  return {
    matchId: input.match.id,
    ...(reconciled ? { odds: reconciled } : {}),
    ...(result.crownOpen && (result.crownOpen.handicapLine || result.crownOpen.totalLine) ? { crownOpen: result.crownOpen } : {}),
    ...(result.crownFinal && (result.crownFinal.handicapLine || result.crownFinal.totalLine) ? { crownFinal: result.crownFinal } : {}),
  };
}

export async function runSupplementalBatch(input: {
  type: SupplementalFetchType;
  targets: MatchData[];
  signal: AbortSignal;
  fetchMatch(matchId: string, signal: AbortSignal): Promise<unknown>;
  updateSupplement(match: MatchData, signal: AbortSignal): Promise<SupplementalUpdateOutcome | null>;
  apply(outcome: SupplementalUpdateOutcome): void;
  progress(done: number, total: number): void;
  delay?: (milliseconds: number) => Promise<void>;
}): Promise<number> {
  const delay = input.delay ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  let completed = 0;
  for (const match of input.targets) {
    if (input.signal.aborted) break;
    if (input.type === "odds" || input.type === "crownFinal" || input.type === "revalidate") {
      await Promise.allSettled([input.fetchMatch(match.id, input.signal)]);
    } else {
      const result = await Promise.allSettled([input.updateSupplement(match, input.signal)]);
      const outcome = result[0].status === "fulfilled" ? result[0].value : null;
      if (!input.signal.aborted && outcome) input.apply(outcome);
    }
    completed += 1;
    input.progress(completed, input.targets.length);
    if (!input.signal.aborted && completed < input.targets.length) {
      await delay(input.type === "odds" || input.type === "crownFinal" ? 100 : 200);
    }
  }
  return completed;
}

export async function fetchSupplementalOdds(
  fetcher: FetchLike,
  request: SupplementalOddsRequest,
  signal?: AbortSignal,
): Promise<SupplementalOddsResult> {
  const companies = encodeURIComponent(request.companyIds.join(","));
  const response = await fetcher(
    `/api/data/match/${encodeURIComponent(request.matchId)}/opentimes?companies=${companies}&crownOpen=${request.includeCrownOpen}`,
    { signal },
  );
  const payload = await json(response);
  if (!response.ok || payload.success !== true) {
    throw new Error(text(payload.error) || "开盘时间抓取失败");
  }
  const openTimes: Record<string, string> = {};
  if (Array.isArray(payload.data)) {
    for (const raw of payload.data) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const companyId = text(entry.companyId);
      if (companyId) openTimes[companyId] = text(entry.openTime);
    }
  }
  return {
    openTimes,
    crownOpen: snapshot(payload.crownOpen),
    crownFinal: snapshot(payload.crownTerminal),
  };
}

export async function persistSupplementalOdds(
  fetcher: FetchLike,
  request: SupplementalPersistenceRequest,
  signal?: AbortSignal,
): Promise<void> {
  const body = {
    matchId: request.matchId,
    matchDate: request.matchDate,
    ...(request.openTimesData && Object.keys(request.openTimesData).length ? { openTimesData: request.openTimesData } : {}),
    ...(request.crown12Odds ? { crown12Odds: request.crown12Odds } : {}),
    ...(request.crownLiveOdds ? { crownLiveOdds: request.crownLiveOdds } : {}),
  };
  const response = await fetcher("/api/data/odds-db", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await json(response);
  if (!response.ok || payload.success !== true) {
    throw new Error(text(payload.error) || "赔率快照保存失败");
  }
}
