import { describe, expect, it, vi } from "vitest";
import type { MatchData } from "@/features/odds/contracts";
import {
  createAutomaticOddsFetchLifecycle,
  selectAutomaticOddsTargets,
} from "@/features/odds/automatic-odds-fetch";
import {
  fetchMatchOddsSource,
  persistMatchOdds,
} from "@/features/odds/match-odds-client";
import {
  fetchSupplementalOdds,
  persistSupplementalOdds,
} from "@/features/odds/supplemental-odds-client";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function match(overrides: Partial<MatchData> = {}): MatchData {
  return {
    id: "m1",
    league: "英超",
    leagueColor: "#fff",
    time: "20:00",
    homeTeam: "主队",
    awayTeam: "客队",
    homeRank: "",
    awayRank: "",
    state: "0",
    handicap: "平手",
    handicapRaw: 0,
    homeOdds: "0.90",
    awayOdds: "0.90",
    totalLine: "2.5",
    totalLineRaw: 2.5,
    overOdds: "0.90",
    underOdds: "0.90",
    initialHandicap: "平手",
    initialTotalLine: "2.5",
    sclassId: "1",
    matchDate: "20260715",
    orderIndex: 1,
    ...overrides,
  };
}

describe("single-match odds protocol", () => {
  it("maps partial source responses while preserving existing opening times", async () => {
    const fetcher = vi.fn(async () => response({
      success: true,
      source: "titan-analysis-odds",
      sourceObservedAt: "2026-07-15T04:00:00.000Z",
      score: { id: "m1", state: "1", homeScore: "1" },
      data: {
        matchId: "m1",
        companies: [{ companyId: 3, companyName: "皇冠", ftHandicapLine: "半球" }],
      },
    }));

    const result = await fetchMatchOddsSource(fetcher, "m1", {
      matchId: "m1",
      openTime: "07-15 10:00",
      companies: [{
        companyId: "3", companyName: "皇冠", openTime: "07-15 10:00",
        ftHandicapHome: "", ftHandicapLine: "", ftHandicapAway: "",
        ftHandicapHomeLive: "", ftHandicapLineLive: "", ftHandicapAwayLive: "",
        euroHome: "", euroDraw: "", euroAway: "",
        euroHomeLive: "", euroDrawLive: "", euroAwayLive: "",
        euroAsianHome: "", euroAsianLine: "", euroAsianAway: "",
        ftTotalOver: "", ftTotalLine: "", ftTotalUnder: "",
        ftTotalOverLive: "", ftTotalLineLive: "", ftTotalUnderLive: "",
      }],
    });

    expect(fetcher).toHaveBeenCalledWith("/api/data/match/m1", { signal: undefined });
    expect(result.data.openTime).toBe("07-15 10:00");
    expect(result.data.companies[0]).toMatchObject({
      companyId: "3",
      openTime: "07-15 10:00",
      ftHandicapLine: "半球",
      ftTotalLine: "",
    });
    expect(result.score).toMatchObject({ id: "m1", state: "1", homeScore: "1" });
  });

  it("forwards abort and preserves the exact timestamped persistence payload", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return response({ success: true, applied: true, sourceObservedAt: "2026-07-15T04:00:01.000Z" });
    });
    const request = {
      matchId: "m1",
      matchDate: "20260715",
      companyIds: "3,8",
      oddsData: { matchId: "m1", openTime: "", companies: [] },
      source: "titan-analysis-odds",
      sourceObservedAt: "2026-07-15T04:00:00.000Z",
      writeToken: "2:7:m1:123",
    };

    await expect(persistMatchOdds(fetcher, request, controller.signal)).resolves.toEqual({
      applied: true,
      sourceObservedAt: "2026-07-15T04:00:01.000Z",
    });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(request);
  });
});

