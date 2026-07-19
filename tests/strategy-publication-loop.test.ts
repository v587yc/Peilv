import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const store = vi.hoisted(() => ({
  strategies: [] as Record<string, unknown>[],
  patterns: [] as Record<string, unknown>[],
}));

vi.mock("@/storage/database/supabase-client", () => {
  class Query implements PromiseLike<{ data?: unknown; error: { message: string } | null }> {
    private filters = new Map<string, unknown>();
    private operation: "select" | "update" = "select";
    private changes: Record<string, unknown> = {};

    constructor(private readonly table: string) {}

    select() { return this; }
    in(column: string, values: unknown[]) { this.filters.set(column, values); return this; }
    lte() { return this; }
    or() { return this; }
    order() { return this; }
    limit() { return this; }
    eq(column: string, value: unknown) { this.filters.set(column, value); return this; }
    update(changes: Record<string, unknown>) { this.operation = "update"; this.changes = changes; return this; }

    private rows() {
      const source = this.table === "strategy_versions" ? store.strategies : store.patterns;
      return source.filter(row => [...this.filters].every(([column, expected]) =>
        Array.isArray(expected) ? expected.includes(row[column]) : row[column] === expected));
    }

    private apply() {
      const rows = this.rows();
      if (this.operation === "update") rows.forEach(row => Object.assign(row, this.changes));
      return rows;
    }

    async maybeSingle() {
      const rows = this.apply();
      const published = this.operation === "select" && this.filters.size === 0
        ? store.strategies.filter(row => row.status === "published")
        : rows;
      return { data: published.at(-1) || null, error: null };
    }

    then<TResult1 = { data?: unknown; error: { message: string } | null }, TResult2 = never>(
      onfulfilled?: ((value: { data?: unknown; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve({ data: this.apply(), error: null }).then(onfulfilled, onrejected);
    }
  }

  return { getSupabaseClient: () => ({ from: (table: string) => new Query(table) }) };
});

import { GET as getStrategy } from "@/app/api/strategy/route";
import { POST as publishStrategy } from "@/app/api/strategy/[version]/publish/route";

describe("T-08 dynamic weights and strategy publication loop", () => {
  beforeEach(() => {
    store.strategies = [
      {
        version: "strategy-old",
        status: "published",
        weights: { indicator_water_direction: 1 },
        rules: {},
        model_version: "model-old",
        effective_from: "2026-01-01T00:00:00.000Z",
        published_at: "2026-01-01T00:00:00.000Z",
        retired_at: null,
      },
      {
        version: "strategy-learned",
        status: "draft",
        weights: {
          indicator_handicap_direction: 0.1,
          indicator_water_direction: 0.5,
          indicator_divergence: 0.1,
          indicator_euro_asian: 0.1,
          indicator_open_time: 0.1,
          indicator_total_goals: 0.1,
        },
        rules: { confidenceGate: "wilson-95-lower>=0.5" },
        model_version: "model-learned",
      },
    ];
    store.patterns = [
      { pattern_key: "old", strategy_version: "strategy-old", status: "published" },
      { pattern_key: "new", strategy_version: "strategy-learned", status: "draft" },
    ];
  });

  it("retires the legacy publication entry without mutating strategy state", async () => {
    const effectiveFrom = "2026-07-10T00:00:00.000Z";
    const publishResponse = await publishStrategy(new NextRequest("http://local/api/strategy/strategy-learned/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ effectiveFrom }),
    }), { params: Promise.resolve({ version: "strategy-learned" }) });

    expect(publishResponse.status).toBe(410);
    expect(store.strategies[0]).toMatchObject({ status: "published" });
    expect(store.strategies[1]).toMatchObject({ status: "draft" });
    expect(store.patterns).toEqual([
      expect.objectContaining({ status: "published" }),
      expect.objectContaining({ status: "draft" }),
    ]);

    const loadResponse = await getStrategy(new NextRequest(
      "http://local/api/strategy?asOf=2026-07-11T00:00:00.000Z",
    ));
    const payload = await loadResponse.json();
    expect(payload.strategy).toMatchObject({
      strategyVersion: "strategy-old",
      weightsVersion: "strategy-old:weights",
      modelVersion: "model-old",
    });
    expect(payload.strategy.weights.indicator_water_direction).toBeCloseTo(10 / 17, 10);
  });
});
