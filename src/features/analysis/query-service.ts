import type { AnalysisPredictionMap, AnalysisResultData } from "./contracts";
import { parseDbJsonArray, parseDbJsonObject } from "./database-json";
import type { AnalysisProbabilityOutput } from "@/lib/probability";
import { serializeVerification } from "@/lib/verification/market-service";

export type AnalysisResultRow = Record<string, unknown>;

// Supabase's fluent builder changes its generic result shape after each operation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnalysisQueryClient = { from(table: string): any };

export class AnalysisQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisQueryError";
  }
}

function settlementEvidence(row: AnalysisResultRow) {
  return {
    handicap: {
      line: row.handicap_settlement_line,
      selection: row.handicap_selection,
      basis: row.handicap_settlement_basis,
      snapshotId: row.handicap_snapshot_id,
    },
    total: {
      line: row.total_settlement_line,
      selection: row.total_selection,
      basis: row.total_settlement_basis,
      snapshotId: row.total_snapshot_id,
    },
    actualScoreMargin: row.actual_score_margin,
    actualTotalGoals: row.actual_total_goals,
  };
}

function commonProjection(row: AnalysisResultRow, fallbackDate: string): AnalysisResultData {
  return {
    matchId: row.match_id as string,
    homeTeam: row.home_team as string,
    awayTeam: row.away_team as string,
    league: row.league as string,
    matchTime: row.match_time as string,
    matchDate: (row.match_date as string | null) || fallbackDate,
    analyzedAt: row.analyzed_at as string | null | undefined,
    indicators: [],
    newsSummary: "",
    waterDirection: (row.water_direction as string | null) || "不变",
    handicapTrend: (row.handicap_trend as string | null) || "不确定",
    prediction: (row.prediction as string | null) || "中立",
    totalTrend: (row.total_trend as string | null) || "不变",
    totalPrediction: (row.total_prediction as string | null) || "中立",
    totalAction: (row.total_action as string | null) || "",
    confidenceLevel: (row.confidence_level as string | null) || "低",
    accuracy: (row.accuracy as string | null) || "50%",
    strategy: (row.strategy as string | null) || "",
    action: (row.action as string | null) || "",
    reasoning: "",
    crown_handicap: (row.crown_handicap as string | null) || "",
    yinghe_handicap: (row.yinghe_handicap as string | null) || "",
    who_open_later: (row.who_open_later as string | null) || "",
    isCorrect: row.is_correct as boolean | null | undefined,
    manualIsCorrect: row.manual_is_correct as boolean | null | undefined,
    verification: serializeVerification(row),
    settlementEvidence: settlementEvidence(row),
    probability: parseDbJsonObject<AnalysisProbabilityOutput>(row.probability_output),
  };
}

export function projectAnalysisDetail(row: AnalysisResultRow, fallbackDate: string): AnalysisResultData {
  return {
    ...commonProjection(row, fallbackDate),
    indicators: parseDbJsonArray<AnalysisResultData["indicators"][number]>(row.indicators_json),
    newsSummary: (row.news_summary as string | null) || "",
    reasoning: (row.llm_reasoning as string | null) || "",
  };
}

export function projectAnalysisSummary(row: AnalysisResultRow, fallbackDate: string): AnalysisResultData {
  return commonProjection(row, fallbackDate);
}

export class SupabaseAnalysisQueryRepository {
  constructor(private readonly client: AnalysisQueryClient) {}

  async findDetail(date: string, matchId: string): Promise<AnalysisResultData | null> {
    const { data, error } = await this.client.from("prediction_results")
      .select("*,analyzed_at")
      .eq("match_date", date)
      .eq("match_id", matchId)
      .single();
    if (error || !data) return null;
    return projectAnalysisDetail(data, date);
  }

  async findByDate(date: string): Promise<AnalysisPredictionMap> {
    const { data, error } = await this.client.from("prediction_results")
      .select("*,analyzed_at")
      .eq("match_date", date);
    if (error) throw new AnalysisQueryError(error.message);
    const predictions: AnalysisPredictionMap = {};
    for (const row of data || []) {
      const prediction = projectAnalysisSummary(row, date);
      predictions[prediction.matchId] = prediction;
    }
    return predictions;
  }
}
