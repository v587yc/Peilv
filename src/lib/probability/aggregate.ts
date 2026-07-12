import { settlePrediction } from "@/lib/verification";
import type { OutcomeProbabilities, ScoreDistribution, ScoredOutcome, ThreeWayProbabilities } from "./types";

const OUTCOMES: ScoredOutcome[] = ["win", "half_win", "push", "half_loss", "loss"];

export function emptyOutcomeProbabilities(): OutcomeProbabilities {
  return { win: 0, half_win: 0, push: 0, half_loss: 0, loss: 0 };
}

export function aggregateOneXTwo(distribution: ScoreDistribution): ThreeWayProbabilities {
  const result = { home: 0, draw: 0, away: 0 };
  for (const cell of distribution.cells) {
    if (cell.homeGoals > cell.awayGoals) result.home += cell.probability;
    else if (cell.homeGoals === cell.awayGoals) result.draw += cell.probability;
    else result.away += cell.probability;
  }
  return result;
}

export function aggregateMarket(
  distribution: ScoreDistribution,
  market: "handicap" | "total",
  line: number,
  selection: "home" | "away" | "over" | "under",
): OutcomeProbabilities {
  const result = emptyOutcomeProbabilities();
  const prediction = market === "handicap"
    ? selection === "home" ? "主" : "客"
    : selection === "over" ? "大" : "小";
  for (const cell of distribution.cells) {
    const outcome = settlePrediction({
      market,
      prediction,
      line,
      homeScore: cell.homeGoals,
      awayScore: cell.awayGoals,
    });
    if (OUTCOMES.includes(outcome as ScoredOutcome)) {
      result[outcome as ScoredOutcome] += cell.probability;
    } else {
      throw new Error(`Unexpected settlement outcome: ${outcome}`);
    }
  }
  return result;
}

export function probabilitySum(probabilities: OutcomeProbabilities): number {
  return OUTCOMES.reduce((sum, outcome) => sum + probabilities[outcome], 0);
}
