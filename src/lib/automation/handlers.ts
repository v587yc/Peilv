import { matchKickoffAt } from "./definitions";
import type { AutomationHandlers, StepExecutionContext } from "./types";

interface MatchSummary {
  id: string;
  league: string;
  time: string;
  homeTeam: string;
  awayTeam: string;
  state: string;
  matchDate?: string;
  isHot?: boolean;
}

interface LeagueSummary {
  name: string;
  isHot?: boolean;
}

interface CompanyOdds {
  companyId: string;
  companyName: string;
  openTime?: string;
  ftHandicapHome?: string;
  ftHandicapLine?: string;
  ftHandicapAway?: string;
  ftHandicapHomeLive?: string;
  ftHandicapLineLive?: string;
  ftHandicapAwayLive?: string;
  euroAsianHome?: string;
  euroAsianLine?: string;
  euroAsianAway?: string;
  ftTotalOver?: string;
  ftTotalLine?: string;
  ftTotalUnder?: string;
  euroHome?: string;
  euroDraw?: string;
  euroAway?: string;
}

interface OddsData {
  matchId: string;
  companies?: CompanyOdds[];
}

const COMPANY_IDS = ["3", "35", "42", "47", "8"];

function internalHeaders(json = false): HeadersInit {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) throw new Error("INTERNAL_API_SECRET未配置");
  const headers: Record<string, string> = { "x-internal-api-secret": secret };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({})) as T & { success?: boolean; error?: string };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

async function discoverToday(context: StepExecutionContext): Promise<{ matches: MatchSummary[]; hotLeagues: string[] }> {
  const result = await requestJson<{ success: boolean; data: { matches: MatchSummary[]; leagues?: LeagueSummary[] } }>(`${context.baseUrl}/api/odds`);
  const sourceMatches = Array.isArray(result.data?.matches) ? result.data.matches : [];
  return {
    matches: sourceMatches.map((match) => ({
      id: match.id,
      league: match.league,
      time: match.time,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      state: match.state,
      isHot: match.isHot,
    })),
    hotLeagues: (result.data?.leagues || []).filter((league) => league.isHot).map((league) => league.name),
  };
}

function discoveredMatches(context: StepExecutionContext): MatchSummary[] {
  const discovery = (context.outputs["discover-matches"] || context.outputs["discover-candidates"]) as { matches?: MatchSummary[] } | undefined;
  return Array.isArray(discovery?.matches) ? discovery.matches : [];
}

async function fetchOdds(context: StepExecutionContext): Promise<unknown> {
  const matches = discoveredMatches(context).filter((match) => match.state === "0");
  const existing = await requestJson<{ data: { oddsMap: Record<string, OddsData> } }>(
    `${context.baseUrl}/api/data/odds-db?date=${context.task.dateKey}`,
  );
  const pending = matches.filter((match) => !existing.data?.oddsMap?.[match.id]?.companies?.length);
  const failures: string[] = [];
  let saved = 0;

  for (let index = 0; index < pending.length; index += 1) {
    const batch = pending.slice(index, index + 1);
    const results = await Promise.allSettled(batch.map(async (match) => {
      const odds = await requestJson<{
        success: boolean;
        source: string;
        sourceObservedAt: string;
        data: OddsData;
      }>(
        `${context.baseUrl}/api/data/match/${match.id}?companies=${COMPANY_IDS.join(",")}`,
      );
      await requestJson(`${context.baseUrl}/api/data/odds-db`, {
        method: "POST",
        headers: internalHeaders(true),
        body: JSON.stringify({
          matchId: match.id,
          matchDate: context.task.dateKey,
          companyIds: COMPANY_IDS.join(","),
          oddsData: odds.data,
          source: odds.source,
          sourceObservedAt: odds.sourceObservedAt,
          writeToken: `automation:${context.task.id}:${match.id}:${odds.sourceObservedAt}`,
        }),
      });
      saved++;
    }));
    results.forEach((result, resultIndex) => {
      if (result.status === "rejected") failures.push(`${batch[resultIndex].id}: ${String(result.reason)}`);
    });
  }

  if (failures.length) throw new Error(`赔率抓取失败 ${failures.length}/${pending.length}: ${failures.slice(0, 5).join("; ")}`);
  return { discovered: matches.length, alreadyPresent: matches.length - pending.length, saved };
}

function hasSnapshotData(snapshot: Record<string, unknown> | undefined): snapshot is Record<string, unknown> {
  return Boolean(snapshot?.handicapLine || snapshot?.totalLine);
}