describe("supplemental odds protocol", () => {
  it("maps opentimes and Crown opening/final snapshots and persists exact patch fields", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        data: [{ companyId: 3, openTime: "07-15 09:00" }],
        crownOpen: { handicapHome: "0.91", handicapLine: "半球", totalLine: "2.5" },
        crownTerminal: { handicapHome: "0.88", handicapLine: "半球/一球", totalLine: "2.75" },
      }))
      .mockResolvedValue(response({ success: true }));

    const result = await fetchSupplementalOdds(fetcher, {
      matchId: "m1",
      companyIds: ["3", "8"],
      includeCrownOpen: true,
    });
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/data/match/m1/opentimes?companies=3%2C8&crownOpen=true", { signal: undefined });
    expect(result.openTimes).toEqual({ "3": "07-15 09:00" });
    expect(result.crownOpen).toEqual({
      handicapHome: "0.91", handicapLine: "半球", handicapAway: null,
      totalOver: null, totalLine: "2.5", totalUnder: null,
    });
    expect(result.crownFinal?.handicapLine).toBe("半球/一球");

    await persistSupplementalOdds(fetcher, {
      matchId: "m1",
      matchDate: "20260715",
      openTimesData: result.openTimes,
      crown12Odds: result.crownOpen,
      crownLiveOdds: result.crownFinal,
    });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      matchId: "m1",
      matchDate: "20260715",
      openTimesData: { "3": "07-15 09:00" },
      crown12Odds: result.crownOpen,
      crownLiveOdds: result.crownFinal,
    });
  });
});

describe("automatic odds fetch lifecycle", () => {
  it("waits for DB readiness, selects filtered or hot matches, and runs once per mode/date key", async () => {
    const matches = [
      match({ id: "hot", league: "英超", isHot: true }),
      match({ id: "selected", league: "西甲" }),
      match({ id: "live", league: "英超", state: "1", isHot: true }),
    ];
    expect(selectAutomaticOddsTargets({
      matches,
      selectedLeagues: new Set(),
      hotLeagues: new Set(["英超"]),
      fetchedMatchIds: new Set(),
      scheduleMode: "today",
    }).map(item => item.id)).toEqual(["hot"]);
    expect(selectAutomaticOddsTargets({
      matches,
      selectedLeagues: new Set(["西甲"]),
      hotLeagues: new Set(),
      fetchedMatchIds: new Set(),
      scheduleMode: "today",
    }).map(item => item.id)).toEqual(["selected"]);

    const fetched: string[] = [];
    const lifecycle = createAutomaticOddsFetchLifecycle({
      fetchMatch: async (id) => { fetched.push(id); return true; },
      delay: async () => undefined,
    });
    const input = {
      key: "today-20260715",
      dbReady: false,
      matches,
      selectedLeagues: new Set<string>(),
      hotLeagues: new Set(["英超"]),
      fetchedMatchIds: new Set<string>(),
      scheduleMode: "today" as const,
    };
    await expect(lifecycle.run(input)).resolves.toEqual({ started: false, completed: 0 });
    await expect(lifecycle.run({ ...input, dbReady: true })).resolves.toEqual({ started: true, completed: 1 });
    await expect(lifecycle.run({ ...input, dbReady: true })).resolves.toEqual({ started: false, completed: 0 });
    expect(fetched).toEqual(["hot"]);
  });

  it("cancels an active automatic run before the next match", async () => {
    const fetched: string[] = [];
    let cancel: () => void = () => {};
    const lifecycle = createAutomaticOddsFetchLifecycle({
      fetchMatch: async (id) => {
        fetched.push(id);
        cancel();
        return true;
      },
      delay: async () => undefined,
    });
    cancel = () => lifecycle.cancel();
    const result = await lifecycle.run({
      key: "history-20260715",
      dbReady: true,
      matches: [match({ id: "m1" }), match({ id: "m2" })],
      selectedLeagues: new Set(["英超"]),
      hotLeagues: new Set(),
      fetchedMatchIds: new Set(),
      scheduleMode: "history",
    });
    expect(result).toEqual({ started: true, completed: 1 });
    expect(fetched).toEqual(["m1"]);
  });
});
