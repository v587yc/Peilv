import "server-only";
import { StrategyLabApplicationService, type StrategyLabApplicationDependencies } from "./application-service";

export const STRATEGY_LAB_DEPENDENCIES = ["repository", "snapshotProvider", "captureValidator", "leaguePolicy", "versionProvider", "runtimeRegistry", "currentBuildId", "settlementCalculator"] as const;
export type StrategyLabRequiredDependency = (typeof STRATEGY_LAB_DEPENDENCIES)[number];
export interface StrategyLabProductionDependencyState {
  readonly status: "ready" | "unavailable";
  readonly missing: readonly StrategyLabRequiredDependency[];
}

export function inspectStrategyLabProductionDependencies(
  dependencies: Partial<StrategyLabApplicationDependencies>,
): StrategyLabProductionDependencyState {
  const missing = STRATEGY_LAB_DEPENDENCIES.filter(name => !dependencies[name]);
  return Object.freeze({ status: missing.length === 0 ? "ready" : "unavailable", missing });
}

/**
 * Explicit server-only composition boundary. It does not create a non-transactional
 * repository or read credentials. Callers must supply every transactional and
 * policy dependency; otherwise production remains unavailable (503 at routes).
 */
export function buildStrategyLabProductionService(
  dependencies: Partial<StrategyLabApplicationDependencies>,
): StrategyLabApplicationService | null {
  if (inspectStrategyLabProductionDependencies(dependencies).status !== "ready") return null;
  return new StrategyLabApplicationService(dependencies as StrategyLabApplicationDependencies);
}
