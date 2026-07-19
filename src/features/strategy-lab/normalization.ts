import { stableCanonicalJson } from "@/lib/canonical-json";
import type {
  DecimalInput,
  NormalizedHandicap,
  NormalizedStrategyNode,
  NormalizedPreviousEffective,
  NormalizedWater,
  PreviousEffectiveInput,
  RawStrategyNodeInput,
  StrategyDecisionStatus,
  StrategyEvaluationResult,
  StrategyId,
  StrategySide,
} from "./types";

const DECIMAL_PATTERN = /^(?:\d+)(?:\.(\d{1,4}))?$/;
const HANDICAP_NUMBER_PATTERN = /^(?:\d+)(?:\.\d+)?$/;
const MAX_WATER_BASIS_POINTS = 50_000;
const MAX_HANDICAP_GOALS = 20;
const HANDICAP_TOKEN_VALUES: Readonly<Record<string, number>> = Object.freeze({
  "平手": 0, "平": 0,
  "半球": 0.5, "半": 0.5,
  "一球": 1, "一": 1,
  "球半": 1.5, "一球半": 1.5,
  "两球": 2, "两": 2,
  "两球半": 2.5,
  "三球": 3, "三": 3,
  "三球半": 3.5,
  "四球": 4, "四": 4,
  "四球半": 4.5,
  "五球": 5, "五": 5,
  "五球半": 5.5,
});

export const STRATEGY_WATER_MAX_BASIS_POINTS = MAX_WATER_BASIS_POINTS;
export const STRATEGY_HANDICAP_MAX_GOALS = MAX_HANDICAP_GOALS;

function rawDecimal(value: DecimalInput): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseWaterToBasisPoints(value: DecimalInput): NormalizedWater | null {
  const raw = rawDecimal(value);
  if (raw === null) return null;
  const match = DECIMAL_PATTERN.exec(raw);
  if (!match) return null;
  const [wholePart, fractionPart = ""] = raw.split(".");
  const basisPoints = Number(wholePart) * 10_000
    + Number(fractionPart.padEnd(4, "0"));
  if (!Number.isSafeInteger(basisPoints) || basisPoints > MAX_WATER_BASIS_POINTS) return null;
  return Object.freeze({ raw, basisPoints });
}

function parseHandicapTokenToQuarterUnits(token: string): number | null {
  const mapped = HANDICAP_TOKEN_VALUES[token];
  const numeric = mapped !== undefined
    ? mapped
    : HANDICAP_NUMBER_PATTERN.test(token)
      ? Number(token)
      : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_HANDICAP_GOALS) return null;
  const quarterUnits = Math.round(numeric * 4);
  return Math.abs(numeric * 4 - quarterUnits) <= 1e-7 ? quarterUnits : null;
}

export function normalizeHandicap(value: string | null | undefined): NormalizedHandicap | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const raw = value.trim();
  const withoutStar = raw.startsWith("*") ? raw.slice(1) : raw;
  if (withoutStar === "" || withoutStar.startsWith("*")) return null;
  const isReceiving = withoutStar.startsWith("受让") || withoutStar.startsWith("受");
  const unsigned = withoutStar.replace(/^受让?/, "");
  if (unsigned === "") return null;
  const parts = unsigned.split("/");
  if (parts.length > 2 || parts.some(part => part === "")) return null;
  const tokenQuarterUnits = parts.map(parseHandicapTokenToQuarterUnits);
  if (tokenQuarterUnits.some(part => part === null)) return null;
  const unsignedQuarterUnits = tokenQuarterUnits.length === 2
    ? (() => {
        const first = tokenQuarterUnits[0] as number;
        const second = tokenQuarterUnits[1] as number;
        // Asian split lines must increase by exactly half a goal in absolute strength.
        return second - first === 2 ? (first + second) / 2 : null;
      })()
    : tokenQuarterUnits[0] as number;
  if (unsignedQuarterUnits === null || !Number.isSafeInteger(unsignedQuarterUnits)) return null;
  const quarterUnits = isReceiving ? -unsignedQuarterUnits : unsignedQuarterUnits;
  return Object.freeze({ raw, goals: quarterUnits / 4, quarterUnits });
}

export interface PreviousNormalizationResult {
  readonly normalized: NormalizedPreviousEffective | null;
  readonly missingFields: readonly string[];
  readonly invalidFields: readonly string[];
}

export function normalizePreviousEffective(
  input: PreviousEffectiveInput | null | undefined,
): PreviousNormalizationResult {
  if (!input || input.handicap === null || input.handicap === undefined || input.handicap.trim() === "") {
    return Object.freeze({
      normalized: null,
      missingFields: Object.freeze(["previousEffective.handicap"]),
      invalidFields: Object.freeze([]),
    });
  }
  const handicap = normalizeHandicap(input.handicap);
  if (!handicap) {
    return Object.freeze({
      normalized: null,
      missingFields: Object.freeze([]),
      invalidFields: Object.freeze(["previousEffective.handicap"]),
    });
  }
  return Object.freeze({
    normalized: Object.freeze({ handicap }),
    missingFields: Object.freeze([]),
    invalidFields: Object.freeze([]),
  });
}

export interface NodeNormalizationResult {
  readonly normalized: NormalizedStrategyNode | null;
  readonly missingFields: readonly string[];
  readonly invalidFields: readonly string[];
}

