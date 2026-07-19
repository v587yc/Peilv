import type { FetchLike } from "./api-client";
import type { LeagueData, MatchData } from "./contracts";
import type { OddsScheduleMode } from "./automatic-odds-fetch";
import { previousDateKey } from "./workstation-domain";
import { shouldFetchIncrementalLeagues } from "./league-settings";

export interface ScheduleData {
  matches: MatchData[];
  leagues: LeagueData[];
}

export interface ScheduleAggregate extends ScheduleData {
  hotMatchCount: number;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export async function fetchSchedule(
  fetcher: FetchLike,
  mode: "history" | "future",
  date: string,
  signal?: AbortSignal,
): Promise<ScheduleData> {
  const response = await fetcher(`/api/schedule?date=${encodeURIComponent(date.replace(/-/g, ""))}&mode=${mode}`, { signal });
  let payload: Record<string, unknown> = {};
  try { payload = object(await response.json()); } catch { /* mapped below */ }
  if (!response.ok || payload.success !== true) throw new Error(typeof payload.error === "string" ? payload.error : "获取赛程数据失败");
  const data = object(payload.data);
  return {
    matches: Array.isArray(data.matches) ? data.matches as MatchData[] : [],
    leagues: Array.isArray(data.leagues) ? data.leagues as LeagueData[] : [],
  };
}

export function countHotMatches(data: ScheduleData): number {
  const hotIds = new Set(data.leagues.filter(league => league.isHot).map(league => league.id));
  return data.matches.filter(match => hotIds.has(match.sclassId)).length;
}

export async function aggregateScheduleRange(
  dates: string[],
  load: (date: string) => Promise<ScheduleData>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ScheduleAggregate> {
  const matches: MatchData[] = [];
  const leagues = new Map<string, LeagueData>();
  let hotMatchCount = 0;
  let loaded = 0;
  for (const date of dates) {
    try {
      const day = await load(date);
      matches.push(...day.matches);
      for (const league of day.leagues) {
        const current = leagues.get(league.name);
        leagues.set(league.name, current ? { ...current, count: current.count + league.count } : { ...league });
      }
      hotMatchCount += countHotMatches(day);
    } catch {
      // Range loading intentionally skips failed dates.
    }
    loaded += 1;
    onProgress?.(loaded, dates.length);
  }
  return { matches, leagues: [...leagues.values()].sort((left, right) => right.count - left.count), hotMatchCount };
}

export interface ScheduleLoadPlan {
  schedule: { mode: "history" | "future"; startDate: string; endDate?: string } | null;
  oddsDates: string[];
  predictionDates: string[];
  leagueDate: string;
}

export function createScheduleLoadPlan(input: {
  mode: OddsScheduleMode;
  currentDate: string;
  date: string;
  endDate: string;
}): ScheduleLoadPlan {
  if (input.mode === "today") {
    if (!input.currentDate) return { schedule: null, oddsDates: [], predictionDates: [], leagueDate: "" };
    const previous = previousDateKey(input.currentDate);
    return {
      schedule: null,
      oddsDates: [input.currentDate, previous].filter(Boolean),
      predictionDates: [input.currentDate, previous].filter(Boolean),
      leagueDate: input.currentDate,
    };
  }
  const date = input.date.replace(/-/g, "");
  if (!date) return { schedule: null, oddsDates: [], predictionDates: [], leagueDate: "" };
  return {
    schedule: { mode: input.mode, startDate: input.date, ...(input.mode === "history" && input.endDate ? { endDate: input.endDate } : {}) },
    oddsDates: input.mode === "history" && input.endDate ? [] : [date],
    predictionDates: [date],
    leagueDate: date,
  };
}

export interface LatestScheduleLoadController {
  run(plan: ScheduleLoadPlan): Promise<void>;
  cancel(): void;
  dispose(): void;
}

export function createLatestScheduleLoadController<T>(input: {
  load(plan: ScheduleLoadPlan, signal: AbortSignal, isLatest: () => boolean): Promise<T>;
  apply(data: T, plan: ScheduleLoadPlan): void;
  onError(error: unknown, plan: ScheduleLoadPlan): void;
  onStart?(plan: ScheduleLoadPlan): void;
  onSettled?(plan: ScheduleLoadPlan): void;
}): LatestScheduleLoadController {
  let generation = 0;
  let activeController: AbortController | null = null;
  let disposed = false;

  const cancel = () => {
    const controller = activeController;
    activeController = null;
    generation += 1;
    controller?.abort();
  };

  return {
    async run(plan) {
      if (disposed) return;
      cancel();
      const requestGeneration = generation;
      const controller = new AbortController();
      activeController = controller;
      try {
        input.onStart?.(plan);
        const isLatest = () => !disposed && requestGeneration === generation && !controller.signal.aborted;
        const data = await input.load(plan, controller.signal, isLatest);
        if (isLatest()) input.apply(data, plan);
      } catch (error) {
        if (!disposed && requestGeneration === generation && !controller.signal.aborted) input.onError(error, plan);
      } finally {
        if (activeController === controller) {
          activeController = null;
          input.onSettled?.(plan);
        }
      }
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
    },
  };
}

export async function runIncrementalOddsFetch(input: {
  matches: MatchData[];
  signal?: AbortSignal;
  fetchMatch(matchId: string): Promise<unknown>;
  delay?: (milliseconds: number) => Promise<void>;
}): Promise<number> {
  const delay = input.delay ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  let completed = 0;
  for (const match of input.matches) {
    if (input.signal?.aborted) break;
    await Promise.allSettled([input.fetchMatch(match.id)]);
    completed += 1;
    if (!input.signal?.aborted && completed < input.matches.length) await delay(100);
  }
  return completed;
}

export function selectIncrementalOddsTargets(input: {
  matches: MatchData[];
  previousLeagues: Set<string>;
  selectedLeagues: Set<string>;
  fetchedMatchIds: Set<string>;
  scheduleMode: OddsScheduleMode;
}): MatchData[] {
  if (input.selectedLeagues.size === 0) return [];
  const added = shouldFetchIncrementalLeagues(input.previousLeagues, input.selectedLeagues);
  if (added.size === 0) return [];
  return input.matches.filter(match =>
    (input.scheduleMode === "history" || match.state === "0")
    && added.has(match.league)
    && !input.fetchedMatchIds.has(match.id),
  );
}
