import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  learnedWeights: {
    indicator_handicap_direction: 2,
    indicator_water_direction: -1,
    indicator_divergence: "0.2",
    indicator_euro_asian: "invalid",
    indicator_open_time: 0,
    indicator_total_goals: 0.5,
  },
  upserts: [] as Record<string, unknown>[],
  upsertTables: [] as string[],
  enqueueT30: vi.fn<(repository: unknown, metadata: Record<string, unknown>) => Promise<null>>(async () => null),
  predictionSaveError: null as { message: string } | null,
}));

vi.mock("@/lib/llm", () => ({
  webSearch: vi.fn(async () => []),
  llmInvoke: vi.fn(async () => ({
    content: JSON.stringify({
      waterDirection: "主降水",
      totalTrend: "大球降水",
      totalPrediction: "大",
      confidenceLevel: "低",
      accuracy: "50%",
      probability: {
        quality: "available",
        modelVersion: "llm-forged-model",
        markets: { handicap: { probabilities: { win: 1 } } },
      },
      expectedValue: 999,
      strategy: "test",
      action: "test",
      totalAction: "test",
      reasoning: "test",
    }),
  })),
}));

vi.mock("@/lib/integrations/feishu/notifier", () => ({
  sendFeishuAIAnalysis: vi.fn(async () => undefined),
}));

vi.mock("@/lib/automation/match-t30-task", () => ({
  upsertMatchT30Task: mocks.enqueueT30,
}));

