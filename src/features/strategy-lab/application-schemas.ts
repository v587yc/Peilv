import { z } from "zod";
import { canonicalUtcMillisecondsSchema, strategyCheckpointSchema, strategyIdSchema, strategyLabJsonObjectSchema } from "./persistence-schemas";

const uuid = z.string().uuid();
const operationKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
const dateKey = z.string().regex(/^\d{8}$/);
const nonEmpty = z.string().trim().min(1).max(200);

export const createRunApplicationSchema = z.object({
  startDate: dateKey,
  endDate: dateKey,
  datasetCutoffAt: canonicalUtcMillisecondsSchema,
  operationKey,
}).strict();

export const transitionRunApplicationSchema = z.object({
  id: uuid,
  transition: z.enum(["pending_to_running", "pending_to_cancelled", "running_to_succeeded", "running_to_failed", "running_to_cancelled"]),
  expectedCurrentStatus: z.enum(["pending", "running"]),
  previousUpdatedAt: canonicalUtcMillisecondsSchema,
  errorSummary: z.string().trim().max(500).nullable().optional(),
  operationKey,
}).strict();

export const captureSnapshotApplicationSchema = z.object({
  runId: uuid,
  matchId: nonEmpty.max(20),
  matchDate: dateKey,
  checkpointType: strategyCheckpointSchema,
  checkpointAt: canonicalUtcMillisecondsSchema,
  status: z.enum(["ready", "partial", "insufficient", "invalid", "missing"]),
  previousSnapshotSetId: uuid.nullable(),
  revision: z.number().int().positive(),
  supersedesSnapshotSetId: uuid.nullable(),
  sourceCutoffAt: canonicalUtcMillisecondsSchema,
  schemaVersion: z.number().int().positive(),
  completeness: strategyLabJsonObjectSchema,
  items: z.array(z.object({
    oddsSnapshotId: z.number().int().positive(), role: z.literal("current"), companyId: nonEmpty.max(20),
    marketType: nonEmpty, snapshotType: nonEmpty,
    sourceObservedAt: canonicalUtcMillisecondsSchema.nullable(), collectedAt: canonicalUtcMillisecondsSchema,
  })).max(500),
  operationKey,
}).strict().superRefine((value, context) => {
  if (value.schemaVersion !== 2) context.addIssue({ code: "custom", path: ["schemaVersion"], message: "strategy-lab-snapshot-v2 is required" });
  if ((value.status === "ready" || value.status === "partial") && value.items.length === 0) {
    context.addIssue({ code: "custom", path: ["items"], message: "ready or partial snapshots require items" });
  }
  const expectedItems = value.status === "ready" || value.status === "partial" ? 1 : 0;
  if (value.items.length !== expectedItems) {
    context.addIssue({ code: "custom", path: ["items"], message: "snapshot status requires exact current evidence cardinality" });
  }
  if (["missing", "insufficient", "invalid"].includes(value.status)) {
    const reason = value.completeness.reasonCode;
    if (typeof reason !== "string" || reason.trim() === "") {
      context.addIssue({ code: "custom", path: ["completeness", "reasonCode"], message: "incomplete snapshots require reasonCode" });
    }
  }
});

export const executeStrategyApplicationSchema = z.object({
  runId: uuid,
  snapshotSetId: uuid,
  strategy: strategyIdSchema,
  operationKey,
}).strict();

const settlementRequestBase = z.object({
  predictionId: uuid,
  operationKey,
});
export const createSettlementApplicationSchema = z.discriminatedUnion("quoteBasis", [
  settlementRequestBase.extend({ quoteBasis: z.literal("actual") }).strict(),
  settlementRequestBase.extend({ quoteBasis: z.literal("theoretical") }).strict(),
]);

export const strategyLabIdSchema = uuid;
export const strategyLabOperationKeySchema = operationKey;

export type CreateRunApplicationInput = z.infer<typeof createRunApplicationSchema>;
export type TransitionRunApplicationInput = z.infer<typeof transitionRunApplicationSchema>;
export type CaptureSnapshotApplicationInput = z.infer<typeof captureSnapshotApplicationSchema>;
export type ExecuteStrategyApplicationInput = z.infer<typeof executeStrategyApplicationSchema>;
export type CreateSettlementApplicationInput = z.infer<typeof createSettlementApplicationSchema>;
