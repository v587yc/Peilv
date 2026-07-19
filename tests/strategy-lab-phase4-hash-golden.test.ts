import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@/lib/canonical-json";
import { computeMatchResultRevisionHash, computeSettlementEvidenceHash } from "@/features/strategy-lab/settlement-evidence";

const RESULT_GOLDEN = "96ac1ee724043f3f0fdac480108d6aaafcb521d5de10e94f14df5ca88d0a3956";
const SETTLEMENT_GOLDEN = "af026eac1e5823f0c684f1bb0d358ade032725ffea04c291552a97d697310b45";
const QUOTE_GOLDEN = "27f48aeefe7b4023277ba8c35af64953c6786e9f76010fed461e1a2424eb143d";

const result = {
  sourceMatchResultId: 42, matchId: "m-20260717-1", matchDate: "20260717", status: "finished" as const,
  homeScore: 2, awayScore: 1, scoreSource: "official", sourceObservedAt: "2026-07-17T14:00:00.000Z",
  sourceSettledAt: "2026-07-17T15:00:00.000Z", sourceUpdatedAt: "2026-07-17T15:01:00.000Z",
};
const settlement = {
  calculatorVersion: "asian-settlement-v1", operationBinding: "settlement.create:phase4-golden-0001",
  predictionId: "10000000-0000-4000-8000-000000000001", matchResultRevisionHash: "a".repeat(64),
  quoteBasis: "actual" as const, actualQuoteSnapshotId: 77, quoteHandicapRaw: "半/一", quoteHandicapQuarterUnits: 3,
  quoteSelectedWater: "0.900000", quoteSelectedWaterMillionths: 900000, outcome: "half_win" as const,
  profitMicros: 450000, profitDecimal: "0.450000",
  legs: [{ handicapQuarterUnits: 2, stakeMicros: 500000, result: "win" as const, profitMicros: 450000 }, { handicapQuarterUnits: 4, stakeMicros: 500000, result: "push" as const, profitMicros: 0 }],
  evidence: { schemaVersion: "strategy-lab-settlement-evidence-v2", score: { home: 2, away: 1 }, quote: { companyId: "3", hash: "b".repeat(64) } },
};
const quote = { handicapAway: "0.980000", handicapHome: "0.900000", handicapLine: "半/一" };

describe("Phase4 fixed SHA256 goldens", () => {
  it("freezes result revision, settlement evidence and actual quote hashes", () => {
    expect(computeMatchResultRevisionHash(result)).toBe(RESULT_GOLDEN);
    expect(computeSettlementEvidenceHash(settlement)).toBe(SETTLEMENT_GOLDEN);
    expect(canonicalJsonSha256(quote)).toBe(QUOTE_GOLDEN);
  });

  it("is object-key-order independent and array-order sensitive", () => {
    expect(computeMatchResultRevisionHash({ ...result, sourceUpdatedAt: result.sourceUpdatedAt })).toBe(RESULT_GOLDEN);
    expect(canonicalJsonSha256({ handicapLine: "半/一", handicapHome: "0.900000", handicapAway: "0.980000" })).toBe(QUOTE_GOLDEN);
    expect(computeSettlementEvidenceHash({ ...settlement, legs: [...settlement.legs].reverse() })).not.toBe(SETTLEMENT_GOLDEN);
  });

  it.each([
    ["calculatorVersion", { ...settlement, calculatorVersion: "asian-settlement-v2" }],
    ["operationBinding", { ...settlement, operationBinding: "settlement.create:other" }],
    ["quote", { ...settlement, quoteSelectedWater: "0.900001", quoteSelectedWaterMillionths: 900001 }],
  ])("changes settlement hash when %s changes", (_name, changed) => expect(computeSettlementEvidenceHash(changed)).not.toBe(SETTLEMENT_GOLDEN));

  it.each([
    ["score", { ...result, homeScore: 3 }], ["content", { ...result, scoreSource: "correction" }],
  ])("changes result hash when %s changes", (_name, changed) => expect(computeMatchResultRevisionHash(changed)).not.toBe(RESULT_GOLDEN));

  it("domain and schema version are cryptographically bound", () => {
    expect(canonicalJsonSha256({ domain: "other", schemaVersion: "v2", content: result })).not.toBe(RESULT_GOLDEN);
    expect(canonicalJsonSha256({ domain: "strategy-lab.match-result-revision", schemaVersion: "v3", content: result })).not.toBe(RESULT_GOLDEN);
  });

  it.each([
    ["undefined", { value: undefined }], ["NaN", { value: Number.NaN }], ["Infinity", { value: Number.POSITIVE_INFINITY }],
    ["BigInt", { value: BigInt(1) }], ["nonplain", new Date("2026-07-17T00:00:00Z")],
  ])("rejects canonical %s", (_name, value) => expect(() => canonicalJsonSha256(value)).toThrow());

  it("rejects cycles", () => { const cycle: Record<string, unknown> = {}; cycle.self = cycle; expect(() => canonicalJsonSha256(cycle)).toThrow(); });
});
