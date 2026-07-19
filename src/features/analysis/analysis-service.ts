import type { AnalysisRequest, RuleIndicator } from "./contracts";
import type { LlmAnalysisInput, LlmPrediction } from "./llm-analysis-service";
import type { AnalysisRepository, StrategyRepository } from "./repository";
import { computeRuleIndicators, normalizeOpenTime } from "./indicator-rules";
import { matchPriorityRules } from "./priority-rules";
import { DEFAULT_INDICATOR_WEIGHTS, predictionAsOf } from "@/lib/analysis/strategy";
import { finalizeAnalysisProbability, prepareAnalysisProbability, probabilityPromptContext, type AnalysisProbabilityOutput } from "@/lib/probability";

export interface AnalysisResult {
  matchId: string; homeTeam: string; awayTeam: string; league: string; matchTime: string; analyzedAt: string;
  indicators: RuleIndicator[]; newsSummary: string; llmPrediction: LlmPrediction;
  priorityRules: { matched: Array<{ id: string; priority: string; description: string; implication: string; hitRate: number; samples: number }>; topPriority: string | null };
  crown_handicap: string; yinghe_handicap: string; who_open_later: string; strategy: string; prediction: string;
  water_direction: string; accuracy: string; confidence_level: string; action: string;
  total_prediction: string; total_trend: string; total_action: string; probability: AnalysisProbabilityOutput;
  verification?: unknown; settlementEvidence?: Record<string, unknown>;
}

export interface AnalysisLogger { error(message: string, context?: unknown): void }
export interface AnalysisDependencies {
  strategyRepository: StrategyRepository;
  analysisRepository: AnalysisRepository;
  newsSearch(homeTeam: string, awayTeam: string): Promise<string>;
  llmAnalyzer(input: LlmAnalysisInput): Promise<LlmPrediction>;
  enqueueT30(request: AnalysisRequest, matchDate: string, now: Date): Promise<void>;
  notify(result: AnalysisResult): Promise<void>;
  clock(): Date;
  logger: AnalysisLogger;
}

export async function analyzeMatch(request: AnalysisRequest, dependencies: AnalysisDependencies): Promise<AnalysisResult> {
  const now = dependencies.clock();
  let resolved;
  try {
    resolved = await dependencies.strategyRepository.load(request, predictionAsOf(request, now));
  } catch {
    resolved = { strategy: null, weights: { ...DEFAULT_INDICATOR_WEIGHTS }, learnedContext: "" };
  }
  const indicators = computeRuleIndicators(request, resolved.weights);
  const prepared = prepareAnalysisProbability(request);
  const newsSummary = await dependencies.newsSearch(request.homeTeam, request.awayTeam);
  const llmPrediction = await dependencies.llmAnalyzer({ request, indicators, newsSummary, learnedContext: resolved.learnedContext, probabilityContext: probabilityPromptContext(prepared) });
  const probability = finalizeAnalysisProbability(prepared, { handicap: llmPrediction.prediction, total: llmPrediction.totalPrediction });
  const crown = request.companies.find(company => company.companyId === "3");
  const yinghe = request.companies.find(company => company.companyId === "35");
  let whoOpenLater = "未知";
  if (crown?.openTime && yinghe?.openTime) {
    const crownTime = normalizeOpenTime(crown.openTime);
    const yingheTime = normalizeOpenTime(yinghe.openTime);
    whoOpenLater = crownTime > yingheTime ? "盈禾先开" : yingheTime > crownTime ? "皇冠先开" : "同时开盘";
  }
  let home = 0;
  let away = 0;
  for (const indicator of indicators) {
    if (indicator.signal === "主降水") home += indicator.weight;
    if (indicator.signal === "客降水") away += indicator.weight;
  }
  const matched = matchPriorityRules(indicators).map(match => ({ id: match.rule.id, priority: match.rule.priority, description: match.rule.description, implication: match.rule.implication, hitRate: match.rule.hitRate, samples: match.rule.samples }));
  const order = ["P0", "P1", "P2", "P3", "RED"];
  const topPriority = matched.length ? matched.reduce((best, rule) => order.indexOf(rule.priority) < order.indexOf(best) ? rule.priority : best, "RED") : null;
  let confidence = llmPrediction.confidenceLevel;
  if (topPriority === "P0" || topPriority === "P1") confidence = "高";
  else if (topPriority === "RED") confidence = confidence === "高" ? "中" : confidence === "中" ? "低" : confidence;
  const analyzedAt = now.toISOString();
  const result: AnalysisResult = {
    matchId: request.matchId, homeTeam: request.homeTeam, awayTeam: request.awayTeam, league: request.league,
    matchTime: request.matchTime, analyzedAt, indicators, newsSummary, llmPrediction,
    priorityRules: { matched, topPriority }, crown_handicap: crown?.asianLineInit || "", yinghe_handicap: yinghe?.asianLineInit || "",
    who_open_later: whoOpenLater, strategy: llmPrediction.strategy, prediction: llmPrediction.prediction,
    water_direction: llmPrediction.waterDirection, accuracy: llmPrediction.accuracy, confidence_level: confidence,
    action: llmPrediction.action, total_prediction: llmPrediction.totalPrediction, total_trend: llmPrediction.totalTrend,
    total_action: llmPrediction.totalAction, probability,
  };
  const saved = await dependencies.analysisRepository.save({ request, analyzedAt, indicators, newsSummary, prediction: llmPrediction, confidenceLevel: confidence, probability, strategy: resolved.strategy, weights: resolved.weights, priorityRules: { matched, topPriority }, scores: { home, away }, whoOpenLater });
  result.verification = saved.verification;
  result.settlementEvidence = saved.settlementEvidence;
  if (request.source !== "backtest") {
    try { await dependencies.enqueueT30(request, saved.matchDate || request.matchDate || "", now); }
    catch (error) { dependencies.logger.error("[Analysis] T-30 task enqueue failed:", { matchId: request.matchId, matchDate: saved.matchDate || request.matchDate, error: error instanceof Error ? error.message : String(error) }); }
  }
  void dependencies.notify(result).catch(() => undefined);
  return result;
}
