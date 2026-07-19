import type { AnalysisProbabilityOutput } from "@/lib/probability";
import type { MarketVerification } from "@/lib/verification/market-service";
import type { SettlementSummary } from "@/lib/verification";

export interface MatchData {
  id: string;
  league: string;
  leagueColor: string;
  time: string;
  homeTeam: string;
  awayTeam: string;
  homeRank: string;
  awayRank: string;
  state: string;
  handicap: string;
  handicapRaw: number;
  homeOdds: string;
  awayOdds: string;
  totalLine: string;
  totalLineRaw: number;
  overOdds: string;
  underOdds: string;
  initialHandicap: string;
  initialTotalLine: string;
  sclassId: string;
  matchDate: string;
  orderIndex: number;
  isHot?: boolean;
  homeScore?: string;
  awayScore?: string;
  halfHomeScore?: string;
  halfAwayScore?: string;
}

export interface LeagueData {
  id: string;
  name: string;
  color: string;
  count: number;
  isHot?: boolean;
}

export interface MatchNotes {
  handicapNote: string;
  totalNote: string;
  handicapAmount?: string;
  totalAmount?: string;
  handicapSettled?: boolean;
  totalSettled?: boolean;
}

export type PinnedMatchInfo = Pick<MatchData,
  "id" | "league" | "leagueColor" | "time" | "homeTeam" | "awayTeam" |
  "handicap" | "homeOdds" | "awayOdds" | "totalLine" | "overOdds" | "underOdds"
>;

export interface ReportRowData {
  matchId: string;
  league: string;
  time: string;
  homeTeam: string;
  awayTeam: string;
  state: string;
  homeScore: string;
  awayScore: string;
  crownHandicap?: string;
  initHandicap: string;
  liveHandicap: string;
  handicapChange: string;
  isReceiving: boolean;
  result?: "+" | "-" | null;
  handicapResult?: "+" | "-" | null;
  waterDirection: string;
  actualWaterDirection: string;
  waterResult?: "+" | "-" | null;
  prediction: string;
  action: string;
  accuracy: string;
  confidence_level: string;
  confidenceLevel?: string;
  initTotal: string;
  liveTotal: string;
  totalChange: string;
  totalResult?: "+" | "-" | null;
  totalPrediction: string;
  totalAction: string;
  verified: boolean;
  manualIsCorrect?: boolean | null;
  verification?: {
    handicap: MarketVerification;
    total: MarketVerification;
  };
  handicapOutcome?: string;
  totalOutcome?: string;
  waterTolerance?: boolean;
}

export interface ReportData {
  date: string;
  mode?: string;
  latestAnalysisAt?: string | null;
  rows: ReportRowData[];
  summary: {
    total: number;
    correct: number;
    wrong: number;
    accuracy: string;
    totalTotal?: number;
    totalCorrect?: number;
    totalWrong?: number;
    totalAccuracy?: string;
    markets?: { handicap: SettlementSummary; total: SettlementSummary };
    highConf?: { total: number; correct: number; accuracy: string };
    midConf?: { total: number; correct: number; accuracy: string };
    lowConf?: { total: number; correct: number; accuracy: string };
    unverified?: number;
  };
}

export interface CompanyOddsData {
  matchId: string;
  openTime: string;
  companies: CompanyOddsItem[];
}

export interface CrownStoredOdds {
  handicapHome?: string | null;
  handicapLine?: string | null;
  handicapAway?: string | null;
  totalOver?: string | null;
  totalLine?: string | null;
  totalUnder?: string | null;
  euroHome?: string | null;
  euroDraw?: string | null;
  euroAway?: string | null;
  handicapObservedAt?: string | null;
  totalObservedAt?: string | null;
  euroObservedAt?: string | null;
  source?: "3in1" | "legacy-fallback" | string;
}

export interface DataMatchRow {
  match: MatchData;
  isFetched: boolean;
  isFetching: boolean;
  openTime: string;
  companies: CompanyOddsItem[];
  crownFinal: CrownStoredOdds | undefined;
  crown12: CrownStoredOdds | undefined;
}

export interface CompanyOddsItem {
  companyId: string;
  companyName: string;
  openTime: string;
  ftHandicapHome: string;
  ftHandicapLine: string;
  ftHandicapAway: string;
  ftHandicapHomeLive: string;
  ftHandicapLineLive: string;
  ftHandicapAwayLive: string;
  euroHome: string;
  euroDraw: string;
  euroAway: string;
  euroHomeLive: string;
  euroDrawLive: string;
  euroAwayLive: string;
  euroAsianHome: string;
  euroAsianLine: string;
  euroAsianAway: string;
  ftTotalOver: string;
  ftTotalLine: string;
  ftTotalUnder: string;
  ftTotalOverLive: string;
  ftTotalLineLive: string;
  ftTotalUnderLive: string;
  htHandicapHome?: string;
  htHandicapLine?: string;
  htHandicapAway?: string;
  htTotalOver?: string;
  htTotalLine?: string;
  htTotalUnder?: string;
}

export interface LatestOddsDisplay {
  handicapHome: string;
  handicapLine: string;
  handicapAway: string;
  totalOver: string;
  totalLine: string;
  totalUnder: string;
  source: string;
  isCrownLatest: boolean;
  handicapObservedAt?: string;
  totalObservedAt?: string;
}

export interface AnalysisResultData {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchTime: string;
  matchDate?: string;
  analyzedAt?: string | null;
  indicators: Array<{
    name: string;
    value: string;
    signal: string;
    weight: number;
    reasoning: string;
  }>;
  newsSummary: string;
  handicapTrend: string;
  waterDirection: string;
  prediction: string;
  totalTrend: string;
  totalPrediction: string;
  totalAction: string;
  confidenceLevel: string;
  accuracy: string;
  strategy: string;
  action: string;
  reasoning: string;
  isCorrect?: boolean | null;
  manualIsCorrect?: boolean | null;
  verification?: {
    handicap: MarketVerification;
    total: MarketVerification;
  };
  probability?: AnalysisProbabilityOutput | null;
  settlementEvidence?: Record<string, unknown>;
  crown_handicap: string;
  yinghe_handicap: string;
  who_open_later: string;
}

export interface PredictionData {
  match_time: string;
  league: string;
  home: string;
  away: string;
  crown_handicap: string;
  yinghe_handicap: string;
  who_open_later: string;
  strategy: string;
  prediction: string;
  accuracy: string;
  confidence_level: string;
  action: string;
}

export interface PredictionComparison {
  oddsDiff: number | null;
  handicapChange: "升" | "降" | null;
  predictedSide: "home" | "away";
  action: string;
}

export interface ParsedCrownHandicap {
  homeOdds: number;
  awayOdds: number;
  handicapValue: number;
}

export interface OddsComparison {
  predictedOdds: number;
  currentOdds: number;
  sumTotal: number;
  diff: number;
}

export interface AutomationTaskStepStatusData {
  stepKey: string;
  status: "pending" | "running" | "retrying" | "completed" | "failed";
  lastError: string | null;
}

export interface AutomationTaskStatusData {
  id: string;
  taskType: "odds-fetch" | "crown-snapshot" | "analysis" | "verify-learn-report";
  status: "pending" | "running" | "retrying" | "completed" | "failed";
  currentStep: string | null;
  lastError: string | null;
  updatedAt: string;
  steps?: AutomationTaskStepStatusData[];
}
