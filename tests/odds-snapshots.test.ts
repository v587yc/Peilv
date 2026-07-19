import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  MAX_ODDS_QUERY_LIMIT,
  paginationMetadata,
  parseOddsQueryParameters,
} from "@/lib/odds/query";
import { appendOddsSnapshots } from "@/lib/odds/snapshots";

describe("odds snapshot queries", () => {
  it("parses aliases, normalizes timestamps, and caps batch size", () => {
    const parsed = parseOddsQueryParameters(
      "http://localhost/api/data/odds-snapshots?match=100&date=20260710&company=3&market=combined&page=2&limit=999&from=2026-07-10T01:00:00Z",
    );

    expect(parsed).toMatchObject({
      matchId: "100",
      date: "20260710",
      companyId: "3",
      marketType: "combined",
      page: 2,
      limit: MAX_ODDS_QUERY_LIMIT,
      from: "2026-07-10T01:00:00.000Z",
    });
  });

  it("returns complete pagination metadata", () => {
    expect(paginationMetadata(2, 50, 121)).toEqual({
      page: 2,
      limit: 50,
      total: 121,
      totalPages: 3,
      hasNext: true,
      hasPrevious: true,
    });
    expect(paginationMetadata(1, 50, 0).totalPages).toBe(0);
  });
});

describe("odds snapshot persistence", () => {
  it("appends immutable snapshots and matching quality observations", async () => {
    const inserted: Record<string, Record<string, unknown>[]> = {};
    const supabase = {
      from(table: string) {
        return {
          async insert(rows: Record<string, unknown>[]) {
            inserted[table] = rows;
            return { error: null };
          },
        };
      },
    } as unknown as SupabaseClient;

    const result = await appendOddsSnapshots(supabase, {
      matchId: "123",
      matchDate: "20260710",
      source: "collector",
      sourceObservedAt: "2020-01-01T00:00:00.000Z",
      payload: {
        oddsData: {
          matchId: "123",
          companies: [{
            companyId: "3",
            companyName: "皇冠",
            ftHandicapHome: "0.92",
            ftHandicapLine: "半球",
            ftHandicapAway: "0.94",
          }],
        },
        openTimesData: { "3": "2026-07-10 12:00" },
        crown12Odds: { handicapLine: "半球" },
        crownLiveOdds: { totalLine: "2.5" },
      },
    });

    expect(result).toEqual({ snapshots: 8, qualityRecords: 8 });
    expect(inserted.odds_snapshots).toHaveLength(8);
    expect(inserted.data_quality_records).toHaveLength(8);
    expect(inserted.odds_snapshots.map((row) => row.snapshot_type)).toEqual([
      "odds",
      "odds",
      "odds",
      "open_times",
      "crown12",
      "crown12",
      "crown_live",
      "crown_live",
    ]);
    expect(new Set(inserted.odds_snapshots.map((row) => row.idempotency_key)).size).toBe(8);
    expect(inserted.odds_snapshots[0]).toMatchObject({
      hash_version: "canonical-json-v2",
      content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      canonical_content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(inserted.odds_snapshots[0].content_hash).toBe(inserted.odds_snapshots[0].canonical_content_hash);
    expect(inserted.odds_snapshots[0].odds).toMatchObject({
      matchId: "123",
      companies: [{ companyId: "3" }],
    });

    const oddsQuality = inserted.data_quality_records[1];
    expect(oddsQuality.completeness_score).toBeCloseTo(2 / 5);
    expect(oddsQuality.issue_codes).toEqual(["MISSING_FIELDS", "STALE_SOURCE"]);
    expect(oddsQuality.details).toMatchObject({
      matchId: "123",
      companyId: "3",
      marketType: "europe_1x2",
      snapshotType: "odds",
    });
  });

  it("writes canonical content while separate captures of identical content remain distinct", async () => {
    const batches: Record<string, unknown>[][] = [];
    const supabase = { from(table: string) { return { async insert(rows: Record<string, unknown>[]) { if (table === "odds_snapshots") batches.push(rows); return { error: null }; } }; } } as unknown as SupabaseClient;
    const input = { matchId: "same", matchDate: "20260718", sourceObservedAt: "2026-07-18T00:00:00.000Z", payload: { oddsData: { z: "末", companies: [], a: { y: 2, x: "原样中文" } } } };
    await appendOddsSnapshots(supabase, input);
    await appendOddsSnapshots(supabase, input);
    expect(batches).toHaveLength(2);
    expect(batches[0][0].odds).toEqual({ a: { x: "原样中文", y: 2 }, companies: [], z: "末" });
    expect(Object.keys(batches[0][0].odds as object)).toEqual(["a", "companies", "z"]);
    expect(batches[0][0].content_hash).toBe(batches[1][0].content_hash);
    expect(batches[0][0].canonical_content_hash).toBe(batches[1][0].canonical_content_hash);
    expect(batches[0][0].idempotency_key).not.toBe(batches[1][0].idempotency_key);
  });

  it.each([
    ["undefined", undefined], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY],
    ["BigInt", BigInt(1)], ["function", () => undefined], ["symbol", Symbol("private")],
  ])("rejects illegal %s payloads before writes without leaking payload or hashes", async (_label, illegal) => {
    let writes = 0;
    const supabase = { from() { return { async insert() { writes += 1; return { error: null }; } }; } } as unknown as SupabaseClient;
    const secret = "ODDS-PAYLOAD-MUST-NOT-LEAK";
    let error: unknown;
    try { await appendOddsSnapshots(supabase, { matchId: "bad", matchDate: "20260718", payload: { oddsData: { companies: [], secret, illegal } } }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(TypeError);
    expect(writes).toBe(0);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("rejects cyclic and nonplain payloads before writes", async () => {
    const cyclic: Record<string, unknown> = { companies: [] }; cyclic.self = cyclic;
    const supabase = { from() { return { async insert() { throw new Error("must not write"); } }; } } as unknown as SupabaseClient;
    await expect(appendOddsSnapshots(supabase, { matchId: "cycle", matchDate: "20260718", payload: { oddsData: cyclic } })).rejects.toBeInstanceOf(TypeError);
    await expect(appendOddsSnapshots(supabase, { matchId: "date", matchDate: "20260718", payload: { oddsData: { companies: [], bad: new Date() } } })).rejects.toBeInstanceOf(TypeError);
  });
});
