import { deepFreeze, snapshotStrategyResult } from "./normalization";
import { evaluateStrategyA } from "./strategy-a";
import {
  STRATEGY_C_REQUIRED_FIELDS,
  type StrategyCExecutor,
  type StrategyCInput,
  type StrategyCRequiredField,
  type StrategyCResult,
} from "./types";

export function getMissingStrategyCFields(input: StrategyCInput): readonly StrategyCRequiredField[] {
  return STRATEGY_C_REQUIRED_FIELDS.filter(field => {
    const value = input.cData[field];
    return typeof value !== "string" || value.trim() === "";
  });
}

export function evaluateStrategyC(
  input: StrategyCInput,
  executor?: StrategyCExecutor,
): StrategyCResult {
  const missingFields = getMissingStrategyCFields(input);
  if (missingFields.length > 0) {
    const fallback = evaluateStrategyA(input);
    return deepFreeze({
      decision: fallback.decision,
      meta: {
        ...fallback.meta,
        requestedStrategy: "C" as const,
        executedStrategy: "A" as const,
      },
      cMeta: {
        requested: "C" as const,
        executed: "A" as const,
        availability: "fallback" as const,
        fallbackReason: "missing_critical_data" as const,
        missingFields,
      },
    }) as StrategyCResult;
  }

  if (!executor) {
    return deepFreeze({
      decision: {
        status: "insufficient_data" as const,
        side: null,
        reasonCode: "C_EXECUTOR_UNAVAILABLE",
        branchId: "C-UNAVAILABLE-NOT-IMPLEMENTED",
        lockedByDeterministicRule: false,
      },
      meta: {
        checkpoint: input.checkpoint,
        requestedStrategy: "C" as const,
        executedStrategy: "C" as const,
        normalizedCurrent: null,
        normalizedPreviousEffective: null,
        waterDiffBasisPoints: null,
        missingFields: [],
        invalidFields: [],
      },
      cMeta: {
        requested: "C" as const,
        executed: "C" as const,
        availability: "unavailable" as const,
        fallbackReason: null,
        missingFields: [],
      },
    }) as StrategyCResult;
  }

  const cSnapshot = snapshotStrategyResult(executor(input), "C", input.checkpoint);
  return deepFreeze({
    ...cSnapshot,
    cMeta: {
      requested: "C" as const,
      executed: "C" as const,
      availability: "available" as const,
      fallbackReason: null,
      missingFields: [],
    },
  }) as StrategyCResult;
}
