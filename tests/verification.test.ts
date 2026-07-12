import { describe, expect, it } from "vitest";
import {
  combineSettlementLegs,
  determineWaterDirection,
  handicapLineToNumber,
  resolveEffectiveVerification,
  resolveStoredEffectiveVerification,
  settlePrediction,
  splitHandicapLine,
  summarizeSettlementOutcomes,
  verifyWaterPrediction,
} from "@/lib/verification";

describe("T-03 handicap parsing", () => {
  it.each([
    ["平手", 0],
    ["平/半", 0.25],
    ["半球/一球", 0.75],
    ["球半/两球", 1.75],
    ["0", 0],
    ["0/0.5", 0.25],
    ["1.5/2", 1.75],
    ["半球/1", 0.75],
    ["0.5/一球", 0.75],
    ["受让平/半", -0.25],
    ["受半球/1", -0.75],
    ["*受让0.5/一球", -0.75],
  ])("parses %s as %s", (line, expected) => {
    expect(handicapLineToNumber(line)).toBe(expected);
  });

  it("rejects empty and unknown handicap text", () => {
    expect(handicapLineToNumber("")).toBeNaN();
    expect(handicapLineToNumber("未知盘口")).toBeNaN();
  });
});

describe("score settlement", () => {
  it.each([
    ["平/半", [0, 0.5]],
    ["半球/一球", [0.5, 1]],
    ["受让平/半", [-0.5, 0]],
    ["受半球/1", [-1, -0.5]],
    [0.25000000000000006, [0, 0.5]],
    [-0.7500000000000001, [-1, -0.5]],
    [1, [1]],
  ])("splits %s into stable half-goal legs", (line, expected) => {
    expect(splitHandicapLine(line)).toEqual(expected);
  });

  it("rejects values outside quarter-goal boundaries", () => {
    expect(splitHandicapLine(0.3)).toBeNull();
  });

  it.each([
    [{ market: "handicap", prediction: "主", line: "半球", homeScore: 2, awayScore: 1 }, "win"],
    [{ market: "handicap", prediction: "客", line: "半球", homeScore: 2, awayScore: 1 }, "loss"],
    [{ market: "handicap", prediction: "主", line: "受让半球", homeScore: 1, awayScore: 1 }, "win"],
    [{ market: "handicap", prediction: "客", line: "受让半球", homeScore: 1, awayScore: 1 }, "loss"],
    [{ market: "handicap", prediction: "主", line: "一球", homeScore: 2, awayScore: 1 }, "push"],
    [{ market: "handicap", prediction: "客", line: "一球半", homeScore: 2, awayScore: 1 }, "win"],
    [{ market: "handicap", prediction: "主", line: "平/半", homeScore: 1, awayScore: 1 }, "half_loss"],
    [{ market: "handicap", prediction: "客", line: "平/半", homeScore: 1, awayScore: 1 }, "half_win"],
    [{ market: "handicap", prediction: "主", line: "半球/一球", homeScore: 2, awayScore: 1 }, "half_win"],
    [{ market: "handicap", prediction: "主", line: "一球/球半", homeScore: 2, awayScore: 1 }, "half_loss"],
    [{ market: "total", prediction: "大", line: "2.5/3", homeScore: 2, awayScore: 1 }, "half_win"],
    [{ market: "total", prediction: "小", line: "2.5/3", homeScore: 1, awayScore: 1 }, "win"],
    [{ market: "total", prediction: "大", line: "3", homeScore: 2, awayScore: 1 }, "push"],
    [{ market: "total", prediction: "小", line: 2.25, homeScore: 1, awayScore: 1 }, "half_win"],
  ] as const)("settles %# with normalized home handicap signs", (input, expected) => {
    expect(settlePrediction(input)).toBe(expected);
  });

  it.each([
    [{ market: "handicap", prediction: "观望", line: "半球", homeScore: 1, awayScore: 0 }, "pending"],
    [{ market: "total", prediction: "大", line: "2.5", homeScore: null, awayScore: 1 }, "pending"],
    [{ market: "handicap", prediction: "主", line: "未知", homeScore: 1, awayScore: 0 }, "invalid"],
    [{ market: "total", prediction: "大", line: null, homeScore: 1, awayScore: 0 }, "invalid"],
    [{ market: "total", prediction: "大", line: 2.5, homeScore: 1, awayScore: 0, specialStatus: "void" }, "void"],
    [{ market: "total", prediction: "大", line: 2.5, homeScore: 1, awayScore: 0, specialStatus: "legacy_unknown" }, "legacy_unknown"],
  ] as const)("handles non-scoring case %#", (input, expected) => {
    expect(settlePrediction(input)).toBe(expected);
  });

  it("combines quarter legs into five settlement grades", () => {
    expect(combineSettlementLegs(["win", "push"])).toBe("half_win");
    expect(combineSettlementLegs(["loss", "push"])).toBe("half_loss");
    expect(combineSettlementLegs(["win"])).toBe("win");
    expect(combineSettlementLegs(["push"])).toBe("push");
  });
});

