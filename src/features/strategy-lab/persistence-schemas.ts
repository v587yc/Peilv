import { z } from "zod";
import { strategyArtifactSetSchema } from "./strategy-runtime";
import { strategyLabHashSchema } from "./policy-schemas";

const uuid = z.string().uuid();
const dateKey = z.string().regex(/^\d{8}$/).refine(value => {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}, "invalid calendar date");
const timestamp = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
export const canonicalUtcMillisecondsSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  "timestamp must be canonical UTC milliseconds",
).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "invalid UTC timestamp");
const nonEmpty = z.string().trim().min(1);
const finiteNumber = z.number().finite();
export const canonicalDecimalSixSchema = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{6}$/, "decimal must use canonical six-place form");
export const waterMillionthsSchema = z.number().int().min(1).max(5_000_000);
export const strategyLabProfitUnitsSchema = finiteNumber.refine(value => {
  if (Math.abs(value) > 999_999.999_999) return false;
  const scaled = value * 1_000_000;
  return Number.isSafeInteger(Math.round(scaled)) && Math.abs(scaled - Math.round(scaled)) <= 1e-7;
}, "profit units must fit NUMERIC(12,6)");
export type StrategyLabJsonValue = string | number | boolean | null | StrategyLabJsonValue[] | { [key: string]: StrategyLabJsonValue };
export const strategyLabJsonValueSchema: z.ZodType<StrategyLabJsonValue> = z.lazy(() => z.union([
  z.string(), finiteNumber, z.boolean(), z.null(), z.array(strategyLabJsonValueSchema), z.record(z.string(), strategyLabJsonValueSchema),
]));
export const strategyLabJsonObjectSchema = z.record(z.string(), strategyLabJsonValueSchema);
const jsonObject = strategyLabJsonObjectSchema;

export const strategyCheckpointSchema = z.enum(["T1215", "T30", "T03"]);
export const strategyIdSchema = z.enum(["A", "B", "C", "D"]);
export const strategyDatasetModeSchema = z.enum(["strict_asof", "reconstructed"]);
export const strategyDecisionStatusSchema = z.enum([
  "recommend", "observe", "reanalyze_required", "insufficient_data",
]);

export const persistedHandicapSchema = z.object({
  raw: nonEmpty,
  quarterUnits: z.number().int().min(-80).max(80),
});

export const persistedWaterSchema = z.object({
  raw: nonEmpty,
  basisPoints: z.number().int().min(0).max(50_000),
});

export const strategyDecisionPayloadSchema = z.object({
  current: z.object({
    handicap: persistedHandicapSchema,
    homeWater: persistedWaterSchema,
    awayWater: persistedWaterSchema,
  }).nullable(),
  previousEffective: z.object({ handicap: persistedHandicapSchema }).nullable(),
  waterDiffBasisPoints: z.number().int().min(0).max(50_000).nullable(),
  details: jsonObject.default({}),
});

export const createStrategyLabSnapshotSetSchema = z.object({
  id: uuid,
  runId: uuid,
  matchId: nonEmpty.max(20),
  matchDate: dateKey,
  checkpointType: strategyCheckpointSchema,
  checkpointAt: timestamp,
  datasetMode: strategyDatasetModeSchema,
  status: z.enum(["ready", "partial", "insufficient", "invalid", "missing"]),
  previousSnapshotSetId: uuid.nullable(),
  revision: z.number().int().positive(),
  supersedesSnapshotSetId: uuid.nullable(),
  sourceCutoffAt: timestamp,
  contentHash: nonEmpty,
  schemaVersion: z.number().int().positive(),
  completeness: jsonObject,
  traceId: nonEmpty,
}).superRefine((value, context) => {
  if (value.previousSnapshotSetId === value.id) {
    context.addIssue({ code: "custom", path: ["previousSnapshotSetId"], message: "snapshot cannot reference itself as previous checkpoint" });
  }
  if (value.supersedesSnapshotSetId === value.id) {
    context.addIssue({ code: "custom", path: ["supersedesSnapshotSetId"], message: "snapshot cannot supersede itself" });
  }
  if ((value.checkpointType === "T1215") !== (value.previousSnapshotSetId === null)) {
    context.addIssue({ code: "custom", path: ["previousSnapshotSetId"], message: "checkpoint predecessor shape is invalid" });
  }
  if ((value.revision === 1) !== (value.supersedesSnapshotSetId === null)) {
    context.addIssue({ code: "custom", path: ["supersedesSnapshotSetId"], message: "snapshot revision predecessor shape is invalid" });
  }
  if (value.datasetMode === "strict_asof"
    && Date.parse(value.sourceCutoffAt) > Date.parse(value.checkpointAt)) {
    context.addIssue({ code: "custom", path: ["sourceCutoffAt"], message: "strict as-of cutoff exceeds checkpoint" });
  }
});

