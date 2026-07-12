import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  predictions: [] as Record<string, unknown>[],
  odds: [] as Record<string, unknown>[],
  results: [] as Record<string, unknown>[],
  savedReport: null as Record<string, unknown> | null,
}));

vi.mock("@/storage/database/supabase-client", () => {
  class Query implements PromiseLike<{ data?: unknown; error: { message: string } | null }> {
    private filters = new Map<string, unknown>();
    private operation: "select" | "update" | "upsert" = "select";
    private value: Record<string, unknown> = {};

    constructor(private readonly table: string) {}

    select() { return this; }
    gte() { return this; }
    lte() { return this; }
    order() { return this; }
    limit() { return this; }
    in() { return this; }
    eq(column: string, value: unknown) { this.filters.set(column, value); return this; }
    update(value: Record<string, unknown>) { this.operation = "update"; this.value = value; return this; }
    upsert(value: Record<string, unknown>) {
      this.operation = "upsert";
      this.value = value;
      if (this.table === "daily_reports") db.savedReport = value;
      return this;
    }

    async maybeSingle() {
      if (this.table === "match_odds") {
        const row = db.odds.find(candidate =>
          candidate.match_id === this.filters.get("match_id")
          && candidate.match_date === this.filters.get("match_date"));
        return { data: row || null, error: null };
      }
      return { data: null, error: null };
    }

    then<TResult1 = { data?: unknown; error: { message: string } | null }, TResult2 = never>(
      onfulfilled?: ((value: { data?: unknown; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      let result: { data?: unknown; error: null };
      if (this.operation === "update" && this.table === "prediction_results") {
        for (const prediction of db.predictions) {
          const matches = [...this.filters].every(([key, value]) => prediction[key] === value);
          if (matches) Object.assign(prediction, this.value);
        }
        result = { data: null, error: null };
      } else if (this.table === "user_focused_leagues") {
        result = { data: [{ league_name: "英超" }], error: null };
      } else if (this.table === "prediction_results") {
        result = { data: db.predictions, error: null };
      } else if (this.table === "match_odds") {
        result = { data: db.odds, error: null };
      } else if (this.table === "match_results") {
        result = { data: db.results, error: null };
      } else if (this.table === "odds_snapshots") {
        result = { data: [], error: null };
      } else {
        result = { data: null, error: null };
      }
      return Promise.resolve(result).then(onfulfilled, onrejected);
    }
  }

  return { getSupabaseClient: () => ({ from: (table: string) => new Query(table) }) };
});

import { GET as verify } from "@/app/api/analysis/verify/route";
import { POST as report } from "@/app/api/report/route";

function prediction(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    match_date: "20260709",
    home_team: "Home",
    away_team: "Away",
    league: "英超",
    match_time: "12:00",
    handicap_trend: "升盘",
    water_direction: "主降水",
    prediction: "主",
    total_trend: "不变",
    total_prediction: "中立",
    total_action: "observe",
    confidence_level: "高",
    accuracy: "70%",
    strategy: "test",
    action: "test",
    is_correct: null,
    auto_is_correct: null,
    manual_is_correct: null,
    verification_status: "pending",
    verified_at: null,
    analyzed_at: null,
    actual_water_direction: null,
    actual_handicap_trend: null,
    indicators_json: [],
    strategy_version: null,
    ...overrides,
  };
}

describe("T-07 verification and report consistency", () => {
  beforeEach(() => {
    db.savedReport = null;
    db.odds = [];
    db.predictions = [
      prediction({
        match_id: "both-win",
        analyzed_at: "2026-07-09T04:00:00.000Z",
        prediction: "主",
        total_prediction: "大",
        handicap_settlement_line: 0.5,
        total_settlement_line: 2.5,
      }),
      prediction({
        match_id: "handicap-win",
        analyzed_at: "2026-07-09T04:30:00.000Z",
        prediction: "主",
        total_prediction: "大",
        handicap_settlement_line: 0.5,
        total_settlement_line: 2.5,
      }),
      prediction({
        match_id: "total-win",
        analyzed_at: "2026-07-09T05:00:00.000Z",
        prediction: "主",
        total_prediction: "大",
        handicap_settlement_line: 0.5,
        total_settlement_line: 2.5,
      }),
      prediction({
        match_id: "both-loss",
        analyzed_at: "2026-07-09T05:30:00.000Z",
        prediction: "主",
        total_prediction: "大",
        handicap_settlement_line: 0.5,
        total_settlement_line: 2.5,
      }),
      prediction({
        match_id: "quarter-lines",
        analyzed_at: "2026-07-09T06:00:00.000Z",
        prediction: "主",
        total_prediction: "大",
        handicap_settlement_line: 0.75,
        total_settlement_line: 1.25,
      }),
    ];
    db.results = [
      { match_id: "both-win", match_date: "20260709", status: "finished", home_score: 2, away_score: 1 },
      { match_id: "handicap-win", match_date: "20260709", status: "finished", home_score: 1, away_score: 0 },
      { match_id: "total-win", match_date: "20260709", status: "finished", home_score: 1, away_score: 2 },
      { match_id: "both-loss", match_date: "20260709", status: "finished", home_score: 0, away_score: 1 },
      { match_id: "quarter-lines", match_date: "20260709", status: "finished", home_score: 1, away_score: 0 },
    ];
  });

  it("uses identical effective results and excludes invalid rows from both denominators", async () => {
    const verifyResponse = await verify(new NextRequest(
      "http://local/api/analysis/verify?startDate=20260709&endDate=20260709",
    ));
    const verifyPayload = await verifyResponse.json();

    const reportResponse = await report(new Request(
      "http://local/api/report?predDate=20260709&mode=ai",
      { method: "POST" },
    ));
    const reportPayload = await reportResponse.json();

    expect(verifyResponse.status).toBe(200);
    expect(reportResponse.status).toBe(200);
    expect(verifyPayload.stats.markets).toMatchObject({
      handicap: {
        eligible: 5,
        weightedCorrect: 2.5,
        weightedWrong: 2,
        weightedTotal: 4.5,
        weightedAccuracy: 2.5 / 4.5,
        scoredCounts: { win: 2, half_win: 1, push: 0, half_loss: 0, loss: 2 },
      },
      total: {
        eligible: 5,
        weightedCorrect: 2,
        weightedWrong: 2.5,
        weightedTotal: 4.5,
        weightedAccuracy: 2 / 4.5,
        scoredCounts: { win: 2, half_win: 0, push: 0, half_loss: 1, loss: 2 },
      },
    });
    expect(reportPayload.report.summary.markets).toEqual(verifyPayload.stats.markets);
    expect(reportPayload.report.summary).toMatchObject({
      total: 4.5,
      correct: 2.5,
      wrong: 2,
      accuracy: "55.6",
      totalTotal: 4.5,
      totalCorrect: 2,
      totalWrong: 2.5,
      totalAccuracy: "44.4",
      manual: 0,
      unverified: 0,
    });
    expect(reportPayload.report.latestAnalysisAt).toBe("2026-07-09T06:00:00.000Z");
    expect(reportPayload.report.rows.map((row: Record<string, unknown>) => ({
      matchId: row.matchId,
      handicapOutcome: row.handicapOutcome,
      totalOutcome: row.totalOutcome,
    }))).toEqual([
      { matchId: "both-win", handicapOutcome: "win", totalOutcome: "win" },
      { matchId: "handicap-win", handicapOutcome: "win", totalOutcome: "loss" },
      { matchId: "total-win", handicapOutcome: "loss", totalOutcome: "win" },
      { matchId: "both-loss", handicapOutcome: "loss", totalOutcome: "loss" },
      { matchId: "quarter-lines", handicapOutcome: "half_win", totalOutcome: "half_loss" },
    ]);
    expect(db.savedReport).toMatchObject({ report_date: "20260709" });
  });

  it("keeps the latest analysis time null for legacy predictions", async () => {
    db.predictions = [prediction({ match_id: "legacy" })];
    db.odds = [];

    const response = await report(new Request(
      "http://local/api/report?predDate=20260709&mode=ai",
      { method: "POST" },
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.report.latestAnalysisAt).toBeNull();
  });
});