describe("weighted settlement summary", () => {
  it("weights half outcomes and manual results while counting non-scoring states", () => {
    const summary = summarizeSettlementOutcomes(
      ["win", "half_win", "push", "half_loss", "loss", "pending", "invalid", "void", "legacy_unknown"],
      [true, false],
    );
    expect(summary).toMatchObject({
      weightedCorrect: 2.5,
      weightedWrong: 2.5,
      weightedTotal: 5,
      weightedAccuracy: 0.5,
      scoredCounts: { win: 1, half_win: 1, push: 1, half_loss: 1, loss: 1 },
      nonScoringCounts: { pending: 1, invalid: 1, void: 1, legacy_unknown: 1 },
    });
  });

  it("returns null accuracy when only pushes and non-scoring states exist", () => {
    expect(summarizeSettlementOutcomes(["push", "pending", "void"])).toMatchObject({
      weightedCorrect: 0,
      weightedWrong: 0,
      weightedTotal: 0,
      weightedAccuracy: null,
    });
  });
});

describe("T-04 water direction and threshold", () => {
  it.each([
    [{ handicapHome: "1.00", handicapAway: "0.90" }, { handicapHome: "0.96", handicapAway: "0.94" }, "主降水"],
    [{ handicapHome: "0.90", handicapAway: "1.00" }, { handicapHome: "0.94", handicapAway: "0.96" }, "客降水"],
    [{ handicapHome: "1.00", handicapAway: "0.90" }, { handicapHome: "0.97", handicapAway: "0.93" }, "不变"],
    [{ handicapHome: "1.00", handicapAway: "1.00" }, { handicapHome: "0.95", handicapAway: "1.05" }, "主降水"],
    [{ handicapHome: "1.00", handicapAway: "1.00" }, { handicapHome: "1.05", handicapAway: "0.95" }, "客降水"],
  ])("classifies stable threshold and two-sided movement", (initial, live, expected) => {
    expect(determineWaterDirection(initial, live)).toBe(expected);
  });

  it("returns null when any water value is missing or invalid", () => {
    expect(determineWaterDirection(
      { handicapHome: "1.00", handicapAway: "0.90" },
      { handicapHome: "invalid", handicapAway: "0.90" },
    )).toBeNull();
  });
});

describe("T-05 missing and invalid verification data", () => {
  it("keeps a missing terminal line pending and out of the correctness denominator", () => {
    const result = verifyWaterPrediction("主降水", {
      crown_12_odds: { handicapLine: "半球", handicapHome: "1.00", handicapAway: "0.90" },
    });
    expect(result).toMatchObject({ status: "pending", autoIsCorrect: null, reason: "缺少终盘盘口" });
  });

  it("marks missing water values invalid when the line is unchanged", () => {
    const result = verifyWaterPrediction("不变", {
      crown_12_odds: { handicapLine: "半球", handicapHome: "1.00" },
      crown_live_odds: { handicapLine: "半球", handicapHome: "0.99" },
    });
    expect(result).toMatchObject({ status: "invalid", autoIsCorrect: null, reason: "盘口不变但水位数据不完整" });
  });

  it.each([
    ["未知盘口", "半球"],
    ["半球", "未知盘口"],
  ])("marks an unrecognized handicap invalid", (initialLine, liveLine) => {
    const result = verifyWaterPrediction("主降水", {
      crown_12_odds: { handicapLine: initialLine, handicapHome: "1.00", handicapAway: "0.90" },
      crown_live_odds: { handicapLine: liveLine, handicapHome: "0.90", handicapAway: "1.00" },
    });
    expect(result).toMatchObject({ status: "invalid", autoIsCorrect: null, reason: "盘口格式无法识别" });
  });

  it("never turns an invalid predicted direction into a correct result", () => {
    const result = verifyWaterPrediction("中立", {
      crown_12_odds: { handicapLine: "半球", handicapHome: "1.00", handicapAway: "0.90" },
      crown_live_odds: { handicapLine: "一球", handicapHome: "0.90", handicapAway: "1.00" },
    });
    expect(result).toMatchObject({ status: "invalid", autoIsCorrect: null });
  });
});

describe("T-06 manual override and undo", () => {
  it("prioritizes a traceable manual result without changing the automatic value", () => {
    const automatic = false;
    expect(resolveEffectiveVerification(automatic, true, "wrong")).toEqual({
      status: "manual",
      isCorrect: true,
      source: "manual",
    });
    expect(automatic).toBe(false);
  });

  it("restores the automatic result after a manual override is cleared", () => {
    const overridden = resolveStoredEffectiveVerification({
      auto_is_correct: true,
      manual_is_correct: false,
      is_correct: false,
      verification_status: "manual",
    });
    const restored = resolveEffectiveVerification(true, null, "correct");

    expect(overridden).toEqual({ status: "manual", isCorrect: false, source: "manual" });
    expect(restored).toEqual({ status: "correct", isCorrect: true, source: "auto" });
  });

  it("restores invalid rather than inventing a result when no automatic result exists", () => {
    expect(resolveEffectiveVerification(null, null, "invalid")).toEqual({
      status: "invalid",
      isCorrect: null,
      source: null,
    });
  });
});
