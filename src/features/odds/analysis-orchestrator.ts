import type { AnalysisResultData, CompanyOddsData, CrownStoredOdds, MatchData } from "./contracts";
import type { OddsScheduleMode } from "./automatic-odds-fetch";
import type { AnalysisRequestInput } from "./analysis-client";
import { mergeAiCompanyOdds } from "@/lib/odds-client-merge";
import type { AnalysisChatMessage } from "./analysis-client";

export async function prepareAnalysisRequest(input: {
  match: MatchData;
  matchDate: string;
  scheduleMode: OddsScheduleMode;
  memoryOdds?: CompanyOddsData;
  crownOpen?: CrownStoredOdds;
  loadDatabaseCompanies(): Promise<Record<string, unknown>[]>;
  refreshLiveOdds(): Promise<CompanyOddsData | undefined>;
  onFallbackError?: (error: unknown) => void;
}): Promise<AnalysisRequestInput> {
  let databaseCompanies: Record<string, unknown>[] = [];
  try { databaseCompanies = await input.loadDatabaseCompanies(); } catch { /* database fallback is optional */ }
  const memoryCompanies = (input.memoryOdds?.companies || []).map(company => ({ ...company }));
  let companies = mergeAiCompanyOdds(memoryCompanies, databaseCompanies);
  if (companies.length === 0) {
    try {
      const refreshed = await input.refreshLiveOdds();
      companies = mergeAiCompanyOdds((refreshed?.companies || []).map(company => ({ ...company })), []);
    } catch (error) {
      input.onFallbackError?.(error);
    }
  }
  if (companies.length === 0) throw new Error("没有可用赔率数据，请先抓取赔率");

  const open = input.crownOpen;
  const crown = input.memoryOdds?.companies.find(company => company.companyId === "3");
  return {
    match: input.match,
    matchDate: input.matchDate,
    scheduleMode: input.scheduleMode,
    companies,
    crown12Handicap: open?.handicapLine ? { home: open.handicapHome || "", line: open.handicapLine, away: open.handicapAway || "" } : undefined,
    crown12Total: open?.totalLine ? { over: open.totalOver || "", line: open.totalLine, under: open.totalUnder || "" } : undefined,
    crownLiveHandicap: input.scheduleMode === "future" && crown?.ftHandicapLineLive ? { home: crown.ftHandicapHomeLive || "", line: crown.ftHandicapLineLive, away: crown.ftHandicapAwayLive || "" } : undefined,
    crownLiveTotal: input.scheduleMode === "future" && crown?.ftTotalLineLive ? { over: crown.ftTotalOverLive || "", line: crown.ftTotalLineLive, under: crown.ftTotalUnderLive || "" } : undefined,
  };
}

export async function runAnalysisCommand(options: {
  matchId: string;
  forceReanalyze?: boolean;
  start(matchId: string): void;
  analyze(matchId: string, forceReanalyze: boolean): Promise<AnalysisResultData | null>;
  apply(matchId: string, result: AnalysisResultData): void;
  expand(matchId: string): void;
  success(result: AnalysisResultData): void;
  skipped?(): void;
  error(error: unknown): void;
  settle(): void;
}): Promise<"applied" | "skipped" | "failed"> {
  options.start(options.matchId);
  try {
    const result = await options.analyze(options.matchId, options.forceReanalyze ?? false);
    if (!result) {
      options.skipped?.();
      return "skipped";
    }
    options.apply(options.matchId, result);
    options.expand(options.matchId);
    options.success(result);
    return "applied";
  } catch (error) {
    options.error(error);
    return "failed";
  } finally {
    options.settle();
  }
}

export interface VerificationLearningSummary {
  synced: number;
  verified: number;
  correct: number;
  learnedPatterns: number;
}