async function snapshotCrown(context: StepExecutionContext): Promise<unknown> {
  const matches = discoveredMatches(context).filter((match) => match.state === "0");
  const existing = await requestJson<{
    data: {
      oddsMap: Record<string, OddsData>;
      crown12OddsMap: Record<string, unknown>;
    };
  }>(
    `${context.baseUrl}/api/data/odds-db?date=${context.task.dateKey}&slim=1`,
  );
  const missingBase = matches.filter((match) => !existing.data?.oddsMap?.[match.id]?.companies?.length);
  const pending = matches.filter((match) => (
    existing.data?.oddsMap?.[match.id]?.companies?.length
    && !existing.data?.crown12OddsMap?.[match.id]
  ));
  const failures: string[] = [];
  let saved = 0;
  let unavailable = 0;
  let partial = 0;

  for (let index = 0; index < pending.length; index += 1) {
    const batch = pending.slice(index, index + 1);
    const results = await Promise.allSettled(batch.map(async (match) => {
      const snapshot = await requestJson<{
        success: boolean;
        crownOpen?: Record<string, unknown>;
        crownTerminal?: Record<string, unknown>;
        crownStatus?: {
          handicap: "available" | "unavailable";
          total: "available" | "unavailable";
        };
      }>(`${context.baseUrl}/api/data/match/${match.id}/opentimes?companies=3`);
      if (!hasSnapshotData(snapshot.crownOpen)) {
        if (snapshot.crownStatus?.handicap === "unavailable" && snapshot.crownStatus.total === "unavailable") {
          unavailable++;
          return;
        }
        throw new Error("皇冠快照响应不完整");
      }
      const patch: Record<string, unknown> = {
        matchId: match.id,
        matchDate: context.task.dateKey,
        crown12Odds: snapshot.crownOpen,
      };
      if (hasSnapshotData(snapshot.crownTerminal)) patch.crownLiveOdds = snapshot.crownTerminal;
      await requestJson(`${context.baseUrl}/api/data/odds-db`, {
        method: "PATCH",
        headers: internalHeaders(true),
        body: JSON.stringify(patch),
      });
      if (!(snapshot.crownOpen.handicapLine && snapshot.crownOpen.totalLine)) partial++;
      saved++;
    }));
    results.forEach((result, resultIndex) => {
      if (result.status === "rejected") failures.push(`${batch[resultIndex].id}: ${String(result.reason)}`);
    });
  }

  if (failures.length) throw new Error(`皇冠快照失败 ${failures.length}/${pending.length}: ${failures.slice(0, 5).join("; ")}`);
  return {
    discovered: matches.length,
    missingBase: missingBase.length,
    alreadyPresent: matches.length - pending.length - missingBase.length,
    saved,
    unavailable,
    partial,
  };
}

async function discoverAnalysisCandidates(context: StepExecutionContext): Promise<{ matches: MatchSummary[] }> {
  const result = await discoverToday(context);
  const response = await requestJson<{ predictions?: Record<string, unknown> }>(
    `${context.baseUrl}/api/analysis?date=${context.task.dateKey}`,
  );
  const existing = response.predictions || {};
  const hotLeagues = new Set(result.hotLeagues);
  const matches = result.matches.filter((match) => (
    match.state === "0"
    && (match.isHot || hotLeagues.has(match.league))
    && !existing[match.id]
  ));
  return { matches };
}

function analysisCompanies(companies: CompanyOdds[]): Record<string, string>[] {
  return companies.map((company) => ({
    companyId: company.companyId,
    companyName: company.companyName,
    openTime: company.openTime || "",
    asianHomeInit: company.ftHandicapHome || "",
    asianLineInit: company.ftHandicapLine || "",
    asianAwayInit: company.ftHandicapAway || "",
    asianHomeLive: company.ftHandicapHomeLive || "",
    asianLineLive: company.ftHandicapLineLive || "",
    asianAwayLive: company.ftHandicapAwayLive || "",
    euroAsianHomeInit: company.euroAsianHome || "",
    euroAsianLineInit: company.euroAsianLine || "",
    euroAsianAwayInit: company.euroAsianAway || "",
    totalOverInit: company.ftTotalOver || "",
    totalLineInit: company.ftTotalLine || "",
    totalUnderInit: company.ftTotalUnder || "",
    euroHomeInit: company.euroHome || "",
    euroDrawInit: company.euroDraw || "",
    euroAwayInit: company.euroAway || "",
  }));
}

