import type { AnalysisRequest, RuleIndicator } from "./contracts";
import type { LlmPrediction } from "./llm-analysis-service";
import type { AnalysisProbabilityOutput } from "@/lib/probability";
import type { IndicatorWeights, StrategySnapshot } from "@/lib/analysis/strategy";
import { DEFAULT_INDICATOR_WEIGHTS, loadPublishedStrategy, normalizeIndicatorWeights } from "@/lib/analysis/strategy";
import { MIN_LEARNED_PATTERN_SAMPLES_FOR_AI } from "./priority-rules";
import { handicapLineToNumber, parseNumber } from "./indicator-rules";
import { serializeVerification, settleMarket } from "@/lib/verification/market-service";

export interface StrategyResolution {
  strategy: StrategySnapshot | null;
  weights: IndicatorWeights;
  learnedContext: string;
}

export interface StrategyRepository {
  load(request: AnalysisRequest, asOf: string): Promise<StrategyResolution>;
}

export interface AnalysisSaveInput {
  request: AnalysisRequest;
  analyzedAt: string;
  indicators: RuleIndicator[];
  newsSummary: string;
  prediction: LlmPrediction;
  confidenceLevel: string;
  probability: AnalysisProbabilityOutput;
  strategy: StrategySnapshot | null;
  weights: IndicatorWeights;
  priorityRules: { matched: Array<Record<string, unknown>>; topPriority: string | null };
  scores: { home: number; away: number };
  whoOpenLater: string;
}

export interface AnalysisSaveResult {
  verification?: ReturnType<typeof serializeVerification>;
  settlementEvidence?: Record<string, unknown>;
  matchDate?: string;
}

export interface AnalysisRepository {
  save(input: AnalysisSaveInput): Promise<AnalysisSaveResult>;
}

// Supabase's fluent builder changes its generic result shape after each operation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = { from(table: string): any };

export class SupabaseStrategyRepository implements StrategyRepository {
  constructor(private readonly client: SupabaseClient) {}

  async load(request: AnalysisRequest, asOf: string): Promise<StrategyResolution> {
    const strategy = await loadPublishedStrategy(this.client, asOf);
    if (!strategy) return { strategy: null, weights: { ...DEFAULT_INDICATOR_WEIGHTS }, learnedContext: "" };
    const weights = normalizeIndicatorWeights(strategy.weights);
    const names: Record<string, string> = {
      indicator_handicap_direction: "盘口变化方向", indicator_water_direction: "水位变化方向",
      indicator_divergence: "公司分歧度", indicator_euro_asian: "欧亚偏差",
      indicator_open_time: "开盘时间早晚", indicator_total_goals: "大小球趋势",
    };
    let learnedContext = `已发布策略 ${strategy.strategyVersion}，动态权重: ${Object.entries(weights).map(([key, value]) => `${names[key] || key}: ${(value * 100).toFixed(1)}%`).join(", ")}\n`;
    if (request.league && request.league !== "ALL") {
      const { data } = await this.client.from("learned_patterns")
        .select("market, pattern_description, hit_rate, total_predictions").eq("league", request.league)
        .in("status", ["published", "retired"]).eq("strategy_version", strategy.strategyVersion)
        .lte("published_at", asOf).or(`retired_at.is.null,retired_at.gt.${asOf}`).gte("hit_rate", 0.6)
        .gte("total_predictions", MIN_LEARNED_PATTERN_SAMPLES_FOR_AI).order("hit_rate", { ascending: false }).limit(5);
      for (const pattern of data || []) {
        learnedContext += `- [${pattern.market === "total" ? "进球" : "让球"}] ${pattern.pattern_description}: 加权准确率${(pattern.hit_rate * 100).toFixed(0)}% (加权样本${pattern.total_predictions})\n`;
      }
    }
    return { strategy, weights, learnedContext };
  }
}

export class AnalysisPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisPersistenceError";
  }
}

