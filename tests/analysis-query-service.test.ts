import { describe, expect, it } from "vitest";
import {
  AnalysisQueryError,
  SupabaseAnalysisQueryRepository,
  projectAnalysisDetail,
  projectAnalysisSummary,
} from "@/features/analysis/query-service";

const baseRow = {
  match_id: "match-1",
  match_date: "20260711",
  home_team: "Home",
  away_team: "Away",
  league: "英超",
  match_time: "12:00",
  analyzed_at: "2026-07-11T04:30:00.000Z",
  water_direction: null,
  handicap_trend: null,
  prediction: null,
  total_trend: null,
  total_prediction: null,
  total_action: null,
  confidence_level: null,
  accuracy: null,
  strategy: null,
  action: null,
  crown_handicap: null,
  yinghe_handicap: null,
  who_open_later: null,
  is_correct: null,
  manual_is_correct: null,
  probability_output: null,
  handicap_settlement_line: null,
  handicap_selection: null,
  handicap_settlement_basis: null,
  handicap_snapshot_id: null,
  total_settlement_line: null,
  total_selection: null,
  total_settlement_basis: null,
  total_snapshot_id: null,
  actual_score_margin: null,
  actual_total_goals: null,
};

describe("analysis GET query boundary", () => {
  it("projects detail rows with native/text DB JSON and exact compatibility defaults", () => {
    const indicators = [{ name: "水位变化方向", value: "主降", signal: "主降水", weight: 0.2, reasoning: "测试" }];
    const probability = { modelVersion: "probability-v1", home: 0.55 };

    expect(projectAnalysisDetail({
      ...baseRow,
      indicators_json: JSON.stringify(indicators),
      probability_output: probability,
      news_summary: "新闻",
      llm_reasoning: "推理",
    }, "fallback-date")).toEqual(expect.objectContaining({
      matchId: "match-1",
      matchDate: "20260711",
      analyzedAt: "2026-07-11T04:30:00.000Z",
      indicators,
      probability,
      newsSummary: "新闻",
      reasoning: "推理",
      waterDirection: "不变",
      handicapTrend: "不确定",
      prediction: "中立",
      totalTrend: "不变",
      totalPrediction: "中立",
      confidenceLevel: "低",
      accuracy: "50%",
    }));

    expect(projectAnalysisDetail({
      ...baseRow,
      indicators_json: indicators,
      probability_output: JSON.stringify(probability),
    }, "fallback-date")).toEqual(expect.objectContaining({ indicators, probability }));
  });

  it("projects list rows without detail-only content", () => {
    expect(projectAnalysisSummary({
      ...baseRow,
      indicators_json: [{ name: "hidden" }],
      news_summary: "hidden",
      llm_reasoning: "hidden",
      probability_output: '{"modelVersion":"probability-v1"}',
    }, "fallback-date")).toEqual(expect.objectContaining({
      matchId: "match-1",
      matchDate: "20260711",
      indicators: [],
      newsSummary: "",
      reasoning: "",
      probability: { modelVersion: "probability-v1" },
    }));
  });

  it("preserves detail-not-found and list query error semantics", async () => {
    class Query implements PromiseLike<{ data: typeof baseRow[]; error: { message: string } | null }> {
      constructor(private readonly mode: "detail" | "list-error") {}
      select() { return this; }
      eq() { return this; }
      async single() { return { data: null, error: { message: "not found" } }; }
      then<TResult1 = { data: typeof baseRow[]; error: { message: string } | null }, TResult2 = never>(
        onfulfilled?: ((value: { data: typeof baseRow[]; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve({ data: [], error: this.mode === "list-error" ? { message: "db unavailable" } : null }).then(onfulfilled, onrejected);
      }
    }

    const detailRepository = new SupabaseAnalysisQueryRepository({ from: () => new Query("detail") });
    await expect(detailRepository.findDetail("20260711", "missing")).resolves.toBeNull();

    const listRepository = new SupabaseAnalysisQueryRepository({ from: () => new Query("list-error") });
    await expect(listRepository.findByDate("20260711")).rejects.toEqual(new AnalysisQueryError("db unavailable"));
  });
});
