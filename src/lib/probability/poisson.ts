import { aggregateMarket, aggregateOneXTwo } from "./aggregate";
import type { OutcomeProbabilities, PoissonModel, ProbabilityResult, ScoreDistribution, ThreeWayProbabilities } from "./types";

export interface FitPoissonInput {
  oneXTwo: ThreeWayProbabilities;
  totalLine: number;
  overProbability: number;
  maxGoals?: number;
  maxTailProbability?: number;
  calibratedVersion?: string;
}

function validProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function poissonMasses(lambda: number, maxGoals: number): number[] {
  const masses = [Math.exp(-lambda)];
  for (let goals = 1; goals <= maxGoals; goals += 1) masses.push(masses[goals - 1] * lambda / goals);
  return masses;
}

export function createScoreDistribution(
  lambdaHome: number,
  lambdaAway: number,
  maxGoals = 12,
): ProbabilityResult<ScoreDistribution> {
  if (![lambdaHome, lambdaAway].every(value => Number.isFinite(value) && value >= 0) || !Number.isInteger(maxGoals) || maxGoals < 0) {
    return { quality: "insufficient_data", value: null, reason: "Lambdas and score range are invalid" };
  }
  const home = poissonMasses(lambdaHome, maxGoals);
  const away = poissonMasses(lambdaAway, maxGoals);
  const rawCells: ScoreDistribution["cells"] = [];
  let matrixProbability = 0;
  for (let h = 0; h <= maxGoals; h += 1) {
    for (let a = 0; a <= maxGoals; a += 1) {
      const probability = home[h] * away[a];
      matrixProbability += probability;
      rawCells.push({ homeGoals: h, awayGoals: a, probability });
    }
  }
  if (!Number.isFinite(matrixProbability) || matrixProbability <= 0 || matrixProbability > 1 + 1e-12) {
    return { quality: "insufficient_data", value: null, reason: "Score matrix probability is invalid" };
  }
  const tailProbability = Math.max(0, 1 - matrixProbability);
  return {
    quality: "available",
    value: {
      maxGoals,
      matrixProbability,
      tailProbability,
      cells: rawCells.map(cell => ({ ...cell, probability: cell.probability / matrixProbability })),
    },
  };
}

function squaredError(model: ThreeWayProbabilities, target: ThreeWayProbabilities, modelOver: number, targetOver: number): number {
  return (model.home - target.home) ** 2
    + (model.draw - target.draw) ** 2
    + (model.away - target.away) ** 2
    + (modelOver - targetOver) ** 2;
}

export function fitPoissonModel(input: FitPoissonInput): ProbabilityResult<PoissonModel> {
  const targetSum = input.oneXTwo.home + input.oneXTwo.draw + input.oneXTwo.away;
  if (![input.oneXTwo.home, input.oneXTwo.draw, input.oneXTwo.away, input.overProbability].every(validProbability)
    || Math.abs(targetSum - 1) > 1e-6
    || !Number.isFinite(input.totalLine)) {
    return { quality: "insufficient_data", value: null, reason: "Market probabilities or total line are invalid" };
  }
  const maxGoals = input.maxGoals ?? 12;
  const maxTail = input.maxTailProbability ?? 1e-6;
  let best: { home: number; away: number; error: number; distribution: ScoreDistribution; total: OutcomeProbabilities } | null = null;

  // A bounded deterministic grid is intentionally used instead of a heavyweight optimizer.
  for (let home = 0.1; home <= 5.000001; home += 0.05) {
    for (let away = 0.1; away <= 5.000001; away += 0.05) {
      const generated = createScoreDistribution(Number(home.toFixed(2)), Number(away.toFixed(2)), maxGoals);
      if (!generated.value || generated.value.tailProbability > maxTail) continue;
      const oneXTwo = aggregateOneXTwo(generated.value);
      const total = aggregateMarket(generated.value, "total", input.totalLine, "over");
      const overEquivalent = total.win + total.half_win * 0.5 + total.push * 0.5;
      const error = squaredError(oneXTwo, input.oneXTwo, overEquivalent, input.overProbability);
      if (!best || error < best.error) best = { home, away, error, distribution: generated.value, total };
    }
  }

  if (!best) return { quality: "insufficient_data", value: null, reason: "No bounded Poisson fit satisfies the tail constraint" };
  const oneXTwo = aggregateOneXTwo(best.distribution);
  return {
    quality: input.calibratedVersion ? "available" : "uncalibrated",
    modelVersion: input.calibratedVersion ?? "market-poisson-v1",
    reason: input.calibratedVersion ? undefined : "Market-constrained Poisson v1 has not been calibrated",
    value: {
      lambdaHome: Number(best.home.toFixed(2)),
      lambdaAway: Number(best.away.toFixed(2)),
      fitError: best.error,
      distribution: best.distribution,
      oneXTwo,
      total: best.total,
    },
  };
}
