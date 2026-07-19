import { deepFreeze, snapshotStrategyResult } from "./normalization";
import type { StrategyDVersion1Adapter } from "./types";

/**
 * Compatibility-only boundary for the existing D-v1 strategy.
 * This module intentionally provides no default implementation and performs no persistence.
 */
export function defineStrategyDVersion1Adapter(
  adapter: StrategyDVersion1Adapter,
): StrategyDVersion1Adapter {
  if (adapter.strategy !== "D" || adapter.version !== "D-v1") {
    throw new Error("Invalid D-v1 strategy adapter");
  }
  if (typeof adapter.evaluate !== "function") {
    throw new Error("Invalid D-v1 strategy adapter");
  }
  const registrationSnapshot = {
    strategy: "D" as const,
    version: "D-v1" as const,
    evaluate: adapter.evaluate,
  };
  const evaluate = registrationSnapshot.evaluate.bind(registrationSnapshot);
  const snapshot: StrategyDVersion1Adapter = {
    strategy: "D",
    version: "D-v1",
    evaluate(input) {
      return snapshotStrategyResult(evaluate(input), "D", input.checkpoint);
    },
  };
  return deepFreeze(snapshot) as StrategyDVersion1Adapter;
}