export const createStrategyLabSnapshotItemSchema = z.object({
  snapshotSetId: uuid,
  oddsSnapshotId: z.number().int().positive(),
  role: z.literal("current"),
  companyId: nonEmpty.max(20),
  marketType: nonEmpty,
  snapshotType: nonEmpty,
  sourceObservedAt: timestamp.nullable(),
  collectedAt: timestamp,
});

export const createStrategyLabRunSchema = z.object({
  id: uuid,
  runType: z.enum(["shadow", "backtest", "manual"]),
  status: z.literal("pending"),
  datasetMode: strategyDatasetModeSchema,
  startDate: dateKey,
  endDate: dateKey,
  datasetCutoffAt: timestamp,
  strategyVersions: strategyArtifactSetSchema,
  configuration: z.object({policy:z.object({mode:z.literal("user_focused_leagues"),artifactHash:strategyLabHashSchema,captureId:uuid,capturedAt:canonicalUtcMillisecondsSchema,datasetCutoffAt:canonicalUtcMillisecondsSchema,evidenceHash:strategyLabHashSchema}).strict()}).strict(),
  codeVersion: nonEmpty,
  idempotencyKey: nonEmpty,
  createdBy: nonEmpty,
  traceId: nonEmpty,
  createdAt: timestamp.optional(),
  updatedAt: timestamp.optional(),
}).superRefine((value, context) => {
  if ((value.createdAt === undefined) !== (value.updatedAt === undefined)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "createdAt and updatedAt must be provided together" });
  } else if (value.createdAt && value.updatedAt && Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt precedes createdAt" });
  }
});

const runTransitionBase = z.object({
  id: uuid,
  errorSummary: z.string().max(2_000).nullable(),
  createdAt: timestamp,
  previousUpdatedAt: timestamp,
  updatedAt: timestamp,
});

export const updateStrategyLabRunSchema = z.discriminatedUnion("transition", [
  runTransitionBase.extend({
    transition: z.literal("pending_to_running"), expectedCurrentStatus: z.literal("pending"),
    status: z.literal("running"), startedAt: timestamp, finishedAt: z.null(),
  }),
  runTransitionBase.extend({
    transition: z.literal("pending_to_cancelled"), expectedCurrentStatus: z.literal("pending"),
    status: z.literal("cancelled"), startedAt: z.null(), finishedAt: timestamp,
  }),
  runTransitionBase.extend({
    transition: z.literal("running_to_succeeded"), expectedCurrentStatus: z.literal("running"),
    status: z.literal("succeeded"), startedAt: timestamp, finishedAt: timestamp,
  }),
  runTransitionBase.extend({
    transition: z.literal("running_to_failed"), expectedCurrentStatus: z.literal("running"),
    status: z.literal("failed"), startedAt: timestamp, finishedAt: timestamp,
  }),
  runTransitionBase.extend({
    transition: z.literal("running_to_cancelled"), expectedCurrentStatus: z.literal("running"),
    status: z.literal("cancelled"), startedAt: timestamp, finishedAt: timestamp,
  }),
]).superRefine((value, context) => {
  const createdAt = Date.parse(value.createdAt);
  const previousUpdatedAt = Date.parse(value.previousUpdatedAt);
  const updatedAt = Date.parse(value.updatedAt);
  if (previousUpdatedAt < createdAt) {
    context.addIssue({ code: "custom", path: ["previousUpdatedAt"], message: "previousUpdatedAt precedes createdAt" });
  }
  if (updatedAt < createdAt || updatedAt < previousUpdatedAt) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt is not monotonic" });
  }
  if (value.startedAt !== null && Date.parse(value.startedAt) < createdAt) {
    context.addIssue({ code: "custom", path: ["startedAt"], message: "startedAt precedes createdAt" });
  }
  if (value.finishedAt !== null && Date.parse(value.finishedAt) < createdAt) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: "finishedAt precedes createdAt" });
  }
  if (value.startedAt !== null && value.finishedAt !== null
    && Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
    context.addIssue({ code: "custom", path: ["finishedAt"], message: "finishedAt precedes startedAt" });
  }
  if (value.status === "running" && value.startedAt !== null && updatedAt < Date.parse(value.startedAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "running update precedes startedAt" });
  }
  if (value.finishedAt !== null && updatedAt < Date.parse(value.finishedAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "terminal update precedes finishedAt" });
  }
});

