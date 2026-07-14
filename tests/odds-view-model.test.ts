import { describe, expect, it } from "vitest";
import {
  buildPurchaseAdvice,
  computePredictionComparison,
  getMatchLatestOdds,
  parseCrownHandicap,
} from "@/features/odds/analysis-view-model";
import {
  computeHandicapComparison,
  computeTotalComparison,
  parseHandicapNote,
  parseTotalNote,
} from "@/features/odds/odds-note-parser";
import {
  getLeagueCoreName,
  getLeagueInitial,
  isLeagueSelected,
  matchLeague,
} from "@/features/odds/league-matching";
import type {
  AnalysisResultData,
  CompanyOddsItem,
  MatchData,
  PredictionData,
} from "@/features/odds/contracts";

const match = {
  id: "m1", league: "英超", leagueColor: "#fff", time: "20:00", homeTeam: "主队", awayTeam: "客队",
  homeRank: "1", awayRank: "2", state: "0", handicap: "半球", handicapRaw: 0.5,
  homeOdds: "0.90", awayOdds: "1.00", totalLine: "2.5", totalLineRaw: 2.5,
  overOdds: "0.88", underOdds: "1.02", initialHandicap: "半球", initialTotalLine: "2.5",
  sclassId: "1", matchDate: "20260714", orderIndex: 0,
} satisfies MatchData;

const company = {
  companyId: "3", companyName: "皇冠", openTime: "07-14 10:00",
  ftHandicapHome: "0.91", ftHandicapLine: "半球", ftHandicapAway: "0.99",
  ftHandicapHomeLive: "0.86", ftHandicapLineLive: "半球/一球", ftHandicapAwayLive: "1.04",
  euroHome: "", euroDraw: "", euroAway: "", euroHomeLive: "", euroDrawLive: "", euroAwayLive: "",
  euroAsianHome: "", euroAsianLine: "", euroAsianAway: "",
  ftTotalOver: "0.89", ftTotalLine: "2.5", ftTotalUnder: "1.01",
  ftTotalOverLive: "0.92", ftTotalLineLive: "2.75", ftTotalUnderLive: "0.98",
} satisfies CompanyOddsItem;

describe("odds analysis view model", () => {
  it("parses crown handicap strings without changing receiving semantics", () => {
    expect(parseCrownHandicap("0.85 半球 1.01")).toEqual({ homeOdds: 0.85, awayOdds: 1.01, handicapValue: 0.5 });
    expect(parseCrownHandicap("0.92 受让平手/半球 0.96")?.handicapValue).toBe(-0.25);
    expect(parseCrownHandicap("invalid")).toBeNull();
  });

  it("prefers company live odds and falls back to match odds", () => {
    expect(getMatchLatestOdds(match, company)).toMatchObject({ handicapHome: "0.86", handicapLine: "半球/一球", totalLine: "2.75", source: "旧页即时", isCrownLatest: true });
    expect(getMatchLatestOdds(match)).toMatchObject({ handicapHome: "0.90", source: "即时", isCrownLatest: false });
  });

  it("builds the exact purchase advice text", () => {
    const analysis = { prediction: "主", totalPrediction: "小", confidenceLevel: "高", accuracy: "80%" } as AnalysisResultData;
    expect(buildPurchaseAdvice(analysis, getMatchLatestOdds(match))).toEqual({
      handicap: "建议买主（半球 @ 0.90）",
      total: "大小球买小（2.5 @ 1.02）",
      title: "建议买主（半球 @ 0.90）；大小球买小（2.5 @ 1.02）；信心高 80%",
    });
  });

  it("compares prediction odds and handicap direction", () => {
    const prediction = { crown_handicap: "0.85 半球 1.01", prediction: "主", action: "买入" } as PredictionData;
    expect(computePredictionComparison(prediction, "0.91", "0.99", 0.75)).toEqual({ oddsDiff: 0.06, handicapChange: "升", predictedSide: "home", action: "买入" });
  });
});

describe("odds note parsing and comparison", () => {
  it("parses handicap and total notes", () => {
    expect(parseHandicapNote("受0.5/1 1.11/0.78 主")).toEqual({ line: "受0.5/1", homeOdds: "1.11", awayOdds: "0.78", side: "主" });
    expect(parseTotalNote("2.5 0.83/1.05 小")).toEqual({ line: "2.5", overOdds: "0.83", underOdds: "1.05", side: "小" });
  });

  it("compares selected note side with the opposite live odds", () => {
    const handicap = computeHandicapComparison("0/0.5 0.83/1.05 客", "0.90", "1.00");
    expect(handicap).toMatchObject({ predictedOdds: 1.05, currentOdds: 0.9 });
    expect(handicap?.sumTotal).toBeCloseTo(1.95);
    const total = computeTotalComparison("2.5 0.83/1.05 大", "0.90", "1.00");
    expect(total).toMatchObject({ predictedOdds: 0.83, currentOdds: 1 });
    expect(total?.sumTotal).toBeCloseTo(1.83);
  });
});

describe("league matching", () => {
  it("normalizes qualifiers and level suffixes exactly", () => {
    expect(getLeagueCoreName("丹麦甲升")).toBe("丹麦甲");
    expect(getLeagueCoreName("韩K2", true)).toBe("韩K");
    expect(isLeagueSelected("巴林甲", new Set(["巴林超"]))).toBe(true);
  });

  it("supports grouping and Chinese or pinyin-initial search", () => {
    expect(getLeagueInitial("英超")).toBe("Y");
    expect(matchLeague("英超", "英")).toBe(true);
    expect(matchLeague("英超", "yc")).toBe(true);
    expect(matchLeague("英超", "xj")).toBe(false);
  });
});