export function normalizeStrategyNode(
  input: RawStrategyNodeInput,
  prefix = "current",
): NodeNormalizationResult {
  const missingFields: string[] = [];
  const invalidFields: string[] = [];

  const normalizeWaterField = (field: "homeWater" | "awayWater") => {
    const value = input[field];
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
      missingFields.push(`${prefix}.${field}`);
      return null;
    }
    const normalized = parseWaterToBasisPoints(value);
    if (!normalized) invalidFields.push(`${prefix}.${field}`);
    return normalized;
  };

  const homeWater = normalizeWaterField("homeWater");
  const awayWater = normalizeWaterField("awayWater");
  let handicap: NormalizedHandicap | null = null;
  if (input.handicap === null || input.handicap === undefined || input.handicap.trim() === "") {
    missingFields.push(`${prefix}.handicap`);
  } else {
    handicap = normalizeHandicap(input.handicap);
    if (!handicap) invalidFields.push(`${prefix}.handicap`);
  }

  const normalized = homeWater && awayWater && handicap
    ? Object.freeze({ homeWater, awayWater, handicap })
    : null;
  return Object.freeze({
    normalized,
    missingFields: Object.freeze(missingFields),
    invalidFields: Object.freeze(invalidFields),
  });
}

export function hasHandicapChanged(
  current: NormalizedStrategyNode,
  previousEffective: NormalizedPreviousEffective | null,
): boolean {
  return previousEffective !== null
    && current.handicap.quarterUnits !== previousEffective.handicap.quarterUnits;
}

export function stableStrategyJson(value: unknown): string {
  return stableCanonicalJson(value);
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const DECISION_STATUSES: readonly StrategyDecisionStatus[] = [
  "recommend", "observe", "reanalyze_required", "insufficient_data",
];
const STRATEGY_IDS: readonly StrategyId[] = ["A", "B", "C", "D"];

function assertStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new TypeError(`Invalid strategy result: ${field}`);
  }
  return [...value];
}

function cloneNormalizedWater(value: unknown): NormalizedWater | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new TypeError("Invalid normalized water");
  const candidate = value as NormalizedWater;
  if (typeof candidate.raw !== "string" || !Number.isSafeInteger(candidate.basisPoints)) {
    throw new TypeError("Invalid normalized water");
  }
  return { raw: candidate.raw, basisPoints: candidate.basisPoints };
}

function cloneNormalizedHandicap(value: unknown): NormalizedHandicap {
  if (!value || typeof value !== "object") throw new TypeError("Invalid normalized handicap");
  const candidate = value as NormalizedHandicap;
  if (typeof candidate.raw !== "string" || !Number.isFinite(candidate.goals)
    || !Number.isSafeInteger(candidate.quarterUnits)) {
    throw new TypeError("Invalid normalized handicap");
  }
  return { raw: candidate.raw, goals: candidate.goals, quarterUnits: candidate.quarterUnits };
}

function cloneCurrent(value: unknown): NormalizedStrategyNode | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new TypeError("Invalid normalized current node");
  const candidate = value as NormalizedStrategyNode;
  const homeWater = cloneNormalizedWater(candidate.homeWater);
  const awayWater = cloneNormalizedWater(candidate.awayWater);
  if (!homeWater || !awayWater) throw new TypeError("Invalid normalized current node");
  return { homeWater, awayWater, handicap: cloneNormalizedHandicap(candidate.handicap) };
}

function clonePrevious(value: unknown): NormalizedPreviousEffective | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new TypeError("Invalid normalized previous node");
  return { handicap: cloneNormalizedHandicap((value as NormalizedPreviousEffective).handicap) };
}

/** Validates, detaches and recursively freezes the shared strategy output contract. */
export function snapshotStrategyResult(
  value: StrategyEvaluationResult,
  expectedStrategy?: StrategyId,
  expectedCheckpoint?: StrategyEvaluationResult["meta"]["checkpoint"],
): StrategyEvaluationResult {
  if (!value || typeof value !== "object" || !value.decision || !value.meta) {
    throw new TypeError("Invalid strategy result");
  }
  const { decision, meta } = value;
  if (!DECISION_STATUSES.includes(decision.status)
    || (decision.side !== null && decision.side !== "home" && decision.side !== "away")
    || (decision.status === "recommend" && decision.side === null)
    || (decision.status !== "recommend" && decision.side !== null)
    || typeof decision.reasonCode !== "string" || decision.reasonCode === ""
    || typeof decision.branchId !== "string" || decision.branchId === ""
    || typeof decision.lockedByDeterministicRule !== "boolean") {
    throw new TypeError("Invalid strategy result: decision");
  }
  if (!STRATEGY_IDS.includes(meta.requestedStrategy) || !STRATEGY_IDS.includes(meta.executedStrategy)
    || (expectedStrategy && (meta.requestedStrategy !== expectedStrategy || meta.executedStrategy !== expectedStrategy))
    || (expectedCheckpoint && meta.checkpoint !== expectedCheckpoint)
    || !["T1215", "T30", "T03"].includes(meta.checkpoint)
    || (meta.waterDiffBasisPoints !== null && !Number.isSafeInteger(meta.waterDiffBasisPoints))) {
    throw new TypeError("Invalid strategy result: meta");
  }
  const snapshot: StrategyEvaluationResult = {
    decision: {
      status: decision.status,
      side: decision.side as StrategySide | null,
      reasonCode: decision.reasonCode,
      branchId: decision.branchId,
      lockedByDeterministicRule: decision.lockedByDeterministicRule,
    },
    meta: {
      checkpoint: meta.checkpoint,
      requestedStrategy: meta.requestedStrategy,
      executedStrategy: meta.executedStrategy,
      normalizedCurrent: cloneCurrent(meta.normalizedCurrent),
      normalizedPreviousEffective: clonePrevious(meta.normalizedPreviousEffective),
      waterDiffBasisPoints: meta.waterDiffBasisPoints,
      missingFields: assertStringArray(meta.missingFields, "missingFields"),
      invalidFields: assertStringArray(meta.invalidFields, "invalidFields"),
    },
  };
  return deepFreeze(snapshot) as StrategyEvaluationResult;
}
