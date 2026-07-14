import type { IndicatorWeights } from "@/lib/analysis/strategy";
import type { AnalysisProbabilityOutput } from "@/lib/probability";
import type { serializeVerification } from "@/lib/verification/market-service";

export interface AnalysisRequest {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchTime: string;
  matchDate?: string;
  source?: "production" | "backtest";
  runId?: string;
  scheduleMode: string;
  analysisTrigger?: "match-t30";
  sourceObservedAt?: string | null;
  companies: CompanyOddsForAnalysis[];
  crown12Handicap?: { home: string; line: string; away: string };
  crown12Total?: { over: string; line: string; under: string };
  crownLiveHandicap?: { home: string; line: string; away: string };
  crownLiveTotal?: { over: string; line: string; under: string };
}

export interface CompanyOddsForAnalysis {
  companyId: string;
  companyName: string;
  openTime: string;
  asianHomeInit: string;
  asianLineInit: string;
  asianAwayInit: string;
  euroAsianHomeInit: string;
  euroAsianLineInit: string;
  euroAsianAwayInit: string;
  totalOverInit: string;
  totalLineInit: string;
  totalUnderInit: string;
  asianHomeLive: string;
  asianLineLive: string;
  asianAwayLive: string;
  euroHomeInit?: string;
  euroDrawInit?: string;
  euroAwayInit?: string;
}

export type WaterSignal = "主降水" | "客降水" | "中立" | "不确定";

export interface RuleIndicator {
  name: string;
  value: string;
  signal: WaterSignal;
  weight: number;
  reasoning: string;
}

export type IndicatorKey =
  | "handicap"
  | "water"
  | "divergence"
  | "euroAsian"
  | "openTime"
  | "totalGoals";

export interface PriorityRule {
  id: string;
  priority: "P0" | "P1" | "P2" | "P3" | "RED";
  description: string;
  conditions: Partial<Record<IndicatorKey, WaterSignal>>;
  implication: string;
  hitRate: number;
  samples: number;
}

export interface RuleMatch {
  rule: PriorityRule;
  matched: boolean;
}

export interface AnalysisResultData {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchTime: string;
  matchDate?: string;
  analyzedAt?: string | null;
  indicators: Array<{ name: string; value: string; signal: string; weight: number; reasoning: string }>;
  newsSummary: string;
  waterDirection: string;
  handicapTrend: string;
  prediction: string;
  totalTrend: string;
  totalPrediction: string;
  totalAction: string;
  confidenceLevel: string;
  accuracy: string;
  strategy: string;
  action: string;
  reasoning: string;
  crown_handicap: string;
  yinghe_handicap: string;
  who_open_later: string;
  isCorrect?: boolean | null;
  manualIsCorrect?: boolean | null;
  verification?: ReturnType<typeof serializeVerification>;
  settlementEvidence?: Record<string, unknown>;
  probability?: AnalysisProbabilityOutput | null;
}

export type AnalysisPredictionMap = Record<string, AnalysisResultData>;

export type { IndicatorWeights };
