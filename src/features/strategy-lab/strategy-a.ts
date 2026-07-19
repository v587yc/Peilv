import { deepFreeze, hasHandicapChanged, normalizePreviousEffective, normalizeStrategyNode } from "./normalization";
import type {
  NormalizedStrategyNode,
  StrategyDecisionCore,
  StrategyEvaluationInput,
  StrategyEvaluationResult,
  StrategySide,
} from "./types";

const OBSERVE_DIFF_BPS = 400;
const MID_RANGE_MAX_DIFF_BPS = 2_000;
const EVEN_WATER_BPS = 10_000;

function sideByWater(
  current: NormalizedStrategyNode,
  preference: "low" | "high",
): StrategySide {
  const homeIsLower = current.homeWater.basisPoints < current.awayWater.basisPoints;
  if (preference === "low") return homeIsLower ? "home" : "away";
  return homeIsLower ? "away" : "home";
}

function decision(
  status: StrategyDecisionCore["status"],
  side: StrategySide | null,
  reasonCode: string,
  branchId: string,
): StrategyDecisionCore {
  return {
    status,
    side,
    reasonCode,
    branchId,
    lockedByDeterministicRule: true,
  };
}

export function evaluateStrategyA(input: StrategyEvaluationInput): StrategyEvaluationResult {
  const currentResult = normalizeStrategyNode(input.current, "current");
  const requiresPrevious = input.checkpoint !== "T1215";
  const previousResult = requiresPrevious ? normalizePreviousEffective(input.previousEffective) : null;
  const missingFields = [
    ...currentResult.missingFields,
    ...(previousResult?.missingFields ?? []),
  ];
  const invalidFields = [
    ...currentResult.invalidFields,
    ...(previousResult?.invalidFields ?? []),
  ];
  const current = currentResult.normalized;
  const previous = previousResult?.normalized ?? null;

  let core: StrategyDecisionCore;
  let waterDiffBasisPoints: number | null = null;
  if (!current) {
    core = decision(
      "insufficient_data",
      null,
      invalidFields.length > 0 ? "A_INVALID_REQUIRED_DATA" : "A_MISSING_REQUIRED_DATA",
      "A-INSUFFICIENT-DATA",
    );
  } else if (requiresPrevious && !previous) {
    core = decision(
      "insufficient_data",
      null,
      "A_PREVIOUS_CHECKPOINT_UNAVAILABLE",
      "A-INSUFFICIENT-PREVIOUS-CHECKPOINT",
    );
  } else if (hasHandicapChanged(current, previous)) {
    core = decision(
      "reanalyze_required",
      null,
      "A_HANDICAP_CHANGED",
      "A-REANALYZE-HANDICAP-CHANGE",
    );
  } else {
    waterDiffBasisPoints = Math.abs(
      current.homeWater.basisPoints - current.awayWater.basisPoints,
    );
    const highWater = Math.max(current.homeWater.basisPoints, current.awayWater.basisPoints);
    if (waterDiffBasisPoints < OBSERVE_DIFF_BPS) {
      core = decision("observe", null, "A_DIFF_BELOW_004", "A-OBSERVE-DIFF-LT-004");
    } else if (waterDiffBasisPoints <= MID_RANGE_MAX_DIFF_BPS && highWater <= EVEN_WATER_BPS) {
      core = decision(
        "recommend",
        sideByWater(current, "low"),
        "A_MID_DIFF_HIGH_WATER_AT_MOST_1_SELECT_LOW",
        "A-RECOMMEND-MID-LOW-WATER",
      );
    } else {
      core = decision(
        "recommend",
        sideByWater(current, "high"),
        waterDiffBasisPoints > MID_RANGE_MAX_DIFF_BPS
          ? "A_DIFF_ABOVE_020_SELECT_HIGH"
          : "A_MID_DIFF_HIGH_WATER_ABOVE_1_SELECT_HIGH",
        waterDiffBasisPoints > MID_RANGE_MAX_DIFF_BPS
          ? "A-RECOMMEND-LARGE-DIFF-HIGH-WATER"
          : "A-RECOMMEND-MID-HIGH-WATER",
      );
    }
  }

  return deepFreeze({
    decision: core,
    meta: {
      checkpoint: input.checkpoint,
      requestedStrategy: "A",
      executedStrategy: "A",
      normalizedCurrent: current,
      normalizedPreviousEffective: previous,
      waterDiffBasisPoints,
      missingFields,
      invalidFields,
    },
  }) as StrategyEvaluationResult;
}