vi.mock("@/storage/database/supabase-client", () => {
  class Query implements PromiseLike<{ data?: unknown; count?: number; error?: { message: string } | null }> {
    constructor(private readonly table: string) {}

    select() { return this; }
    eq() { return this; }
    in() { return this; }
    gte() { return this; }
    lte() { return this; }
    or() { return this; }
    not() { return this; }
    order() { return this; }
    limit() { return this; }
    upsert(value: Record<string, unknown>) { mocks.upserts.push(value); mocks.upsertTables.push(this.table); return this; }

    async maybeSingle() {
      if (this.table === "strategy_versions") {
        return {
          data: {
            version: "strategy-test",
            weights: mocks.learnedWeights,
            rules: {},
            model_version: "model-test",
          },
          error: null,
        };
      }
      return { data: null, error: null };
    }

    then<TResult1 = { data?: unknown; count?: number; error?: { message: string } | null }, TResult2 = never>(
      onfulfilled?: ((value: { data?: unknown; count?: number; error?: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      const result = this.table === "learned_patterns"
        ? { data: [], error: null as null }
        : this.table === "prediction_results" || this.table === "prediction_results_backtest"
          ? { count: 0, error: mocks.predictionSaveError }
          : { error: null as null };
      return Promise.resolve(result).then(onfulfilled, onrejected);
    }
  }

  return {
    getSupabaseClient: () => ({
      from: (table: string) => new Query(table),
    }),
  };
});

import { POST } from "@/app/api/analysis/route";

describe("learned indicator weights", () => {
  beforeEach(() => {
    mocks.upserts = [];
    mocks.upsertTables = [];
    mocks.enqueueT30.mockReset();
    mocks.enqueueT30.mockResolvedValue(null);
    mocks.predictionSaveError = null;
    process.env.INTERNAL_API_SECRET = "Test_Internal_Secret_0123456789AB";
  });

  it("clamps invalid values and normalizes all indicator weights", async () => {
    const request = new Request("https://app.invalid/api/analysis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchId: "match-1",
        homeTeam: "Home",
        awayTeam: "Away",
        league: "Test League",
        matchTime: "12:00",
        matchDate: "20260710",
        scheduleMode: "history",
        companies: [],
      }),
    });

    const response = await POST(request as never);
    const payload = await response.json();
    const weights = Object.fromEntries(
      payload.data.indicators.map((indicator: { name: string; weight: number }) => [indicator.name, indicator.weight]),
    ) as Record<string, number>;

    expect(response.status).toBe(200);
    expect(Object.values(weights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 10);
    expect(weights["盘口变化方向"]).toBeCloseTo(1 / 2.2, 10);
    expect(weights["水位变化方向"]).toBeCloseTo(0.3 / 2.2, 10);
    expect(weights["公司分歧度"]).toBeCloseTo(0.2 / 2.2, 10);
    expect(weights["欧亚偏差"]).toBeCloseTo(0.2 / 2.2, 10);
    expect(weights["开盘时间早晚"]).toBe(0);
    expect(weights["大小球趋势"]).toBeCloseTo(0.5 / 2.2, 10);
    expect(mocks.upsertTables.at(-1)).toBe("prediction_results");
    expect(mocks.upserts.at(-1)).toMatchObject({
      strategy_version: "strategy-test",
      weights_version: "strategy-test:weights",
      model_version: "model-test",
    });
    expect(mocks.upserts.at(-1)?.weights_snapshot).toEqual(expect.objectContaining({ indicator_water_direction: 0.3 / 2.2 }));
    expect(mocks.enqueueT30).toHaveBeenCalledOnce();
    expect(mocks.enqueueT30.mock.calls[0]?.[1]).toMatchObject({
      matchId: "match-1",
      matchDate: "20260710",
      matchTime: "12:00",
      homeTeam: "Home",
      awayTeam: "Away",
      league: "Test League",
      scheduleMode: "history",
    });
  });

  it("ignores LLM-supplied probability fields and persists only server calculations", async () => {
    const sourceObservedAt = "2026-07-12T10:15:00.000Z";
    const response = await POST(new Request("https://app.invalid/api/analysis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchId: "match-probability",
        homeTeam: "Home",
        awayTeam: "Away",
        league: "Test League",
        matchTime: "18:00",
        matchDate: "20260712",
        scheduleMode: "today",
        sourceObservedAt,
        companies: [{
          companyId: "3",
          companyName: "Crown",
          openTime: "10:00",
          asianHomeInit: "0.94",
          asianLineInit: "0.25",
          asianAwayInit: "0.96",
          euroAsianHomeInit: "",
          euroAsianLineInit: "",
          euroAsianAwayInit: "",
          totalOverInit: "0.90",
          totalLineInit: "2.75",
          totalUnderInit: "1.00",
          asianHomeLive: "",
          asianLineLive: "",
          asianAwayLive: "",
          euroHomeInit: "2.00",
          euroDrawInit: "3.40",
          euroAwayInit: "4.00",
        }],
        crown12Handicap: { home: "0.94", line: "0.25", away: "0.96" },
        crown12Total: { over: "0.90", line: "2.75", under: "1.00" },
      }),
    }) as never);
    const payload = await response.json();
    const saved = mocks.upserts.find(value => value.match_id === "match-probability");

    expect(response.status).toBe(200);
    expect(payload.data.probability).toMatchObject({
      quality: "uncalibrated",
      modelVersion: "market-poisson-v1",
      calibrationVersion: null,
      sourceObservedAt,
      companyCount: 1,
      markets: {
        handicap: { line: 0.25, selection: "home" },
        total: { line: 2.75, selection: "over" },
      },
    });
    expect(payload.data.probability.markets.handicap.probabilities.win).toBeLessThan(1);
    expect(JSON.stringify(payload.data.probability)).not.toContain("llm-forged-model");
    expect(payload.data).not.toHaveProperty("expectedValue");
    expect(payload.data.probability).not.toHaveProperty("expectedValue");
    expect(saved).toMatchObject({
      probability_output: payload.data.probability,
      probability_model_version: "market-poisson-v1",
      probability_calibration_version: null,
      probability_source_observed_at: sourceObservedAt,
      probability_quality_status: "uncalibrated",
    });
  });

  it("keeps a saved production analysis successful when T-30 enqueue fails", async () => {
    mocks.enqueueT30.mockRejectedValueOnce(new Error("task database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(new Request("https://app.invalid/api/analysis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchId: "match-enqueue-failure",
        homeTeam: "Home",
        awayTeam: "Away",
        league: "Test League",
        matchTime: "18:00",
        matchDate: "20260710",
        scheduleMode: "history",
        companies: [],
      }),
    }) as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(mocks.upsertTables).toContain("prediction_results");
    expect(consoleError).toHaveBeenCalledWith(
      "[Analysis] T-30 task enqueue failed:",
      expect.objectContaining({ matchId: "match-enqueue-failure", matchDate: "20260710" }),
    );
    consoleError.mockRestore();
  });

  it("does not enqueue when prediction persistence fails", async () => {
    mocks.predictionSaveError = { message: "prediction write failed" };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(new Request("https://app.invalid/api/analysis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        matchId: "match-save-failure",
        homeTeam: "Home",
        awayTeam: "Away",
        league: "Test League",
        matchTime: "18:00",
        matchDate: "20260710",
        scheduleMode: "history",
        companies: [],
      }),
    }) as never);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: "分析完成但保存预测失败" });
    expect(mocks.enqueueT30).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("rejects direct internal backtest access at the public analysis boundary", async () => {
    const response = await POST(new Request("https://app.invalid/api/analysis", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-api-secret": "Test_Internal_Secret_0123456789AB",
      },
      body: JSON.stringify({
        matchId: "backtest-match",
        homeTeam: "Home",
        awayTeam: "Away",
        league: "Test League",
        matchTime: "12:00",
        matchDate: "20260710",
        scheduleMode: "history",
        source: "backtest",
        runId: "run-isolated",
        companies: [],
      }),
    }) as never);

    expect(response.status).toBe(403);
    expect(mocks.upsertTables).not.toContain("prediction_results_backtest");
    expect(mocks.upsertTables).not.toContain("prediction_results");
    expect(mocks.upsertTables).not.toContain("learned_patterns");
    expect(mocks.enqueueT30).not.toHaveBeenCalled();
  });
});
