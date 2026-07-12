export type ProbabilityQuality =
  | "available"
  | "unavailable"
  | "insufficient_data"
  | "uncalibrated"
  | "invalid_odds";

export type ScoredOutcome = "win" | "half_win" | "push" | "half_loss" | "loss";

export interface OutcomeProbabilities {
  win: number;
  half_win: number;
  push: number;
  half_loss: number;
  loss: number;
}

export interface ScoreCell {
  homeGoals: number;
  awayGoals: number;
  probability: number;
}

export interface ScoreDistribution {
  maxGoals: number;
  cells: ScoreCell[];
  matrixProbability: number;
  tailProbability: number;
}

export interface ThreeWayProbabilities {
  home: number;
  draw: number;
  away: number;
}

export interface BinaryProbabilities {
  first: number;
  second: number;
}

export interface ProbabilityResult<T> {
  quality: ProbabilityQuality;
  value: T | null;
  reason?: string;
  modelVersion?: string;
}

export type CandidateMarket = "handicap" | "total";
export type HandicapSelection = "home" | "away";
export type TotalSelection = "over" | "under";

export interface MarketCandidate {
  id: string;
  market: CandidateMarket;
  line: number;
  selection: HandicapSelection | TotalSelection;
  /** Hong Kong odds: net profit per unit stake on a full win. */
  netOdds: number;
  source?: string;
}

export interface EvaluatedCandidate extends MarketCandidate {
  probabilities: OutcomeProbabilities;
  expectedValue: number;
  provisional: boolean;
}

export interface EvRecommendation {
  quality: ProbabilityQuality;
  recommended: EvaluatedCandidate | null;
  evaluated: EvaluatedCandidate[];
  reason?: string;
}

export interface PoissonModel {
  lambdaHome: number;
  lambdaAway: number;
  fitError: number;
  distribution: ScoreDistribution;
  oneXTwo: ThreeWayProbabilities;
  total: OutcomeProbabilities;
}
