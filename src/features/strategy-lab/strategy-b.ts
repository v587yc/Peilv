import { deepFreeze, hasHandicapChanged, normalizePreviousEffective, normalizeStrategyNode } from "./normalization";
import type { NormalizedStrategyNode, StrategyEvaluationInput, StrategyEvaluationResult, StrategySide } from "./types";

const OBSERVE_DIFF_BPS = 400;

function lowWaterSide(current: NormalizedStrategyNode): StrategySide {
  return current.homeWater.basisPoints < current.awayWater.basisPoints ? "home" : "away";
}

export function evaluateStrategyB(input: StrategyEvaluationInput): StrategyEvaluationResult {
  const currentResult = normalizeStrategyNode(input.current, "current");
  const requiresPrevious = input.checkpoint !== "T1215";
  const previousResult = requiresPrevious ? normalizePreviousEffective(input.previousEffective) : null;
  const missingFields = [...currentResult.missingFields, ...(previousResult?.missingFields ?? [])];
  const invalidFields = [...currentResult.invalidFields, ...(previousResult?.invalidFields ?? [])];
  const current = currentResult.normalized;
  const previous = previousResult?.normalized ?? null;
  let waterDiffBasisPoints: number | null = null;

  const decision = !current
    ? {
        status: "insufficient_data" as const,
        side: null,
        reasonCode: invalidFields.length > 0 ? "B_INVALID_REQUIRED_DATA" : "B_MISSING_REQUIRED_DATA",
        branchId: "B-INSUFFICIENT-DATA",
        lockedByDeterministicRule: true,
      }
    : requiresPrevious && !previous
      ? {
          status: "insufficient_data" as const,
          side: null,
          reasonCode: "B_PREVIOUS_CHECKPOINT_UNAVAILABLE",
          branchId: "B-INSUFFICIENT-PREVIOUS-CHECKPOINT",
          lockedByDeterministicRule: true,
        }
      : hasHandicapChanged(current, previous)
      ? {
          status: "reanalyze_required" as const,
          side: null,
          reasonCode: "B_HANDICAP_CHANGED",
          branchId: "B-REANALYZE-HANDICAP-CHANGE",
          lockedByDeterministicRule: true,
        }
      : (() => {
          waterDiffBasisPoints = Math.abs(
            current.homeWater.basisPoints - current.awayWater.basisPoints,
          );
          return waterDiffBasisPoints < OBSERVE_DIFF_BPS
            ? {
                status: "observe" as const,
                side: null,
                reasonCode: "B_DIFF_BELOW_004",
                branchId: "B-OBSERVE-DIFF-LT-004",
                lockedByDeterministicRule: true,
              }
            : {
                status: "recommend" as const,
                side: lowWaterSide(current),
                reasonCode: "B_DIFF_AT_LEAST_004_SELECT_LOW",
                branchId: "B-RECOMMEND-LOW-WATER",
                lockedByDeterministicRule: true,
              };
        })();

  return deepFreeze({
    decision,
    meta: {
      checkpoint: input.checkpoint,
      requestedStrategy: "B",
      executedStrategy: "B",
      normalizedCurrent: current,
      normalizedPreviousEffective: previous,
      waterDiffBasisPoints,
      missingFields,
      invalidFields,
    },
  }) as StrategyEvaluationResult;
}
