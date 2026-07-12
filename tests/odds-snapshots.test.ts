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
});