async function analyzeMatches(context: StepExecutionContext): Promise<unknown> {
  const candidates = discoveredMatches(context);
  const predictionResult = await requestJson<{ predictions?: Record<string, unknown> }>(
    `${context.baseUrl}/api/analysis?date=${context.task.dateKey}`,
  );
  const existing = predictionResult.predictions || {};
  const matches = candidates.filter((match) => !existing[match.id]);
  const failures: string[] = [];
  let analyzed = 0;

  for (let index = 0; index < matches.length; index += 3) {
    const batch = matches.slice(index, index + 3);
    const results = await Promise.allSettled(batch.map(async (match) => {
      const oddsResult = await requestJson<{
        data: {
          oddsMap: Record<string, OddsData>;
          crown12OddsMap: Record<string, Record<string, string>>;
        };
      }>(`${context.baseUrl}/api/data/odds-db?date=${context.task.dateKey}&matchId=${match.id}`);
      const odds = oddsResult.data?.oddsMap?.[match.id];
      const companies = Array.isArray(odds?.companies) ? odds.companies : [];
      if (companies.length === 0) throw new Error("缺少公司赔率");
      const crown = oddsResult.data?.crown12OddsMap?.[match.id];
      await requestJson(`${context.baseUrl}/api/analysis`, {
        method: "POST",
        headers: internalHeaders(true),
        body: JSON.stringify({
          matchId: match.id,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          league: match.league,
          matchTime: match.time,
          matchDate: context.task.dateKey,
          scheduleMode: "today",
          companies: analysisCompanies(companies),
          crown12Handicap: crown?.handicapLine ? { home: crown.handicapHome || "", line: crown.handicapLine, away: crown.handicapAway || "" } : undefined,
          crown12Total: crown?.totalLine ? { over: crown.totalOver || "", line: crown.totalLine, under: crown.totalUnder || "" } : undefined,
        }),
      });
      analyzed++;
    }));
    results.forEach((result, resultIndex) => {
      if (result.status === "rejected") failures.push(`${batch[resultIndex].id}: ${String(result.reason)}`);
    });
  }

  if (failures.length) throw new Error(`AI分析失败 ${failures.length}/${matches.length}: ${failures.slice(0, 5).join("; ")}`);
  return { candidates: candidates.length, alreadyPresent: candidates.length - matches.length, analyzed };
}

interface LoadedT30Match {
  skipped: boolean;
  reason?: string;
  kickoffAt?: string;
  match?: MatchSummary;
}

async function loadT30Match(context: StepExecutionContext): Promise<LoadedT30Match> {
  if (!context.task.matchId) return { skipped: true, reason: "missing-match-id" };
  const result = await requestJson<{ data?: { matches?: MatchSummary[] } }>(
    `${context.baseUrl}/api/schedule?date=${context.task.dateKey}&mode=future`,
  );
  const matches = Array.isArray(result.data?.matches) ? result.data.matches : [];
  const match = matches.find((candidate) => candidate.id === context.task.matchId);
  if (!match) return { skipped: true, reason: "match-not-found" };
  if (match.state !== "0") return { skipped: true, reason: "match-started-or-unavailable", match };

  const kickoff = matchKickoffAt(context.task.dateKey, match.time);
  if (!kickoff) return { skipped: true, reason: "invalid-kickoff", match };
  if (kickoff <= new Date()) return { skipped: true, reason: "kickoff-passed", match };
  return { skipped: false, kickoffAt: kickoff.toISOString(), match };
}

