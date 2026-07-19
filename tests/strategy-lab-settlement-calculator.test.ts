import { describe, expect, it } from "vitest";
import { PostgresSettlementCalculator } from "@/features/strategy-lab/postgres-settlement-calculator";
import type { StrategyLabSqlClient, StrategyLabSqlExecutor } from "@/features/strategy-lab/postgres-repository";
import type { StrategyLabPredictionRecord } from "@/features/strategy-lab/repository";
import { calculateAsianSettlement } from "@/lib/verification/asian-settlement";
import { canonicalJsonSha256 } from "@/lib/canonical-json";
import { readFile } from "node:fs/promises";

const snapshotSetId = "10000000-0000-4000-8000-000000000001";
const predictionId = "10000000-0000-4000-8000-000000000002";
const basePrediction = {
  id: predictionId, matchId: "m1", matchDate: "20260717", selection: "home", decisionStatus: "recommend",
  snapshotSetId, runId: "10000000-0000-4000-8000-000000000003", evidenceContractVersion: 2,
  executionCutoffAt: "2026-07-17T12:15:00.000Z", executedActualQuoteSnapshotId: 7,
} as unknown as StrategyLabPredictionRecord;

type Fixture = { status: "finished" | "pending" | "special"; homeScore: number | null; awayScore: number | null; settledAt: string | null; line: string; home: string; away: string; quote?: Record<string, unknown> };
const quarterUnits = (line: string) => line === "平" ? 0 : line === "平/半" ? 1 : line === "半球" ? 2 : line === "半/一" ? 3 : line === "一球" ? 4 : Number.NaN;
const fixture = (overrides: Partial<Fixture> = {}): Fixture => ({
  status: "finished", homeScore: 1, awayScore: 0, settledAt: "2026-07-17T15:00:00.000Z", line: "半球", home: "0.900000", away: "0.980000", ...overrides,
});
const validQuote = (overrides: Record<string, unknown> = {}) => {
  const odds = { handicapLine: "半球", handicapHome: "0.900000", handicapAway: "0.980000" };
  return { id: 7, company_id: "3", market_type: "asian_handicap", hash_version: "canonical-json-v2",
    match_id: "m1", match_date: "20260717", source: "source", source_observed_at: "2026-07-17T11:59:00.000Z",
    collected_at: "2026-07-17T12:00:00.000Z", odds, content_hash: canonicalJsonSha256(odds), canonical_content_hash: canonicalJsonSha256(odds), ...overrides };
};

function clientFor(value: Fixture, predictionOverrides: Record<string, unknown> = {}): StrategyLabSqlClient {
  const override = (key: string, fallback: unknown) => Object.prototype.hasOwnProperty.call(predictionOverrides, key) ? predictionOverrides[key] : fallback;
  const odds = { handicapLine: value.line, handicapHome: value.home, handicapAway: value.away };
  const row = {
    ...basePrediction, ...predictionOverrides, id: predictionId, match_id: "m1", match_date: "20260717", selection: predictionOverrides.selection ?? "home",
    decision_status: predictionOverrides.decisionStatus ?? "recommend", snapshot_set_id: snapshotSetId,
    evidence_contract_version: predictionOverrides.evidenceContractVersion ?? 2,
    snapshot_content_hash: "snapshot-content", run_status: predictionOverrides.runStatus ?? "running", run_type: predictionOverrides.runType ?? "shadow",
    kickoff_at: "2026-07-17T16:00:00.000Z", match_result_id: 9, result_status: value.status,
    home_score: value.homeScore, away_score: value.awayScore, score_source: "official",
    result_observed_at: "2026-07-17T14:00:00.000Z", result_settled_at: value.settledAt, result_updated_at: "2026-07-17T15:00:00.000Z",
    decision_payload: { details: { snapshotSetId: snapshotSetId, snapshotContentHash: "snapshot-content" } },
    theoretical_handicap_raw: override("theoretical_handicap_raw", value.line),
    theoretical_handicap_quarter_units: override("theoretical_handicap_quarter_units", quarterUnits(value.line)),
    theoretical_selected_water: override("theoretical_selected_water", value.home), output_hash: "output", strategy_version: "A-v1",
    executed_actual_quote_snapshot_id: predictionOverrides.executedActualQuoteSnapshotId ?? 7,
    execution_cutoff_at: predictionOverrides.executionCutoffAt ?? "2026-07-17T12:15:00.000Z",
  };
  const quote = value.quote ?? { id: 7, company_id: "3", market_type: "asian_handicap", hash_version: "canonical-json-v2",
    match_id: "m1", match_date: "20260717", source: "source", source_observed_at: "2026-07-17T11:59:00.000Z",
    collected_at: "2026-07-17T12:00:00.000Z", odds,
    content_hash: canonicalJsonSha256(odds), canonical_content_hash: canonicalJsonSha256(odds) };
  const executor: StrategyLabSqlExecutor = { query: async <Row extends Record<string, unknown>>(sql: string) => {
    if (sql.includes("FROM strategy_lab_predictions")) return { rows: [row as unknown as Row] };
    if (sql.includes("FROM odds_snapshots")) return { rows: [quote as unknown as Row] };
    return { rows: [] as Row[] };
  } };
  return { query: executor.query, transaction: async <T>(callback: (tx: StrategyLabSqlExecutor) => Promise<T>) => callback(executor) };
}

async function calculate(value: Fixture, quoteBasis: "actual" | "theoretical" = "actual", predictionOverrides: Record<string, unknown> = {}) {
  const calculator = new PostgresSettlementCalculator(clientFor(value, predictionOverrides));
  return calculator.calculate({ prediction: { ...basePrediction, ...predictionOverrides } as StrategyLabPredictionRecord, quoteBasis, actualQuoteSnapshotId: quoteBasis === "actual" ? 7 : null });
}

