import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as scheduleOrchestrator from "@/features/odds/schedule-orchestrator";
import * as supplementalOddsClient from "@/features/odds/supplemental-odds-client";
import {
  createGenerationDatabaseLoadController,
  mergeDatabaseOddsResults,
  fetchDatabaseOddsRange,
  projectDatabaseOddsApplication,
  type DatabaseOddsResult,
} from "@/features/odds/database-odds-workflow";
import { prepareAnalysisRequest, runAnalysisCommand } from "@/features/odds/analysis-orchestrator";
import { runReportCommand } from "@/features/odds/reporting";
import {
  buildOddsComparisonSummary,
  projectOtherMatches,
  projectScheduledMatches,
} from "@/features/odds/workstation-projections";
import {
  aggregateScheduleRange,
  createLatestScheduleLoadController,
  createScheduleLoadPlan,
  runIncrementalOddsFetch,
  selectIncrementalOddsTargets,
} from "@/features/odds/schedule-orchestrator";
import {
  buildSupplementalPersistence,
  countSupplementalTargets,
  runSupplementalBatch,
  runSupplementalOddsUpdate,
  selectSupplementalTargets,
} from "@/features/odds/supplemental-odds-client";
import type { CompanyOddsData, MatchData } from "@/features/odds/contracts";

const match = (id: string, league = "英超", state = "0"): MatchData => ({
  id, league, leagueColor: "", time: "12:00", homeTeam: `主${id}`, awayTeam: `客${id}`,
  homeRank: "", awayRank: "", state, handicap: "", handicapRaw: 0, homeOdds: "",
  awayOdds: "", totalLine: "", totalLineRaw: 0, overOdds: "", underOdds: "",
  initialHandicap: "", initialTotalLine: "", sclassId: league, matchDate: "07月14日", orderIndex: 0,
});
const odds = (id: string, companies = [{ companyId: "3", companyName: "皇冠", openTime: "", ftHandicapHome: "", ftHandicapLine: "", ftHandicapAway: "", ftHandicapHomeLive: "", ftHandicapLineLive: "", ftHandicapAwayLive: "", euroHome: "", euroDraw: "", euroAway: "", euroHomeLive: "", euroDrawLive: "", euroAwayLive: "", euroAsianHome: "", euroAsianLine: "", euroAsianAway: "", ftTotalOver: "", ftTotalLine: "", ftTotalUnder: "", ftTotalOverLive: "", ftTotalLineLive: "", ftTotalUnderLive: "" }]): CompanyOddsData => ({ matchId: id, openTime: "", companies });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const pageSource = () => readFileSync(join(process.cwd(), "src/app/odds/page.tsx"), "utf8");

