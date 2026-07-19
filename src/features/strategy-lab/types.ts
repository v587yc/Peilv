export type StrategyCheckpoint = "T1215" | "T30" | "T03";
export type StrategyId = "A" | "B" | "C" | "D";
export type StrategyDecisionStatus =
  | "recommend"
  | "observe"
  | "reanalyze_required"
  | "insufficient_data";
export type StrategySide = "home" | "away";

export type DecimalInput = string | number | null | undefined;

export interface RawStrategyNodeInput {
  readonly homeWater: DecimalInput;
  readonly awayWater: DecimalInput;
  readonly handicap: string | null | undefined;
}

export interface PreviousEffectiveInput {
  readonly handicap: string | null | undefined;
}

export interface StrategyEvaluationInput {
  readonly checkpoint: StrategyCheckpoint;
  readonly current: RawStrategyNodeInput;
  /** The last valid checkpoint. Omit it when no earlier effective checkpoint exists. */
  readonly previousEffective?: PreviousEffectiveInput | null;
}

export interface NormalizedWater {
  readonly raw: string;
  /** 1 basis point is 0.0001. */
  readonly basisPoints: number;
}

export interface NormalizedHandicap {
  readonly raw: string;
  readonly goals: number;
  /** Signed integer quarter-goal units; 0.25 goal is one unit. */
  readonly quarterUnits: number;
}

export interface NormalizedStrategyNode {
  readonly homeWater: NormalizedWater;
  readonly awayWater: NormalizedWater;
  readonly handicap: NormalizedHandicap;
}

export interface NormalizedPreviousEffective {
  readonly handicap: NormalizedHandicap;
}

export interface StrategyDecisionCore {
  readonly status: StrategyDecisionStatus;
  readonly side: StrategySide | null;
  readonly reasonCode: string;
  readonly branchId: string;
  readonly lockedByDeterministicRule: boolean;
}

export interface StrategyEvaluationMeta {
  readonly checkpoint: StrategyCheckpoint;
  readonly requestedStrategy: StrategyId;
  readonly executedStrategy: StrategyId;
  readonly normalizedCurrent: NormalizedStrategyNode | null;
  readonly normalizedPreviousEffective: NormalizedPreviousEffective | null;
  readonly waterDiffBasisPoints: number | null;
  readonly missingFields: readonly string[];
  readonly invalidFields: readonly string[];
}

export interface StrategyEvaluationResult {
  readonly decision: Readonly<StrategyDecisionCore>;
  readonly meta: Readonly<StrategyEvaluationMeta>;
}

export const STRATEGY_C_REQUIRED_FIELDS = [
  "marketConsensus",
  "liquidityProfile",
  "teamContext",
] as const;

export type StrategyCRequiredField = typeof STRATEGY_C_REQUIRED_FIELDS[number];

export interface StrategyCReadinessData {
  readonly marketConsensus?: string | null;
  readonly liquidityProfile?: string | null;
  readonly teamContext?: string | null;
}

export interface StrategyCInput extends StrategyEvaluationInput {
  readonly cData: StrategyCReadinessData;
}

export interface StrategyCFallbackMeta {
  readonly requested: "C";
  readonly executed: "A" | "C";
  readonly availability: "fallback" | "available" | "unavailable";
  readonly fallbackReason: "missing_critical_data" | null;
  readonly missingFields: readonly StrategyCRequiredField[];
}

export interface StrategyCResult extends StrategyEvaluationResult {
  readonly cMeta: Readonly<StrategyCFallbackMeta>;
}

export type StrategyCExecutor = (
  input: Readonly<StrategyCInput>,
) => StrategyEvaluationResult;

export interface StrategyDVersion1Input {
  readonly checkpoint: StrategyCheckpoint;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface StrategyDVersion1Adapter {
  readonly strategy: "D";
  readonly version: "D-v1";
  evaluate(input: Readonly<StrategyDVersion1Input>): StrategyEvaluationResult;
}
