import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  predictions: [] as Record<string, unknown>[],
  patternUpserts: [] as Array<{ value: Record<string, unknown>; onConflict?: string }>,
  strategyInserts: [] as Record<string, unknown>[],
}));

vi.mock("@/app/api/feishu/_helpers", () => ({
  sendFeishuVerifyResult: vi.fn(async () => undefined),
}));

vi.mock("@/storage/database/supabase-client", () => {
  class Query implements PromiseLike<{ data?: unknown; error: { message: string } | null }> {
    private operation: "select" | "insert" | "upsert" = "select";
    private value: Record<string, unknown> = {};
    private options: { onConflict?: string } = {};

    constructor(private readonly table: string) {}
    select() { return this; }
    eq() { return this; }
    gte() { return this; }
    lte() { return this; }
    in() { return this; }
    order() { return this; }
    limit() { return this; }
    insert(value: Record<string, unknown>) {
      this.operation = "insert";
      this.value = value;
      db.strategyInserts.push(value);
      return this;
    }
    upsert(value: Record<string, unknown>, options?: { onConflict?: string }) {
      this.operation = "upsert";
      this.value = value;
      this.options = options || {};
      db.patternUpserts.push({ value, onConflict: this.options.onConflict });
      return this;
    }
    then<TResult1 = { data?: unknown; error: { message: string } | null }, TResult2 = never>(
      onfulfilled?: ((value: { data?: unknown; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      const data = this.operation === "select"
        ? this.table === "prediction_results"
          ? db.predictions
          : this.table === "user_focused_leagues"
            ? [{ league_name: "英超" }]
            : []
        : undefined;
      return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
    }
  }
  return { getSupabaseClient: () => ({ from: (table: string) => new Query(table) }) };
});

import { POST } from "@/app/api/analysis/learn/route";

function halfWinPrediction(index: number) {
  return {
    match_id: `match-${index}`,
    match_date: "20260709",
    league: "英超",
    total_auto_outcome: "half_win",
    total_manual_is_correct: null,
    indicator_handicap_direction: "主降水",
    indicator_water_direction: "主降水",
    indicator_divergence: "主降水",
    indicator_euro_asian: "主降水",
    indicator_open_time: "主降水",
    indicator_total_goals: "主降水",
  };
}

describe("market-scoped weighted learning", () => {
  beforeEach(() => {
    db.predictions = Array.from({ length: 40 }, (_, index) => halfWinPrediction(index));
    db.patternUpserts = [];
    db.strategyInserts = [];
  });

  it("requires an explicit market", async () => {
    const response = await POST(new NextRequest("http://local/api/analysis/learn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ league: "ALL" }),
    }));
    expect(response.status).toBe(400);
  });

  it("learns half wins as 0.5 samples and scopes every pattern to total", async () => {
    const response = await POST(new NextRequest("http://local/api/analysis/learn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ market: "total", league: "ALL", minSamples: 20 }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      market: "total",
      totalPredictions: 20,
      totalCorrect: 20,
      overallAccuracy: "100.0%",
      summary: { eligible: 40, weightedCorrect: 20, weightedTotal: 20 },
    });
    expect(db.strategyInserts[0]).toMatchObject({ rules: expect.objectContaining({ market: "total" }) });
    expect(db.patternUpserts.length).toBeGreaterThan(0);
    expect(db.patternUpserts.every(({ value, onConflict }) => value.market === "total" && onConflict === "market,pattern_key,league")).toBe(true);
    expect(db.patternUpserts[0].value).toMatchObject({ total_predictions: 20, correct_predictions: 20 });
  });
});