export const createStrategyLabPredictionSchema = z.object({
  id: uuid,
  runId: uuid,
  matchId: nonEmpty.max(20),
  matchDate: dateKey,
  checkpointType: strategyCheckpointSchema,
  snapshotSetId: uuid,
  requestedStrategy: strategyIdSchema,
  executedStrategy: strategyIdSchema,
  strategyVersion: nonEmpty,
  decisionStatus: strategyDecisionStatusSchema,
  selection: z.enum(["home", "away"]).nullable(),
  lockedDeterministic: z.boolean(),
  reasonCode: nonEmpty,
  branchId: nonEmpty,
  inputHash: nonEmpty,
  outputHash: nonEmpty,
  decisionPayload: strategyDecisionPayloadSchema,
  fallbackReason: nonEmpty.nullable(),
  legacyPredictionId: z.number().int().positive().nullable(),
  source: z.enum(["experiment", "d_compat_shadow"]),
  idempotencyKey: nonEmpty,
  traceId: nonEmpty,
  evidenceContractVersion: z.union([z.literal(1), z.literal(2)]).default(1),
  executionCutoffAt: timestamp.nullable().default(null),
  executedActualQuoteSnapshotId: z.number().int().positive().nullable().default(null),
  theoreticalHandicapRaw: nonEmpty.nullable().default(null),
  theoreticalHandicapQuarterUnits: z.number().int().min(-80).max(80).nullable().default(null),
  theoreticalSelectedWater: canonicalDecimalSixSchema.nullable().default(null),
}).superRefine((value, context) => {
  const identityValid = value.requestedStrategy === "C"
    ? value.executedStrategy === "C" || value.executedStrategy === "A"
    : value.executedStrategy === value.requestedStrategy;
  if (!identityValid) context.addIssue({ code: "custom", path: ["executedStrategy"], message: "invalid strategy execution identity" });
  const isFallback = value.requestedStrategy === "C" && value.executedStrategy === "A";
  if (isFallback !== (value.fallbackReason !== null)) {
    context.addIssue({ code: "custom", path: ["fallbackReason"], message: "fallback reason must match C to A execution" });
  }
  const selectionValid = value.decisionStatus === "recommend"
    ? value.selection !== null
    : value.selection === null;
  if (!selectionValid) context.addIssue({ code: "custom", path: ["selection"], message: "selection must match decision status" });
  const physical = value.executionCutoffAt !== null && value.executedActualQuoteSnapshotId !== null
    && value.theoreticalHandicapRaw !== null && value.theoreticalHandicapQuarterUnits !== null
    && value.theoreticalSelectedWater !== null;
  const anyPhysical = value.executionCutoffAt !== null || value.executedActualQuoteSnapshotId !== null
    || value.theoreticalHandicapRaw !== null || value.theoreticalHandicapQuarterUnits !== null
    || value.theoreticalSelectedWater !== null;
  if (value.evidenceContractVersion === 2 && value.decisionStatus === "recommend" && !physical) {
    context.addIssue({ code: "custom", path: ["evidenceContractVersion"], message: "v2 recommendation requires frozen physical evidence" });
  }
  if (value.evidenceContractVersion === 2 && value.decisionStatus !== "recommend" && (
    value.executionCutoffAt !== null || value.executedActualQuoteSnapshotId !== null
    || value.theoreticalHandicapRaw !== null || value.theoreticalHandicapQuarterUnits !== null
    || value.theoreticalSelectedWater !== null
  )) context.addIssue({ code: "custom", path: ["evidenceContractVersion"], message: "non-recommendation cannot freeze quote evidence" });
  if (value.evidenceContractVersion === 1 && anyPhysical) context.addIssue({ code: "custom", path: ["evidenceContractVersion"], message: "v1 cannot claim v2 physical evidence" });
});

const settlementBase = z.object({
  id: uuid,
  predictionId: uuid,
  revision: z.number().int().positive(),
  matchResultId: z.number().int().positive(),
  matchResultRevisionId: uuid.nullable().default(null),
  calculatorVersion: nonEmpty.nullable().default(null),
  evidenceHash: strategyLabHashSchema.nullable().default(null),
  quoteHandicapRaw: nonEmpty.nullable().default(null),
  quoteHandicapQuarterUnits: z.number().int().min(-80).max(80).nullable().default(null),
  quoteSelectedWater: canonicalDecimalSixSchema.nullable().default(null),
  quoteSelectedWaterMillionths: z.number().int().min(1).max(5_000_000).nullable().default(null),
  outcome: z.enum(["win", "half_win", "push", "half_loss", "loss", "unavailable"]),
  profitUnits: strategyLabProfitUnitsSchema.nullable(),
  isCounted: z.boolean(),
  settledAt: timestamp,
  settledBy: nonEmpty,
  supersedes: uuid.nullable(),
  traceId: nonEmpty,
});

