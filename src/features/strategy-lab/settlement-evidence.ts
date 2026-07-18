import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/canonical-json";

export const MATCH_RESULT_REVISION_HASH_DOMAIN = "strategy-lab.match-result-revision" as const;
export const MATCH_RESULT_REVISION_SCHEMA_VERSION = "v2" as const;
export const SETTLEMENT_EVIDENCE_HASH_DOMAIN = "strategy-lab.settlement-evidence" as const;
export const SETTLEMENT_EVIDENCE_SCHEMA_VERSION = "v2" as const;

const timestamp = z.string().datetime({ offset: true });
const matchResultRevisionContentSchema = z.object({
  sourceMatchResultId: z.number().int().positive(),
  matchId: z.string().trim().min(1).max(20),
  matchDate: z.string().regex(/^\d{8}$/),
  status: z.enum(["finished", "pending", "special"]),
  homeScore: z.number().int().min(0).max(99).nullable(),
  awayScore: z.number().int().min(0).max(99).nullable(),
  scoreSource: z.string().trim().min(1),
  sourceObservedAt: timestamp,
  sourceSettledAt: timestamp.nullable(),
  sourceUpdatedAt: timestamp,
}).strict().superRefine((value, context) => {
  const finished = value.status === "finished";
  if (finished !== (value.homeScore !== null && value.awayScore !== null && value.sourceSettledAt !== null)) {
    context.addIssue({ code: "custom", message: "result status and score evidence disagree" });
  }
  if (!finished && (value.homeScore !== null || value.awayScore !== null || value.sourceSettledAt !== null)) {
    context.addIssue({ code: "custom", message: "non-finished result cannot contain score evidence" });
  }
  if (Date.parse(value.sourceObservedAt) > Date.parse(value.sourceUpdatedAt)
    || (value.sourceSettledAt !== null && Date.parse(value.sourceObservedAt) > Date.parse(value.sourceSettledAt))) {
    context.addIssue({ code: "custom", message: "result evidence timestamps are not monotonic" });
  }
});

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.string(), z.number().finite(), z.array(jsonValue), z.record(z.string(), jsonValue),
]));
const settlementEvidenceContentSchema = z.object({
  calculatorVersion: z.string().trim().min(1),
  operationBinding: z.string().trim().min(1),
  predictionId: z.string().uuid(),
  matchResultRevisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  quoteBasis: z.enum(["actual", "theoretical"]),
  actualQuoteSnapshotId: z.number().int().positive().nullable(),
  quoteHandicapRaw: z.string().trim().min(1),
  quoteHandicapQuarterUnits: z.number().int().min(-80).max(80),
  quoteSelectedWater: z.string().regex(/^(?:0|[1-9]\d*)\.\d{6}$/),
  quoteSelectedWaterMillionths: z.number().int().min(1).max(5_000_000),
  outcome: z.enum(["win", "half_win", "push", "half_loss", "loss", "unavailable"]),
  profitMicros: z.number().int().min(-1_000_000).max(5_000_000).nullable(),
  profitDecimal: z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{6}$/).nullable(),
  legs: z.array(z.object({
    handicapQuarterUnits: z.number().int().min(-80).max(80),
    stakeMicros: z.number().int().positive().max(1_000_000),
    result: z.enum(["win", "push", "loss"]),
    profitMicros: z.number().int().min(-1_000_000).max(5_000_000),
  }).strict()).max(2),
  evidence: z.record(z.string(), jsonValue),
}).strict().superRefine((value, context) => {
  if ((value.quoteBasis === "actual") !== (value.actualQuoteSnapshotId !== null)) {
    context.addIssue({ code: "custom", message: "quote basis identity mismatch" });
  }
  if ((value.outcome === "unavailable") !== (value.profitMicros === null)) {
    context.addIssue({ code: "custom", message: "outcome and profit evidence mismatch" });
  }
  if ((value.profitMicros === null) !== (value.profitDecimal === null)) context.addIssue({ code: "custom", message: "profit representations disagree" });
  if (value.profitMicros !== null && value.profitDecimal !== (value.profitMicros / 1_000_000).toFixed(6)) context.addIssue({ code: "custom", message: "profit decimal is not canonical" });
  if (value.quoteSelectedWater !== (value.quoteSelectedWaterMillionths / 1_000_000).toFixed(6)) context.addIssue({ code: "custom", message: "water representations disagree" });
  if ((value.outcome === "unavailable") !== (value.legs.length === 0)) context.addIssue({ code: "custom", message: "settlement legs disagree with outcome" });
});

export type MatchResultRevisionHashInput = z.input<typeof matchResultRevisionContentSchema>;
export type SettlementEvidenceHashInput = z.input<typeof settlementEvidenceContentSchema>;

export function computeMatchResultRevisionHash(input: MatchResultRevisionHashInput): string {
  return canonicalJsonSha256({
    domain: MATCH_RESULT_REVISION_HASH_DOMAIN,
    schemaVersion: MATCH_RESULT_REVISION_SCHEMA_VERSION,
    content: matchResultRevisionContentSchema.parse(input),
  });
}

export function computeSettlementEvidenceHash(input: SettlementEvidenceHashInput): string {
  return canonicalJsonSha256({
    domain: SETTLEMENT_EVIDENCE_HASH_DOMAIN,
    schemaVersion: SETTLEMENT_EVIDENCE_SCHEMA_VERSION,
    content: settlementEvidenceContentSchema.parse(input),
  });
}
