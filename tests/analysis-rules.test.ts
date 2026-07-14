import { describe, expect, it } from "vitest";
import {
  computeRuleIndicators,
  handicapLineToNumber,
} from "@/features/analysis/indicator-rules";
import {
  buildPriorityContext,
  matchPriorityRules,
  MIN_LEARNED_PATTERN_SAMPLES_FOR_AI,
} from "@/features/analysis/priority-rules";
import type {
  AnalysisRequest,
  CompanyOddsForAnalysis,
} from "@/features/analysis/contracts";

function request(
  overrides: Partial<AnalysisRequest> = {},
): AnalysisRequest {
  return {
    matchId: "match-1",
    homeTeam: "Home",
    awayTeam: "Away",
    league: "Test League",
    matchTime: "12:00",
    scheduleMode: "today",
    companies: [],
    ...overrides,
  };
}

function company(
  overrides: Partial<CompanyOddsForAnalysis> = {},
): CompanyOddsForAnalysis {
  return {
    companyId: "3",
    companyName: "Crown",
    openTime: "07-14 10:00",
    asianHomeInit: "0.95",
    asianLineInit: "0.5",
    asianAwayInit: "0.95",
    euroAsianHomeInit: "",
    euroAsianLineInit: "",
    euroAsianAwayInit: "",
    totalOverInit: "",
    totalLineInit: "",
    totalUnderInit: "",
    asianHomeLive: "0.80",
    asianLineLive: "0.5",
    asianAwayLive: "0.98",
    ...overrides,
  };
}

describe("analysis indicator rules", () => {
  it("preserves receiving-handicap sign semantics", () => {
    expect(handicapLineToNumber("受让半球")).toBe(-0.5);
    expect(handicapLineToNumber("半球/一球")).toBe(0.75);
  });

  it("returns all six indicators with default no-data signals", () => {
    const indicators = computeRuleIndicators(request());

    expect(indicators.map((indicator) => indicator.name)).toEqual([
      "盘口变化方向",
      "水位变化方向",
      "公司分歧度",
      "欧亚偏差",
      "开盘时间早晚",
      "大小球趋势",
    ]);
    expect(indicators).toHaveLength(6);
    expect(indicators.every((indicator) => indicator.reasoning.length > 0)).toBe(true);
  });

  it("maps a stronger home-favoring reference line to home water drop", () => {
    const indicators = computeRuleIndicators(
      request({
        companies: [company()],
        crown12Handicap: { home: "0.80", line: "1", away: "1.02" },
      }),
    );

    expect(indicators.find((item) => item.name === "盘口变化方向")).toMatchObject({
      signal: "主降水",
    });
    expect(indicators.find((item) => item.name === "水位变化方向")).toMatchObject({
      signal: "主降水",
    });
  });

  it("prefixes every indicator reasoning in history mode", () => {
    const indicators = computeRuleIndicators(request({ scheduleMode: "history" }));

    expect(
      indicators.every((indicator) => indicator.reasoning.startsWith("[历史数据] ")),
    ).toBe(true);
  });
});

describe("analysis priority rules", () => {
  it("keeps the learned-pattern sample threshold and empty rule set behavior", () => {
    const indicators = computeRuleIndicators(request());

    expect(MIN_LEARNED_PATTERN_SAMPLES_FOR_AI).toBe(20);
    expect(matchPriorityRules(indicators)).toEqual([]);
    expect(buildPriorityContext(indicators)).toBe("");
  });
});