const actualQuoteEvidenceSchema = jsonObject.superRefine((value, context) => {
  if ("actualQuoteSnapshotId" in value) {
    context.addIssue({ code: "custom", path: ["actualQuoteSnapshotId"], message: "actual quote identity belongs in the physical FK column" });
  }
  if ("theoreticalQuote" in value) {
    context.addIssue({ code: "custom", path: ["theoreticalQuote"], message: "actual settlement cannot contain theoretical quote evidence" });
  }
});

const theoreticalQuoteEvidenceSchema = z.object({
  theoreticalQuote: jsonObject.refine(value => Object.keys(value).length > 0, "theoretical quote cannot be empty"),
}).catchall(strategyLabJsonValueSchema).superRefine((value, context) => {
  if ("actualQuoteSnapshotId" in value) {
    context.addIssue({ code: "custom", path: ["actualQuoteSnapshotId"], message: "theoretical settlement cannot contain actual quote evidence" });
  }
});

export const createStrategyLabSettlementSchema = z.discriminatedUnion("quoteBasis", [
  settlementBase.extend({
    quoteBasis: z.literal("actual"), settlementBasis: z.literal("actual_quote"),
    actualQuoteSnapshotId: z.number().int().positive(), evidence: actualQuoteEvidenceSchema,
  }),
  settlementBase.extend({
    quoteBasis: z.literal("theoretical"), settlementBasis: z.literal("theoretical_quote"),
    actualQuoteSnapshotId: z.null(), evidence: theoreticalQuoteEvidenceSchema,
  }),
]).superRefine((value, context) => {
  const hasPhysicalQuote = value.quoteHandicapRaw !== null && value.quoteHandicapQuarterUnits !== null
    && value.quoteSelectedWater !== null && value.quoteSelectedWaterMillionths !== null;
  if (value.calculatorVersion !== null && (!hasPhysicalQuote || value.matchResultRevisionId === null || value.evidenceHash === null)) {
    context.addIssue({ code: "custom", path: ["calculatorVersion"], message: "trusted settlement requires physical quote and revision evidence" });
  }
  if (value.supersedes === value.id) {
    context.addIssue({ code: "custom", path: ["supersedes"], message: "settlement cannot supersede itself" });
  }
  if ((value.revision === 1) !== (value.supersedes === null)) {
    context.addIssue({ code: "custom", path: ["supersedes"], message: "settlement revision predecessor shape is invalid" });
  }
  if (value.outcome === "unavailable") {
    if (value.profitUnits !== null || value.isCounted) {
      context.addIssue({ code: "custom", path: ["profitUnits"], message: "unavailable settlement cannot be counted" });
    }
  } else {
    const profit = value.profitUnits;
    const signValid = profit !== null && (
      ((value.outcome === "win" || value.outcome === "half_win") && profit > 0)
      || (value.outcome === "push" && profit === 0)
      || ((value.outcome === "half_loss" || value.outcome === "loss") && profit < 0)
    );
    if (!signValid || !value.isCounted) {
      context.addIssue({ code: "custom", path: ["profitUnits"], message: "outcome requires matching signed counted profit units" });
    }
  }
});

export const strategyLabCommandActionSchema = z.enum([
  "run.create", "run.transition", "snapshot.capture", "prediction.execute", "settlement.create",
]);
export const strategyLabCommandReceiptSchema = z.object({
  id: uuid,
  action: strategyLabCommandActionSchema,
  operationKey: z.string().trim().min(1).max(128),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["audit_pending", "audited"]),
  resultType: z.enum(["strategy_lab_run", "strategy_lab_snapshot", "strategy_lab_prediction", "strategy_lab_settlement"]),
  resultId: uuid,
  actorId: z.string().trim().min(1).max(200),
  requestId: z.string().trim().min(1).max(200),
  auditAttempts: z.number().int().nonnegative(),
  lastAuditErrorCode: z.string().trim().min(1).max(100).nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  auditedAt: timestamp.nullable(),
});

export type CreateStrategyLabSnapshotSet = z.infer<typeof createStrategyLabSnapshotSetSchema>;
export type CreateStrategyLabSnapshotItem = z.infer<typeof createStrategyLabSnapshotItemSchema>;
export type CreateStrategyLabRun = z.infer<typeof createStrategyLabRunSchema>;
export type UpdateStrategyLabRun = z.infer<typeof updateStrategyLabRunSchema>;
export type CreateStrategyLabPrediction = z.infer<typeof createStrategyLabPredictionSchema>;
export type CreateStrategyLabSettlement = z.infer<typeof createStrategyLabSettlementSchema>;
export type StrategyLabCommandReceipt = z.infer<typeof strategyLabCommandReceiptSchema>;
export type StrategyLabCommandAction = z.infer<typeof strategyLabCommandActionSchema>;
