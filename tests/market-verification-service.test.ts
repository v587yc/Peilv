import { describe, expect, it } from "vitest";
import {
  buildManualVerificationUpdate,
  marketVerificationWeight,
  settleMarket,
  summarizeMarketRows,
} from "@/lib/verification/market-service";
import {
  loadPersistedFinishedResultSummary,
  persistScheduleResults,
  scheduleMatchToResult,
  type ParsedMatchResult,
} from "@/lib/verification/match-results";

const base = {
  prediction: "主",
  total_prediction: "大",
  handicap_settlement_line: 0.75,
  total_settlement_line: 2.75,
  handicap_settlement_basis: "analysis_crown_12",
  total_settlement_basis: "analysis_crown_12",
  handicap_manual_is_correct: null,
  total_manual_is_correct: null,
};

describe("dual-market verification service", () => {
  it.each([
    ["主", "大", "half_win", "half_win"],
    ["主", "小", "half_win", "half_loss"],
    ["客", "大", "half_loss", "half_win"],
    ["客", "小", "half_loss", "half_loss"],
  ])("settles independent selections %s/%s", (prediction, totalPrediction, handicapOutcome, totalOutcome) => {
    const row = { ...base, prediction, total_prediction: totalPrediction };
    const result = { home_score: 2, away_score: 1, status: "finished" };
    expect(settleMarket(row, "handicap", result).handicap_auto_outcome).toBe(handicapOutcome);
    expect(settleMarket(row, "total", result).total_auto_outcome).toBe(totalOutcome);
  });

  it("does not write legacy shared fields for total", () => {
    const update = settleMarket(base, "total", { home_score: 2, away_score: 1, status: "finished" });
    expect(update).not.toHaveProperty("is_correct");
    expect(update).not.toHaveProperty("auto_is_correct");
    expect(buildManualVerificationUpdate(base, "total", true, "now", "admin")).not.toHaveProperty("manual_is_correct");
  });

  it("restores automatic effective correctness when a manual override is withdrawn", () => {
    const row = { ...base, handicap_auto_outcome: "win", handicap_auto_is_correct: true, handicap_automatic_status: "correct", handicap_manual_is_correct: false };
    const update = buildManualVerificationUpdate(row, "handicap", null, "now", "admin");
    expect(update).toMatchObject({ handicap_effective_is_correct: true, handicap_effective_status: "correct", is_correct: true, verification_status: "correct" });
  });

  it("weights half outcomes and never double-counts overridden automatic outcomes", () => {
    const summary = summarizeMarketRows([
      { handicap_auto_outcome: "half_win", handicap_manual_is_correct: null },
      { handicap_auto_outcome: "win", handicap_manual_is_correct: false },
      { handicap_auto_outcome: "half_loss", handicap_manual_is_correct: null },
    ], "handicap");
    expect(summary).toMatchObject({ weightedCorrect: 0.5, weightedWrong: 1.5, weightedTotal: 2, weightedAccuracy: 0.25 });
  });

  it("uses the same weighted samples for learning and aggregate accuracy", () => {
    const rows = [
      { handicap_auto_outcome: "win", handicap_manual_is_correct: null },
      { handicap_auto_outcome: "half_win", handicap_manual_is_correct: null },
      { handicap_auto_outcome: "push", handicap_manual_is_correct: null },
      { handicap_auto_outcome: "half_loss", handicap_manual_is_correct: null },
      { handicap_auto_outcome: "loss", handicap_manual_is_correct: true },
    ];
    const weights = rows.map(row => marketVerificationWeight(row, "handicap"));
    const learningTotals = weights.reduce((totals, weight) => ({
      correct: totals.correct + weight.weightedCorrect,
      wrong: totals.wrong + weight.weightedWrong,
      total: totals.total + weight.weightedTotal,
    }), { correct: 0, wrong: 0, total: 0 });
    const summary = summarizeMarketRows(rows, "handicap");
    expect(learningTotals).toEqual({
      correct: summary.weightedCorrect,
      wrong: summary.weightedWrong,
      total: summary.weightedTotal,
    });
    expect(learningTotals).toEqual({ correct: 2.5, wrong: 0.5, total: 3 });
  });

  it("keeps missing scores pending and historical evidence absence legacy_unknown", () => {
    expect(settleMarket(base, "handicap", null).handicap_auto_outcome).toBe("pending");
    expect(settleMarket({ prediction: "主" }, "handicap", { home_score: 1, away_score: 0, status: "finished" }).handicap_auto_outcome).toBe("legacy_unknown");
  });

  it("marks crown opening fallback evidence without using live odds", () => {
    const update = settleMarket({ prediction: "主" }, "handicap", { home_score: 1, away_score: 0, status: "finished" }, { line: 0.5, basis: "crown_opening_proxy" });
    expect(update).toMatchObject({ handicap_settlement_basis: "crown_opening_proxy", handicap_auto_outcome: "win" });
  });
});