describe("odds application workflows", () => {
  it("owns single-analysis execution and UI lifecycle callbacks", async () => {
    const events: string[] = [];
    const result = await runAnalysisCommand({
      matchId: "m1",
      forceReanalyze: true,
      start: id => events.push(`start:${id}`),
      analyze: async () => ({ matchId: "m1" } as never),
      apply: () => events.push("apply"),
      expand: id => events.push(`expand:${id}`),
      success: () => events.push("success"),
      error: () => events.push("error"),
      settle: () => events.push("settle"),
    });
    expect(result).toBe("applied");
    expect(events).toEqual(["start:m1", "apply", "expand:m1", "success", "settle"]);
  });

  it("owns report generation refresh sequencing while leaving UI callbacks injected", async () => {
    const events: string[] = [];
    await runReportCommand({
      generate: async () => ({ date: "20260714", rows: [], summary: {} }),
      apply: report => events.push(`apply:${report.date}`),
      refreshDates: async () => { events.push("dates"); },
      refreshTrend: async () => { events.push("trend"); },
      start: () => events.push("start"),
      success: () => events.push("success"),
      error: () => events.push("error"),
      settle: () => events.push("settle"),
    });
    expect(events).toEqual(["start", "apply:20260714", "success", "dates", "trend", "settle"]);
  });

  it("only applies predictions from the current generation when an older date resolves last", async () => {
    const loadA = deferred<Record<string, string>>();
    const loadB = deferred<Record<string, string>>();
    const applied: string[] = [];
    const controller = createGenerationDatabaseLoadController();
    const generationA = controller.beginGeneration();
    const first = controller.loadPredictions("20260714", generationA, () => loadA.promise, predictions => applied.push(String(predictions.a)));
    const generationB = controller.beginGeneration();
    const second = controller.loadPredictions("20260715", generationB, () => loadB.promise, predictions => applied.push(String(predictions.b)));
    loadB.resolve({ b: "B" });
    await second;
    loadA.resolve({ a: "A" });
    await first;
    expect(applied).toEqual(["B"]);
  });

  it("scopes odds and prediction readiness to the active generation", async () => {
    const controller = createGenerationDatabaseLoadController();
    const first = controller.beginGeneration();
    controller.markOddsReady("20260714", first);
    controller.markPredictionsReady("20260714", first);
    expect(controller.isReady("20260714")).toBe(true);

    const second = controller.beginGeneration();
    expect(controller.isReady("20260714")).toBe(false);
    controller.markOddsReady("20260714", first);
    controller.markPredictionsReady("20260714", first);
    expect(controller.isReady("20260714")).toBe(false);
    controller.markOddsReady("20260714", second);
    expect(controller.isReady("20260714")).toBe(false);
    controller.markPredictionsReady("20260714", second);
    expect(controller.isReady("20260714")).toBe(true);
  });

  it("projects workstation filtering, status grouping and comparison details", () => {
    const scheduled = match("scheduled");
    scheduled.homeOdds = "1.00";
    scheduled.awayOdds = "1.10";
    scheduled.overOdds = "0.90";
    scheduled.underOdds = "1.00";
    const pinned = match("pinned");
    pinned.homeOdds = "1.20";
    pinned.awayOdds = "1.20";
    pinned.orderIndex = 2;
    const live = match("live", "英超", "1");
    const halftime = match("half", "英超", "2");
    const finished = match("finished", "英超", "-1");
    const statusKind = (state: string) => state === "2" ? "halftime" as const : state === "-1" ? "finished" as const : /^[1-9]\d*$/.test(state) ? "live" as const : state === "0" ? "scheduled" as const : "unknown" as const;

    expect(projectScheduledMatches({ matches: [scheduled, pinned, live], selectedLeagues: new Set(["英超"]), minimumOddsSum: 2.2, pinnedMatchIds: new Set(["pinned"]) }).map(item => item.id)).toEqual(["pinned"]);
    const other = projectOtherMatches({ matches: [finished, halftime, live], selectedLeagues: new Set(), pinnedMatchIds: new Set(["finished"]), filter: "halftime", statusKind });
    expect(other.all.map(item => item.id)).toEqual(["finished", "live", "half"]);
    expect(other.visible.map(item => item.id)).toEqual(["half"]);
    expect(other.counts).toEqual({ all: 3, live: 1, halftime: 1, finished: 1, unknown: 0 });

    const summary = buildOddsComparisonSummary({ matches: [scheduled, live], notes: new Map([["scheduled", { handicapNote: "0/0.5 0.83/1.05 客", totalNote: "2.5 0.83/1.05 大" }]]), oddsBaseTotal: 1.9 });
    expect(summary.matchCount).toBe(2);
    expect(summary.details.map(detail => detail.type)).toEqual(["handicap", "total"]);
  });

  it("removes inline readiness sets and comparison aggregation from the page", () => {
    const source = pageSource();
    expect(source).not.toContain("dbOddsLoadedRef");
    expect(source).not.toContain("dbPredictionsLoadedRef");
    expect(source).not.toContain("let totalDiff = 0");
    expect(source).toContain("buildOddsComparisonSummary({");
  });

  it("decodes, freshness-filters and merges database date results", () => {
    const results: DatabaseOddsResult[] = [{
      date: "20260714", matchIds: ["fresh", "stale"],
      oddsMap: { fresh: odds("fresh"), stale: odds("stale") },
      oddsMetaMap: {
        fresh: { source: "db", sourceObservedAt: "2026-07-14T04:00:02Z", writeToken: null },
        stale: { source: "db", sourceObservedAt: "2026-07-14T04:00:01Z", writeToken: null },
      }, crownLiveOddsMap: { fresh: { handicapLine: "半球" } }, crown12OddsMap: {},
    }];
    const merged = mergeDatabaseOddsResults(results, new Map([
      ["stale", { source: "live", sourceObservedAt: "2026-07-14T04:00:03Z" }],
    ]));
    expect([...merged.odds.keys()]).toEqual(["fresh"]);
    expect([...merged.fetched]).toEqual(["fresh"]);
    expect(merged.readyDates).toEqual(["20260714"]);
  });

  it("projects database results without overwriting a newer refresh or persistence", () => {
    const results: DatabaseOddsResult[] = [{
      date: "20260714", matchIds: ["fresh", "racing"],
      oddsMap: { fresh: odds("fresh"), racing: odds("racing") },
      oddsMetaMap: {
        fresh: { source: "db", sourceObservedAt: "2026-07-14T04:00:02Z" },
        racing: { source: "db", sourceObservedAt: "2026-07-14T04:00:02Z" },
      },
      crownLiveOddsMap: { fresh: { handicapLine: "半球" }, racing: { handicapLine: "一球" } },
      crown12OddsMap: { racing: { totalLine: "2.5" } },
    }];
    const projected = projectDatabaseOddsApplication({
      results,
      currentMetadata: new Map(),
      requestStartVersion: 4,
      refreshVersions: new Map([["racing", 5]]),
      persistedVersions: new Map(),
    });
    expect([...projected.odds.keys()]).toEqual(["fresh"]);
    expect([...projected.fetched]).toEqual(["fresh"]);
    expect([...projected.crownLive.keys()]).toEqual(["fresh"]);
    expect(projected.readyDates).toEqual(["20260714"]);
  });

  it("loads a date range in batches of three and skips failed dates", async () => {
    let active = 0;
    let maximum = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      active += 1; maximum = Math.max(maximum, active);
      await Promise.resolve(); active -= 1;
      const date = String(input).match(/date=(\d+)/)?.[1] || "";
      return new Response(date === "20260715" ? "{}" : JSON.stringify({ success: true, data: { matchIds: [], oddsMap: {} } }), { status: date === "20260715" ? 500 : 200 });
    });
    const results = await fetchDatabaseOddsRange(fetcher, "2026-07-14", "2026-07-17");
    expect(results.map(result => result.date)).toEqual(["20260714", "20260716", "20260717"]);
    expect(maximum).toBeLessThanOrEqual(3);
  });

  it("builds analysis input with DB-memory merge, live fallback, Crown snapshots and future mode", async () => {
    const refreshed = odds("m1");
    const input = await prepareAnalysisRequest({
      match: match("m1"), matchDate: "20260714", scheduleMode: "future",
      memoryOdds: odds("m1", []), crownOpen: { handicapLine: "半球", handicapHome: "0.8", handicapAway: "1.0" },
      loadDatabaseCompanies: async () => [], refreshLiveOdds: async () => refreshed,
    });
    expect(input.companies).toHaveLength(1);
    expect(input.crown12Handicap).toEqual({ home: "0.8", line: "半球", away: "1.0" });
    expect(input.crownLiveHandicap).toBeUndefined();
  });

  it("selects supplemental and incremental candidates without changing ordering", () => {
    const matches = [match("a"), match("b", "西甲"), match("c", "英超", "1")];
    expect(selectSupplementalTargets({ type: "odds", matches, selectedLeagues: new Set(["英超"]), scheduleMode: "today", fetchedMatchIds: new Set(), oddsByMatch: new Map(), crownOpenByMatch: new Map() }).map(item => item.id)).toEqual(["a"]);
    expect(selectIncrementalOddsTargets({ matches, previousLeagues: new Set(["英超"]), selectedLeagues: new Set(["英超", "西甲"]), fetchedMatchIds: new Set(), scheduleMode: "today" }).map(item => item.id)).toEqual(["b"]);
  });

  it("constructs supplemental persistence only for returned patches", () => {
    expect(buildSupplementalPersistence("m1", "20260714", { openTimes: { "3": "07-14 10:00" }, crownOpen: null, crownFinal: null })).toEqual({ matchId: "m1", matchDate: "20260714", openTimesData: { "3": "07-14 10:00" } });
  });

  it("runs supplemental fetch, persistence and local reconciliation in order", async () => {
    const calls: string[] = [];
    const outcome = await runSupplementalOddsUpdate({
      match: match("m1"),
      currentDate: "20260714",
      companyIds: ["3"],
      includeCrownOpen: true,
      generation: 7,
      currentGeneration: () => 7,
      readOdds: () => odds("m1"),
      fetch: async () => {
        calls.push("fetch");
        return { openTimes: { "3": "07-14 10:00" }, crownOpen: { handicapHome: null, handicapLine: "半球", handicapAway: null, totalOver: null, totalLine: null, totalUnder: null }, crownFinal: null };
      },
      persist: async request => { calls.push("persist"); expect(request.matchDate).toBe("07月14日"); },
    });
    expect(calls).toEqual(["fetch", "persist"]);
    expect(outcome?.odds?.companies[0].openTime).toBe("07-14 10:00");
    expect(outcome?.crownOpen?.handicapLine).toBe("半球");
  });

  it("drops a supplemental result when its generation becomes stale", async () => {
    let generation = 2;
    const persist = vi.fn();
    const outcome = await runSupplementalOddsUpdate({
      match: match("m1"), currentDate: "20260714", companyIds: ["3"], includeCrownOpen: false,
      generation: 2, currentGeneration: () => generation, readOdds: () => odds("m1"),
      fetch: async () => { generation = 3; return { openTimes: { "3": "late" }, crownOpen: null, crownFinal: null }; },
      persist,
    });
    expect(outcome).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it("runs supplemental batches serially and injects application/progress callbacks", async () => {
    const events: string[] = [];
    const targets = [match("a"), match("b")];
    await runSupplementalBatch({
      type: "crownOpen",
      targets,
      signal: new AbortController().signal,
      fetchMatch: async () => undefined,
      updateSupplement: async item => ({ matchId: item.id }),
      apply: outcome => events.push(`apply:${outcome.matchId}`),
      progress: (done, total) => events.push(`progress:${done}/${total}`),
      delay: async milliseconds => { events.push(`delay:${milliseconds}`); },
    });
    expect(events).toEqual(["apply:a", "progress:1/2", "delay:200", "apply:b", "progress:2/2"]);
  });

  it("runs incremental fetch serially with the preserved delay and cancellation", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    await runIncrementalOddsFetch({
      matches: [match("a"), match("b"), match("c")],
      signal: controller.signal,
      fetchMatch: async id => {
        calls.push(id);
        if (id === "b") controller.abort();
      },
      delay: async milliseconds => { calls.push(`delay:${milliseconds}`); },
    });
    expect(calls).toEqual(["a", "delay:100", "b"]);
  });

  it("defines the production load plan for today, history ranges and future dates", () => {
    expect(createScheduleLoadPlan({ mode: "today", currentDate: "20260714", date: "", endDate: "" })).toEqual({
      schedule: null,
      oddsDates: ["20260714", "20260713"],
      predictionDates: ["20260714", "20260713"],
      leagueDate: "20260714",
    });
    expect(createScheduleLoadPlan({ mode: "history", currentDate: "20260714", date: "2026-07-01", endDate: "2026-07-03" })).toEqual({
      schedule: { mode: "history", startDate: "2026-07-01", endDate: "2026-07-03" },
      oddsDates: [],
      predictionDates: ["20260701"],
      leagueDate: "20260701",
    });
    expect(createScheduleLoadPlan({ mode: "future", currentDate: "20260714", date: "2026-07-20", endDate: "" })).toEqual({
      schedule: { mode: "future", startDate: "2026-07-20" },
      oddsDates: ["20260720"],
      predictionDates: ["20260720"],
      leagueDate: "20260720",
    });
  });

  it("uses the feature load plan in the production page without duplicate previous-day planning", () => {
    const source = pageSource();
    expect(source).toContain("createScheduleLoadPlan({");
    expect(source.match(/previousDateKey\(currentDbDate\)/g) ?? []).toHaveLength(0);
    expect(source).not.toContain('dataScheduleMode === "history" && dataDateEnd');
  });

  it("only applies the latest schedule load when an older request resolves last", async () => {
    const loadA = deferred<{ matches: MatchData[]; leagues: never[]; hotMatchCount: number }>();
    const loadB = deferred<{ matches: MatchData[]; leagues: never[]; hotMatchCount: number }>();
    const applied: string[] = [];
    const controller = createLatestScheduleLoadController({
      load: plan => plan.schedule?.startDate === "A" ? loadA.promise : loadB.promise,
      apply: data => applied.push(`${data.matches[0].id}:${data.hotMatchCount}`),
      onError: vi.fn(),
    });
    const first = controller.run({ schedule: { mode: "history", startDate: "A" }, oddsDates: [], predictionDates: [], leagueDate: "A" });
    const second = controller.run({ schedule: { mode: "future", startDate: "B" }, oddsDates: [], predictionDates: [], leagueDate: "B" });
    loadB.resolve({ matches: [match("B")], leagues: [], hotMatchCount: 2 });
    await second;
    loadA.resolve({ matches: [match("A")], leagues: [], hotMatchCount: 1 });
    await first;
    expect(applied).toEqual(["B:2"]);
  });

  it("does not apply or report a schedule result after disposal", async () => {
    const pending = deferred<{ matches: MatchData[]; leagues: never[]; hotMatchCount: number }>();
    const apply = vi.fn();
    const onError = vi.fn();
    const controller = createLatestScheduleLoadController({ load: () => pending.promise, apply, onError });
    const running = controller.run({ schedule: { mode: "future", startDate: "B" }, oddsDates: [], predictionDates: [], leagueDate: "B" });
    controller.dispose();
    pending.resolve({ matches: [match("B")], leagues: [], hotMatchCount: 2 });
    await running;
    expect(apply).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("derives every displayed supplemental count from canonical target selection", () => {
    const matches = [match("missing"), match("open"), match("crown"), match("final", "英超", "1"), match("other", "西甲")];
    const input = {
      matches,
      selectedLeagues: new Set(["英超"]),
      scheduleMode: "today" as const,
      fetchedMatchIds: new Set(["open", "crown", "final"]),
      oddsByMatch: new Map([
        ["open", odds("open")],
        ["crown", odds("crown", [{ ...odds("crown").companies[0], openTime: "10:00" }])],
        ["final", odds("final")],
      ]),
      crownOpenByMatch: new Map([["open", {}]]),
    };
    const counts = countSupplementalTargets(input);
    expect(counts).toEqual({ odds: 1, opentimes: 1, crownOpen: 1, crownFinal: 1 });
    for (const type of ["odds", "opentimes", "crownOpen", "crownFinal"] as const) {
      expect(counts[type]).toBe(selectSupplementalTargets({ ...input, type }).length);
    }
    expect(pageSource()).toContain("countSupplementalTargets({");
  });

  it("integrates production workflow helpers rather than merely exporting them", () => {
    expect(scheduleOrchestrator.createScheduleLoadPlan).toBeTypeOf("function");
    expect(supplementalOddsClient.countSupplementalTargets).toBeTypeOf("function");
  });

  it("aggregates schedules and plans today's previous-date loads", async () => {
    const aggregate = await aggregateScheduleRange(["20260714", "20260715"], async date => ({ matches: [match(date, "英超")], leagues: [{ id: "英超", name: "英超", color: "", count: 1, isHot: true }] }));
    expect(aggregate.matches).toHaveLength(2);
    expect(aggregate.leagues[0].count).toBe(2);
    expect(aggregate.hotMatchCount).toBe(2);
    expect(createScheduleLoadPlan({ mode: "today", currentDate: "20260714", date: "", endDate: "" }).oddsDates).toEqual(["20260714", "20260713"]);
  });
});
