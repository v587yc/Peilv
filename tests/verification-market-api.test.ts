import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  prediction: {} as Record<string, unknown>,
}));

vi.mock("@/storage/database/supabase-client", () => {
  class Query implements PromiseLike<{ data?: unknown; error: { message: string } | null }> {
    private operation: "select" | "update" = "select";
    private updateValue: Record<string, unknown> = {};

    constructor(private readonly table: string) {}
    select() { return this; }
    eq() { return this; }
    update(value: Record<string, unknown>) {
      this.operation = "update";
      this.updateValue = value;
      return this;
    }
    async maybeSingle() {
      return this.table === "prediction_results"
        ? { data: { ...db.prediction }, error: null }
        : { data: null, error: null };
    }
    then<TResult1 = { data?: unknown; error: { message: string } | null }, TResult2 = never>(
      onfulfilled?: ((value: { data?: unknown; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      let data: unknown;
      if (this.table === "user_focused_leagues") {
        data = [{ league_name: "英超" }];
      } else if (this.table === "prediction_results") {
        if (this.operation === "update") Object.assign(db.prediction, this.updateValue);
        data = [{ ...db.prediction }];
      }
      return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
    }
  }

  return { getSupabaseClient: () => ({ from: (table: string) => new Query(table) }) };
});

import { PATCH } from "@/app/api/analysis/verify/route";

function request(body: Record<string, unknown>) {
  return new NextRequest("http://local/api/analysis/verify", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-authenticated-actor-id": "tester" },
    body: JSON.stringify(body),
  });
}

describe("market-scoped manual verification API", () => {
  beforeEach(() => {
    db.prediction = {
      match_id: "match-1",
      match_date: "20260712",
      league: "英超",
      handicap_auto_outcome: "win",
      handicap_auto_is_correct: true,
      handicap_automatic_status: "correct",
      handicap_manual_is_correct: null,
      handicap_effective_is_correct: true,
      handicap_effective_status: "correct",
      total_auto_outcome: "loss",
      total_auto_is_correct: false,
      total_automatic_status: "wrong",
      total_manual_is_correct: null,
      total_effective_is_correct: false,
      total_effective_status: "wrong",
      is_correct: true,
      auto_is_correct: true,
      manual_is_correct: null,
      verification_status: "correct",
    };
  });

  it("requires an explicit market", async () => {
    const response = await PATCH(request({ matchId: "match-1", matchDate: "20260712", isCorrect: true }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "market必须是handicap或total" });
  });

  it("updates total without changing handicap or legacy handicap mirrors", async () => {
    const response = await PATCH(request({
      matchId: "match-1",
      matchDate: "20260712",
      market: "total",
      isCorrect: true,
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      market: "total",
      markets: {
        handicap: { effectiveIsCorrect: true, manualIsCorrect: null },
        total: { effectiveIsCorrect: true, manualIsCorrect: true },
      },
      stats: {
        markets: {
          handicap: { weightedCorrect: 1, weightedWrong: 0, weightedTotal: 1 },
          total: { weightedCorrect: 1, weightedWrong: 0, weightedTotal: 1 },
        },
      },
    });
    expect(db.prediction).toMatchObject({
      total_manual_is_correct: true,
      total_effective_is_correct: true,
      handicap_manual_is_correct: null,
      handicap_effective_is_correct: true,
      manual_is_correct: null,
      is_correct: true,
    });
  });

  it("withdraws one market and restores its automatic result", async () => {
    await PATCH(request({
      matchId: "match-1",
      matchDate: "20260712",
      market: "total",
      isCorrect: true,
    }));
    const response = await PATCH(request({
      matchId: "match-1",
      matchDate: "20260712",
      market: "total",
      isCorrect: null,
    }));
    const payload = await response.json();

    expect(payload.markets.total).toMatchObject({
      manualIsCorrect: null,
      autoIsCorrect: false,
      effectiveIsCorrect: false,
      effectiveStatus: "wrong",
    });
    expect(payload.markets.handicap).toMatchObject({
      manualIsCorrect: null,
      effectiveIsCorrect: true,
    });
    expect(payload.stats.markets.total).toMatchObject({
      weightedCorrect: 0,
      weightedWrong: 1,
      weightedTotal: 1,
    });
  });
});
