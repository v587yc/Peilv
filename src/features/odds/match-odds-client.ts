import type { FetchLike } from "./api-client";
import type { CompanyOddsItem, MatchData } from "./contracts";

export interface MatchOddsData {
  matchId: string;
  openTime: string;
  companies: CompanyOddsItem[];
}

export interface MatchDetailScore {
  id: string;
  state?: string;
  time?: string;
  matchDate?: string;
  homeTeam?: string;
  awayTeam?: string;
  homeScore?: string;
  awayScore?: string;
  halfHomeScore?: string;
  halfAwayScore?: string;
  league?: string;
  source?: string;
  observedAt?: string;
}

export interface MatchOddsSourceResult {
  data: MatchOddsData;
  source: string;
  sourceObservedAt: string;
  score: MatchDetailScore | null;
}

export interface PersistMatchOddsRequest {
  matchId: string;
  matchDate: string;
  companyIds: string;
  oddsData: MatchOddsData;
  source: string;
  sourceObservedAt: string;
  writeToken: string;
}

export interface PersistMatchOddsResult {
  applied: boolean;
  sourceObservedAt?: string;
}

type ExistingOdds = MatchOddsData | undefined;

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function mapCompany(value: unknown, existingOpenTimes: Map<string, string>): CompanyOddsItem {
  const company = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const companyId = text(company.companyId);
  return {
    companyId,
    companyName: text(company.companyName),
    openTime: text(company.openTime) || existingOpenTimes.get(companyId) || "",
    ftHandicapHome: text(company.ftHandicapHome),
    ftHandicapLine: text(company.ftHandicapLine),
    ftHandicapAway: text(company.ftHandicapAway),
    ftHandicapHomeLive: text(company.ftHandicapHomeLive),
    ftHandicapLineLive: text(company.ftHandicapLineLive),
    ftHandicapAwayLive: text(company.ftHandicapAwayLive),
    euroHome: text(company.euroHome),
    euroDraw: text(company.euroDraw),
    euroAway: text(company.euroAway),
    euroHomeLive: text(company.euroHomeLive),
    euroDrawLive: text(company.euroDrawLive),
    euroAwayLive: text(company.euroAwayLive),
    euroAsianHome: text(company.euroAsianHome),
    euroAsianLine: text(company.euroAsianLine),
    euroAsianAway: text(company.euroAsianAway),
    ftTotalOver: text(company.ftTotalOver),
    ftTotalLine: text(company.ftTotalLine),
    ftTotalUnder: text(company.ftTotalUnder),
    ftTotalOverLive: text(company.ftTotalOverLive),
    ftTotalLineLive: text(company.ftTotalLineLive),
    ftTotalUnderLive: text(company.ftTotalUnderLive),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function fetchMatchOddsSource(
  fetcher: FetchLike,
  matchId: string,
  existing?: ExistingOdds,
  signal?: AbortSignal,
): Promise<MatchOddsSourceResult> {
  const response = await fetcher(`/api/data/match/${encodeURIComponent(matchId)}`, { signal });
  const payload = await json(response);
  const sourceData = payload.data && typeof payload.data === "object"
    ? payload.data as Record<string, unknown>
    : null;
  if (!response.ok || payload.success !== true || !sourceData) {
    throw new Error(text(payload.error) || text(payload.detail) || "无赔率数据");
  }

  const existingOpenTimes = new Map<string, string>();
  for (const company of existing?.companies || []) {
    if (company.openTime) existingOpenTimes.set(company.companyId, company.openTime);
  }
  if (existing?.openTime) existingOpenTimes.set("3", existing.openTime);

  return {
    data: {
      matchId: text(sourceData.matchId) || matchId,
      openTime: text(sourceData.openTime) || existingOpenTimes.get("3") || "",
      companies: Array.isArray(sourceData.companies)
        ? sourceData.companies.map(company => mapCompany(company, existingOpenTimes))
        : [],
    },
    source: text(payload.source) || "titan-analysis-odds",
    sourceObservedAt: text(payload.sourceObservedAt) || new Date().toISOString(),
    score: payload.score && typeof payload.score === "object"
      ? payload.score as MatchDetailScore
      : null,
  };
}

export async function persistMatchOdds(
  fetcher: FetchLike,
  request: PersistMatchOddsRequest,
  signal?: AbortSignal,
): Promise<PersistMatchOddsResult> {
  const response = await fetcher("/api/data/odds-db", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  const payload = await json(response);
  if (!response.ok || payload.success !== true) {
    throw new Error(text(payload.error) || "保存赔率数据失败");
  }
  return {
    applied: payload.applied === true,
    sourceObservedAt: typeof payload.sourceObservedAt === "string" ? payload.sourceObservedAt : undefined,
  };
}

export function applyMatchDetailScore(matches: MatchData[], score: MatchDetailScore | null): MatchData[] {
  if (!score?.id) return matches;
  return matches.map(match => match.id === score.id ? {
    ...match,
    state: score.state || match.state,
    time: score.time || match.time,
    matchDate: score.matchDate || match.matchDate,
    homeScore: score.homeScore || match.homeScore,
    awayScore: score.awayScore || match.awayScore,
    halfHomeScore: score.halfHomeScore || match.halfHomeScore,
    halfAwayScore: score.halfAwayScore || match.halfAwayScore,
  } : match);
}