async function reanalyzeT30Match(context: StepExecutionContext): Promise<unknown> {
  const loaded = await loadT30Match(context);
  if (loaded.skipped || !loaded.match) return loaded;
  const match = loaded.match;

  const freshOdds = await requestJson<{
    source: string;
    sourceObservedAt: string;
    data: OddsData;
  }>(`${context.baseUrl}/api/data/match/${match.id}?companies=${COMPANY_IDS.join(",")}`);
  await requestJson(`${context.baseUrl}/api/data/odds-db`, {
    method: "POST",
    headers: internalHeaders(true),
    body: JSON.stringify({
      matchId: match.id,
      matchDate: context.task.dateKey,
      companyIds: COMPANY_IDS.join(","),
      oddsData: freshOdds.data,
      source: freshOdds.source,
      sourceObservedAt: freshOdds.sourceObservedAt,
      writeToken: `automation:${context.task.id}:${match.id}:${freshOdds.sourceObservedAt}`,
    }),
  });

  const oddsResult = await requestJson<{
    data: {
      oddsMap: Record<string, OddsData>;
      crown12OddsMap: Record<string, Record<string, string>>;
    };
  }>(`${context.baseUrl}/api/data/odds-db?date=${context.task.dateKey}&matchId=${match.id}`);
  const odds = oddsResult.data?.oddsMap?.[match.id];
  const companies = Array.isArray(odds?.companies) ? odds.companies : [];
  if (companies.length === 0) throw new Error("缺少公司赔率");
  const crown = oddsResult.data?.crown12OddsMap?.[match.id];
  const freshCrown = freshOdds.data.companies?.find(company => company.companyId === "3");

  await requestJson(`${context.baseUrl}/api/analysis`, {
    method: "POST",
    headers: internalHeaders(true),
    body: JSON.stringify({
      matchId: match.id,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      league: match.league,
      matchTime: match.time,
      matchDate: context.task.dateKey,
      scheduleMode: context.task.payload.scheduleMode || "future",
      analysisTrigger: "match-t30",
      sourceObservedAt: freshOdds.sourceObservedAt,
      companies: analysisCompanies(companies),
      crownLiveHandicap: freshCrown?.ftHandicapLineLive
        ? { home: freshCrown.ftHandicapHomeLive || "", line: freshCrown.ftHandicapLineLive, away: freshCrown.ftHandicapAwayLive || "" }
        : undefined,
      crownLiveTotal: freshCrown?.ftTotalLine
        ? { over: freshCrown.ftTotalOver || "", line: freshCrown.ftTotalLine, under: freshCrown.ftTotalUnder || "" }
        : undefined,
      crown12Handicap: crown?.handicapLine
        ? { home: crown.handicapHome || "", line: crown.handicapLine, away: crown.handicapAway || "" }
        : undefined,
      crown12Total: crown?.totalLine
        ? { over: crown.totalOver || "", line: crown.totalLine, under: crown.totalUnder || "" }
        : undefined,
    }),
  });
  return { analyzed: true, matchId: match.id, kickoffAt: loaded.kickoffAt };
}

async function verify(context: StepExecutionContext): Promise<unknown> {
  const schedule = await requestJson<{
    data?: {
      ingestion?: {
        status?: string;
        source?: { kind?: string; fresh?: boolean; coverage?: string };
        parser?: { parsedRows?: number };
        persistence?: { persistedResults?: number };
        cached?: { finishedResultCount?: number };
      };
    };
  }>(`${context.baseUrl}/api/schedule?date=${context.task.dateKey}&mode=history`, {
    headers: internalHeaders(),
  });
  const ingestion = schedule.data?.ingestion;
  const allowed = ingestion?.status === "ok"
    || ingestion?.status === "valid_empty"
    || ingestion?.status === "fallback_live_results"
    || (ingestion?.status === "fallback_cached_results" && Number(ingestion.cached?.finishedResultCount) > 0);
  if (!allowed) throw new Error(`历史赛程数据不可用于验证: ${ingestion?.status || "missing-ingestion-status"}`);

  const verification = await requestJson(`${context.baseUrl}/api/analysis/verify?startDate=${context.task.dateKey}&endDate=${context.task.dateKey}`, {
    headers: internalHeaders(),
  });
  return {
    scheduleIngestion: {
      status: ingestion.status,
      sourceKind: ingestion.source?.kind || null,
      fresh: ingestion.source?.fresh ?? null,
      coverage: ingestion.source?.coverage || null,
      parsedMatches: ingestion.parser?.parsedRows || 0,
      persistedResults: ingestion.persistence?.persistedResults || 0,
      cachedFinishedResults: ingestion.cached?.finishedResultCount || 0,
    },
    verification,
  };
}

async function learn(context: StepExecutionContext): Promise<unknown> {
  const learnMarket = (market: "handicap" | "total") => requestJson(`${context.baseUrl}/api/analysis/learn`, {
    method: "POST",
    headers: internalHeaders(true),
    body: JSON.stringify({ market, league: "ALL", minSamples: 3 }),
  });
  const [handicap, total] = await Promise.all([learnMarket("handicap"), learnMarket("total")]);
  return { markets: { handicap, total } };
}

async function report(context: StepExecutionContext): Promise<unknown> {
  return requestJson(`${context.baseUrl}/api/report?predDate=${context.task.dateKey}&mode=ai`, {
    method: "POST",
    headers: internalHeaders(),
  });
}

export const automationHandlers: AutomationHandlers = {
  "odds-fetch": {
    "discover-matches": discoverToday,
    "fetch-odds": fetchOdds,
  },
  "crown-snapshot": {
    "discover-matches": discoverToday,
    "snapshot-crown": snapshotCrown,
  },
  analysis: {
    "discover-candidates": discoverAnalysisCandidates,
    "analyze-matches": analyzeMatches,
  },
  "match-t30-analysis": {
    "load-match": loadT30Match,
    "reanalyze-match": reanalyzeT30Match,
  },
  "verify-learn-report": {
    verify,
    learn,
    report,
  },
};