describe("trusted settlement calculator", () => {
  it.each([
    ["win", fixture({ line: "半球", homeScore: 1, awayScore: 0 })],
    ["half_win", fixture({ line: "半/一", homeScore: 1, awayScore: 0 })],
    ["push", fixture({ line: "平", homeScore: 0, awayScore: 0 })],
    ["half_loss", fixture({ line: "平/半", homeScore: 0, awayScore: 0 })],
    ["loss", fixture({ line: "半球", homeScore: 0, awayScore: 1 })],
  ] as const)("settles actual %s", async (expected, value) => {
    const result = await calculate(value);
    expect(result.outcome).toBe(expected);
    const pure = calculateAsianSettlement({ selection: "home", handicapQuarterUnits: quarterUnits(value.line), homeScore: value.homeScore!, awayScore: value.awayScore!, selectedWaterMillionths: 900000 });
    expect(result.profitMicros).toBe(pure.profitMicros);
    expect(result.profitDecimal).toBe(pure.profitDecimal);
    expect(result.legs).toEqual(pure.legs.map(leg => ({ handicapQuarterUnits: leg.handicapQuarterUnits, stakeMicros: leg.stakeMicros, result: leg.result, profitMicros: leg.profitMicros })));
  });

  it.each(["win", "half_win", "push", "half_loss", "loss"] as const)("settles theoretical %s with the same pure result", async expected => {
    const value = expected === "push" ? fixture({ line: "平", homeScore: 0, awayScore: 0 }) : expected === "half_loss" ? fixture({ line: "平/半", homeScore: 0, awayScore: 0 }) : expected === "loss" ? fixture({ line: "半球", homeScore: 0, awayScore: 1 }) : expected === "half_win" ? fixture({ line: "半/一", homeScore: 1, awayScore: 0 }) : fixture();
    const result = await calculate(value, "theoretical");
    expect(result.outcome).toBe(expected);
    expect(result.settlementBasis).toBe("theoretical_quote");
  });

  it("preserves special as unavailable and rejects pending as not_final", async () => {
    await expect(calculate(fixture({ status: "special", homeScore: null, awayScore: null, settledAt: null }))).resolves.toMatchObject({ outcome: "unavailable", profitMicros: null, isCounted: false, legs: [] });
    await expect(calculate(fixture({ status: "pending", homeScore: null, awayScore: null, settledAt: null }))).rejects.toMatchObject({ code: "not_final" });
  });

  it("rejects nonrecommend and actual quote binding/physical tampering", async () => {
    await expect(calculate(fixture(), "actual", { decisionStatus: "skip" })).rejects.toMatchObject({ code: "integrity" });
    await expect(new PostgresSettlementCalculator(clientFor(fixture(), { executedActualQuoteSnapshotId: 8 })).calculate({ prediction: { ...basePrediction, executedActualQuoteSnapshotId: 8 } as StrategyLabPredictionRecord, quoteBasis: "actual", actualQuoteSnapshotId: 8 })).rejects.toMatchObject({ code: "integrity" });
  });

  it.each([
    ["id", { id: 8 }], ["company", { company_id: "35" }], ["market", { market_type: "total" }],
    ["v2", { hash_version: "legacy-json-v1" }], ["match id", { match_id: "m2" }], ["match date", { match_date: "20260718" }],
    ["cutoff", { collected_at: "2026-07-17T12:16:00.000Z" }], ["kickoff", { collected_at: "2026-07-17T16:00:00.000Z" }],
    ["hash", { content_hash: "f".repeat(64) }],
  ])("rejects actual %s mismatch", async (_name, mutation) => {
    await expect(calculate(fixture({ quote: validQuote(mutation) }))).rejects.toMatchObject({ code: "integrity" });
  });

  it.each([
    ["missing raw", { theoretical_handicap_raw: null }], ["missing units", { theoretical_handicap_quarter_units: null }],
    ["missing water", { theoretical_selected_water: null }], ["illegal raw", { theoretical_handicap_raw: "???" }],
    ["unit mismatch", { theoretical_handicap_raw: "平", theoretical_handicap_quarter_units: 2 }],
    ["illegal water", { theoretical_selected_water: "0" }],
  ])("rejects theoretical physical field: %s", async (_name, mutation) => {
    await expect(calculate(fixture(), "theoretical", mutation)).rejects.toMatchObject({ code: "integrity" });
  });

  it("rejects quote hash, cutoff, kickoff, water, and legs are handled by pure output", async () => {
    await expect(calculate(fixture({ quote: { id: 7, company_id: "3", market_type: "asian_handicap", hash_version: "canonical-json-v2", match_id: "m1", match_date: "20260717", source_observed_at: "2026-07-17T11:59:00Z", collected_at: "2026-07-17T12:00:00Z", odds: { handicapLine: "半球", handicapHome: "0.90", handicapAway: "0.98" }, content_hash: "bad", canonical_content_hash: "bad" } }))).rejects.toMatchObject({ code: "integrity" });
    await expect(calculate(fixture({ home: "0", away: "0.98" }))).rejects.toMatchObject({ code: "integrity" });
  });

  it("is stable under 100 deep-equal replays and has no LLM/search dependency", async () => {
    const results = await Promise.all(Array.from({ length: 100 }, () => calculate(fixture())));
    expect(results.every(result => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    const source = await readFile(new URL("../src/features/strategy-lab/postgres-settlement-calculator.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:llm|search|openai)|\bfetch\s*\(/i);
  });
});