export async function runVerificationLearning(options: {
  dateKeys: string[];
  syncScores: (dateKey: string) => Promise<{ persistedResults: number }>;
  verify: (dateKey: string) => Promise<{ verified: number; correct: number }>;
  reloadPredictions: (dateKey: string) => Promise<void>;
  learn: (market: "handicap" | "total") => Promise<{ patternsFound: number }>;
  refreshStats: () => Promise<void>;
}): Promise<VerificationLearningSummary> {
  let synced = 0;
  let verified = 0;
  let correct = 0;
  for (const dateKey of options.dateKeys) {
    const scoreSync = await options.syncScores(dateKey);
    synced += scoreSync.persistedResults;
    const verification = await options.verify(dateKey);
    verified += verification.verified;
    correct += verification.correct;
    await options.reloadPredictions(dateKey);
  }
  const [handicap, total] = await Promise.all([
    options.learn("handicap"),
    options.learn("total"),
  ]);
  await options.refreshStats();
  return {
    synced,
    verified,
    correct,
    learnedPatterns: handicap.patternsFound + total.patternsFound,
  };
}

export interface AnalysisBatchItem {
  id: string;
  homeTeam: string;
  awayTeam: string;
}

export interface AnalysisBatchProgress {
  current: number;
  total: number;
  matchName: string;
  succeeded: number;
  failed: number;
}

export interface AnalysisBatchSummary {
  completed: number;
  succeeded: number;
  failed: number;
  cancelled: boolean;
}

export interface AnalysisBatchController {
  readonly cancelled: boolean;
  cancel(): void;
}

export function createBatchAnalysisController(): AnalysisBatchController {
  let cancelled = false;
  return {
    get cancelled() { return cancelled; },
    cancel() { cancelled = true; },
  };
}

export async function runAnalysisBatch(options: {
  items: AnalysisBatchItem[];
  concurrency: number;
  flushSize?: number;
  controller: AnalysisBatchController;
  analyze: (item: AnalysisBatchItem) => Promise<AnalysisResultData | null>;
  onProgress?: (progress: AnalysisBatchProgress) => void;
  onResults?: (results: Map<string, AnalysisResultData>) => void;
  onError?: (item: AnalysisBatchItem, error: unknown) => void;
}): Promise<AnalysisBatchSummary> {
  const concurrency = Math.max(1, Math.min(8, options.concurrency));
  const flushSize = Math.max(1, options.flushSize ?? 5);
  let completed = 0;
  let succeeded = 0;
  let failed = 0;
  let accumulated = new Map<string, AnalysisResultData>();

  const flush = () => {
    if (options.controller.cancelled || accumulated.size === 0) {
      accumulated.clear();
      return;
    }
    const results = accumulated;
    accumulated = new Map();
    options.onResults?.(results);
  };

  for (let index = 0; index < options.items.length; index += concurrency) {
    if (options.controller.cancelled) break;
    const group = options.items.slice(index, index + concurrency);
    await Promise.allSettled(group.map(async item => {
      if (options.controller.cancelled) return;
      options.onProgress?.({
        current: completed, total: options.items.length,
        matchName: `${item.homeTeam} vs ${item.awayTeam}`, succeeded, failed,
      });
      try {
        const result = await options.analyze(item);
        if (options.controller.cancelled) return;
        if (result) {
          succeeded += 1;
          accumulated.set(item.id, result);
          if (accumulated.size >= flushSize) flush();
        }
      } catch (error) {
        failed += 1;
        options.onError?.(item, error);
      } finally {
        completed += 1;
        options.onProgress?.({
          current: completed, total: options.items.length,
          matchName: `${item.homeTeam} vs ${item.awayTeam}`, succeeded, failed,
        });
      }
    }));
    flush();
  }
  flush();
  return { completed, succeeded, failed, cancelled: options.controller.cancelled };
}

export function appendUserMessage(messages: AnalysisChatMessage[], content: string): AnalysisChatMessage[] {
  return [...messages, { role: "user", content: content.trim() }];
}

export function appendAssistantMessage(
  messages: AnalysisChatMessage[],
  content: string,
  replaceLast = false,
): AnalysisChatMessage[] {
  if (replaceLast && messages.at(-1)?.role === "assistant") {
    return [...messages.slice(0, -1), { role: "assistant", content }];
  }
  return [...messages, { role: "assistant", content }];
}