export class SupabaseAnalysisRepository implements AnalysisRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly clock: () => Date = () => new Date(),
    private readonly logError: (message: string, context?: unknown) => void = console.error,
  ) {}

  async save(input: AnalysisSaveInput): Promise<AnalysisSaveResult> {
    try {
      return await this.savePrediction(input);
    } catch (error) {
      if (error instanceof AnalysisPersistenceError) throw error;
      const message = error instanceof Error ? error.message : "保存预测失败";
      throw new AnalysisPersistenceError(message);
    }
  }

  private async savePrediction(input: AnalysisSaveInput): Promise<AnalysisSaveResult> {
    const { request, prediction, probability } = input;
    const matchDate = request.matchDate || (() => { const date = this.clock(); return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`; })();
    const source = request.source === "backtest" ? "backtest" : "production";
    const table = source === "backtest" ? "prediction_results_backtest" : "prediction_results";
    const { data: previous } = await this.client.from(table).select("prediction_revision").eq("match_id", request.matchId).eq("match_date", matchDate).maybeSingle();
    const crown = request.companies.find(company => company.companyId === "3");
    const yinghe = request.companies.find(company => company.companyId === "35");
    const signals: Record<string, string> = {};
    const signalKeys: Record<string, string> = { "盘口变化方向": "indicator_handicap_direction", "水位变化方向": "indicator_water_direction", "公司分歧度": "indicator_divergence", "欧亚偏差": "indicator_euro_asian", "开盘时间早晚": "indicator_open_time", "大小球趋势": "indicator_total_goals" };
    for (const indicator of input.indicators) if (signalKeys[indicator.name]) signals[signalKeys[indicator.name]] = indicator.signal;
    const settlementBasis = request.scheduleMode === "future" ? "analysis_crown_live" : "analysis_crown_12";
    const handicapSettlement = request.scheduleMode === "future" ? request.crownLiveHandicap : request.crown12Handicap;
    const totalSettlement = request.scheduleMode === "future" ? request.crownLiveTotal : request.crown12Total;
    const payload = {
      match_id: request.matchId, match_date: matchDate, source, run_id: request.runId || null,
      home_team: request.homeTeam, away_team: request.awayTeam, league: request.league, match_time: request.matchTime,
      analyzed_at: input.analyzedAt, water_direction: prediction.waterDirection, handicap_trend: prediction.handicapTrend,
      prediction: prediction.prediction, total_trend: prediction.totalTrend, total_prediction: prediction.totalPrediction,
      confidence_level: input.confidenceLevel, accuracy: prediction.accuracy, strategy: prediction.strategy,
      action: prediction.action, total_action: prediction.totalAction,
      indicator_handicap_direction: signals.indicator_handicap_direction || null, indicator_water_direction: signals.indicator_water_direction || null,
      indicator_divergence: signals.indicator_divergence || null, indicator_euro_asian: signals.indicator_euro_asian || null,
      indicator_open_time: signals.indicator_open_time || null, indicator_total_goals: signals.indicator_total_goals || null,
      up_score: input.scores.home, down_score: input.scores.away, crown_handicap: crown?.asianLineInit || null,
      yinghe_handicap: yinghe?.asianLineInit || null, who_open_later: input.whoOpenLater,
      indicators_json: input.indicators, news_summary: input.newsSummary, llm_reasoning: prediction.reasoning,
      priority_rules_json: input.priorityRules, strategy_version: input.strategy?.strategyVersion || null,
      weights_version: input.strategy?.weightsVersion || "default-v1", model_version: input.strategy?.modelVersion || "analysis-v1",
      weights_snapshot: input.weights, probability_output: probability, probability_model_version: probability.modelVersion || null,
      probability_calibration_version: probability.calibrationVersion, probability_source_observed_at: probability.sourceObservedAt,
      probability_quality_status: probability.quality, prediction_revision: Number(previous?.prediction_revision || 0) + 1,
      handicap_settlement_line: handicapSettlement?.line ? handicapLineToNumber(handicapSettlement.line) : null,
      handicap_selection: prediction.prediction, handicap_settlement_basis: handicapSettlement?.line ? settlementBasis : null, handicap_snapshot_id: null,
      total_settlement_line: totalSettlement?.line ? parseNumber(totalSettlement.line) : null, total_selection: prediction.totalPrediction,
      total_settlement_basis: totalSettlement?.line ? settlementBasis : null, total_snapshot_id: null,
      actual_score_margin: null, actual_total_goals: null,
      handicap_auto_outcome: null, handicap_auto_is_correct: null, handicap_manual_is_correct: null, handicap_effective_is_correct: null,
      handicap_automatic_status: "pending", handicap_effective_status: "unverified", handicap_settlement_reason: null,
      handicap_auto_verified_at: null, handicap_manual_verified_at: null, handicap_final_verified_at: null, handicap_verified_by: null,
      total_auto_outcome: null, total_auto_is_correct: null, total_manual_is_correct: null, total_effective_is_correct: null,
      total_automatic_status: "pending", total_effective_status: "unverified", total_settlement_reason: null,
      total_auto_verified_at: null, total_manual_verified_at: null, total_final_verified_at: null, total_verified_by: null,
      is_correct: null, auto_is_correct: null, manual_is_correct: null, verification_status: "pending",
      water_verification_status: "pending", total_verification_status: "pending", actual_handicap_trend: null,
      actual_water_direction: null, verified_at: null,
    };
    const { error } = await this.client.from(table).upsert(payload, { onConflict: "match_id,match_date" });
    if (error) {
      this.logError("[Analysis] Save prediction error:", error.message);
      throw new AnalysisPersistenceError(error.message);
    }
    const result: AnalysisSaveResult = { matchDate };
    const { data: matchResult } = await this.client.from("match_results").select("home_score,away_score,status").eq("match_id", request.matchId).eq("match_date", matchDate).maybeSingle();
    if (matchResult?.status === "finished") {
      const now = this.clock().toISOString();
      const update = { actual_score_margin: Number(matchResult.home_score) - Number(matchResult.away_score), actual_total_goals: Number(matchResult.home_score) + Number(matchResult.away_score), ...settleMarket(payload, "handicap", matchResult, undefined, now), ...settleMarket(payload, "total", matchResult, undefined, now) };
      const { data: rows, error: settleError } = await this.client.from(table).update(update).eq("match_id", request.matchId).eq("match_date", matchDate).select("*");
      if (settleError) {
        this.logError("[Analysis] Immediate settlement error:", settleError.message);
      } else {
        const settled = rows?.[0] ? { ...payload, ...rows[0] } : { ...payload, ...update };
        result.verification = serializeVerification(settled);
        result.settlementEvidence = { actualScoreMargin: settled.actual_score_margin, actualTotalGoals: settled.actual_total_goals };
      }
    }
    return result;
  }
}