describe("schedule result extraction", () => {
  it("persists only a normal final score as finished", () => {
    expect(scheduleMatchToResult({ id: "1", matchDate: "20260712", state: "-1", homeScore: "2", awayScore: "1", halfHomeScore: "1", halfAwayScore: "0" })).toMatchObject({ status: "finished", home_score: 2, away_score: 1 });
    expect(scheduleMatchToResult({ id: "2", matchDate: "20260712", state: "-1", homeScore: "取消", awayScore: "" })).toMatchObject({ status: "special", home_score: null, away_score: null });
  });

  it("never fabricates missing scores and preserves source attribution", () => {
    expect(scheduleMatchToResult({ id: "1", matchDate: "20260712", state: "-1", homeScore: "", awayScore: "1" }, "2026-07-12T00:00:00.000Z", "titan_live_bfdata")).toMatchObject({
      status: "special",
      home_score: null,
      away_score: null,
      score_source: "titan_live_bfdata",
    });
    expect(scheduleMatchToResult({ id: "2", matchDate: "20260712", state: "0", homeScore: "", awayScore: "" })).toBeNull();
  });

  it("can restrict live fallback persistence to finished rows", async () => {
    let written: ParsedMatchResult[] = [];
    const supabase = {
      from: () => ({
        upsert: async (rows: ParsedMatchResult[], options: { onConflict: string }) => {
          expect(options).toEqual({ onConflict: "match_id,match_date" });
          written = rows;
          return { error: null };
        },
      }),
    };
    const count = await persistScheduleResults(supabase, [
      { id: "1", matchDate: "20260712", state: "-1", homeScore: "2", awayScore: "1" },
      { id: "2", matchDate: "20260712", state: "1", homeScore: "1", awayScore: "0" },
    ], { scoreSource: "titan_live_bfdata", finishedOnly: true, observedAt: "2026-07-12T00:00:00.000Z" });
    expect(count).toBe(1);
    expect(written).toEqual([expect.objectContaining({ match_id: "1", status: "finished", score_source: "titan_live_bfdata" })]);
  });

  it("summarizes only invariant-valid cached finished results", async () => {
    const rows = [
      { status: "finished", home_score: 2, away_score: 1, score_source: "titan_schedule_history", observed_at: "2026-07-11T01:00:00.000Z" },
      { status: "finished", home_score: 0, away_score: 0, score_source: "titan_live_bfdata", observed_at: "2026-07-11T02:00:00.000Z" },
      { status: "finished", home_score: null, away_score: 1, score_source: "titan_schedule_history", observed_at: "2026-07-11T03:00:00.000Z" },
      { status: "special", home_score: 3, away_score: 2, score_source: "titan_schedule_history", observed_at: "2026-07-11T04:00:00.000Z" },
    ];
    const summary = await loadPersistedFinishedResultSummary({
      from: () => ({ select: () => ({ eq: async () => ({ data: rows, error: null }) }) }),
    }, "20260711");
    expect(summary).toEqual({
      finishedResultCount: 2,
      sourceCounts: { titan_schedule_history: 1, titan_live_bfdata: 1 },
      oldestObservedAt: "2026-07-11T01:00:00.000Z",
      newestObservedAt: "2026-07-11T02:00:00.000Z",
    });
  });
});
