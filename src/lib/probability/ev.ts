import { aggregateMarket } from "./aggregate";
import type { EvRecommendation, MarketCandidate, OutcomeProbabilities, ProbabilityQuality, ScoreDistribution } from "./types";

export function decimalToNetOdds(decimalOdds: number): number | null {
  return Number.isFinite(decimalOdds) && decimalOdds > 1 ? decimalOdds - 1 : null;
}

export function expectedValue(probabilities: OutcomeProbabilities, netOdds: number): number | null {
  if (!Number.isFinite(netOdds) || netOdds < 0) return null;
  return probabilities.win * netOdds
    + probabilities.half_win * netOdds * 0.5
    - probabilities.half_loss * 0.5
    - probabilities.loss;
}

export function recommendCandidate(
  distribution: ScoreDistribution | null,
  quality: ProbabilityQuality,
  candidates: readonly MarketCandidate[],
): EvRecommendation {
  if (!distribution || (quality !== "available" && quality !== "uncalibrated")) {
    return { quality, recommended: null, evaluated: [], reason: "Probabilities are unavailable" };
  }
  if (candidates.length === 0) {
    return { quality, recommended: null, evaluated: [], reason: "No real market candidates supplied" };
  }
  if (candidates.some(candidate => !Number.isFinite(candidate.netOdds) || candidate.netOdds < 0 || !Number.isFinite(candidate.line))) {
    return { quality: "invalid_odds", recommended: null, evaluated: [], reason: "Candidate odds and lines must be finite; net odds cannot be negative" };
  }

  const provisional = quality === "uncalibrated";
  const evaluated = candidates.map(candidate => {
    const selection = candidate.market === "handicap"
      ? candidate.selection === "home" ? "home" : "away"
      : candidate.selection === "over" ? "over" : "under";
    const probabilities = aggregateMarket(distribution, candidate.market, candidate.line, selection);
    return {
      ...candidate,
      probabilities,
      expectedValue: expectedValue(probabilities, candidate.netOdds)!,
      provisional,
    };
  });
  const best = evaluated.reduce((current, item) => item.expectedValue > current.expectedValue ? item : current);
  const recommended = best.expectedValue > 0 ? best : null;
  return {
    quality,
    recommended,
    evaluated,
    reason: recommended ? undefined : "No supplied candidate has positive expected value",
  };
}
