import { z } from "zod";

export const ADMIN_QUERY_CONTRACT_VERSION = "read-v1" as const;
export const strategyLabCheckpointSchema = z.enum(["T1215", "T30", "T03"]);
export const strategyLabRequestedStrategySchema = z.enum(["A", "B", "C", "D"]);
export const strategyLabRunStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "cancelled"]);
export const strategyLabQuoteBasisSchema = z.enum(["actual", "theoretical"]);
export const strategyLabOutcomeSchema = z.enum(["win", "half_win", "push", "half_loss", "loss", "unavailable"]);
const nullableDecimal = z.string().regex(/^-?\d+(?:\.\d+)?$/).nullable();

export const pageInfoSchema = z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.string().nullable() }).strict();
export const metricSchema = z.object({
  counted: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative(),
  outcomes: z.object({ win: z.number().int(), halfWin: z.number().int(), push: z.number().int(), halfLoss: z.number().int(), loss: z.number().int() }).strict(),
  profitMicros: z.string().regex(/^-?\d+$/), stakeMicros: z.string().regex(/^\d+$/), roi: nullableDecimal,
}).strict();
export const matrixCellSchema = z.object({
  strategy: strategyLabRequestedStrategySchema, checkpoint: strategyLabCheckpointSchema,
  executable: z.boolean(), compatibilityOnly: z.boolean(), sample: z.number().int().nonnegative(),
  decisions: z.object({ recommend: z.number().int(), observe: z.number().int(), reanalyze: z.number().int(), insufficient: z.number().int() }).strict(),
  fallback: z.number().int().nonnegative(), snapshotQuality: z.object({ ready: z.number().int(), partial: z.number().int(), insufficient: z.number().int(), invalid: z.number().int(), missing: z.number().int() }).strict(),
  actual: metricSchema, theoretical: metricSchema,
}).strict();
export const runListItemSchema = z.object({ id:z.string().uuid(), runType:z.string(), status:strategyLabRunStatusSchema, datasetMode:z.string(), startDate:z.string(), endDate:z.string(), datasetCutoffAt:z.string(), createdAt:z.string(), updatedAt:z.string(), coverage:z.object({predictions:z.number().int(),matches:z.number().int(),settled:z.number().int()}).strict(), auditStatus:z.enum(["audited","audit_pending","none"]) }).strict();
export const integritySchema = z.object({ hashVerification:z.enum(["constraint_verified","evidence_verified","unknown"]), asof:z.enum(["verified","failed","unknown"]), predecessor:z.enum(["verified","failed","unknown"]), revision:z.enum(["verified","failed","unknown"]) }).strict();
export const queryEnvelopeSchema = <T extends z.ZodTypeAny>(data:T) => z.object({ contractVersion:z.literal(ADMIN_QUERY_CONTRACT_VERSION), generatedAt:z.string(), requestId:z.string(), appliedFilters:z.record(z.string(),z.unknown()), pageInfo:pageInfoSchema.nullable(), data }).strict();

export type MatrixCell = z.infer<typeof matrixCellSchema>;
export type RunListItem = z.infer<typeof runListItemSchema>;
export type QueryEnvelope<T> = { contractVersion:typeof ADMIN_QUERY_CONTRACT_VERSION; generatedAt:string; requestId:string; appliedFilters:Record<string,unknown>; pageInfo:null|z.infer<typeof pageInfoSchema>; data:T };
