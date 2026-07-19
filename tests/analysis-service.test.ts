import { describe, expect, it, vi } from "vitest";
import { analyzeMatch, type AnalysisDependencies } from "@/features/analysis/analysis-service";
import { createLlmAnalyzer } from "@/features/analysis/llm-analysis-service";
import type { AnalysisRequest } from "@/features/analysis/contracts";
import { DEFAULT_INDICATOR_WEIGHTS } from "@/lib/analysis/strategy";

const request: AnalysisRequest = {
  matchId: "match-1",
  homeTeam: "主队",
  awayTeam: "客队",
  league: "测试联赛",
  matchTime: "18:00",
  matchDate: "20260714",
  scheduleMode: "history",
  companies: [],
};

function dependencies(overrides: Partial<AnalysisDependencies> = {}): AnalysisDependencies {
  return {
    strategyRepository: {
      load: vi.fn(async () => ({ strategy: null, weights: { ...DEFAULT_INDICATOR_WEIGHTS }, learnedContext: "" })),
    },
    analysisRepository: {
      save: vi.fn(async () => ({})),
    },
    newsSearch: vi.fn(async () => "未搜到相关新闻"),
    llmAnalyzer: vi.fn(async () => ({
      waterDirection: "主降水",
      handicapTrend: "升盘",
      prediction: "主",
      totalTrend: "大球降水",
      totalPrediction: "大",
      confidenceLevel: "中",
      accuracy: "68%",
      strategy: "主水持续下降",
      action: "0/0.5 主水 主",
      totalAction: "2.5 大",
      reasoning: "测试推理",
    })),
    enqueueT30: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    clock: () => new Date("2026-07-14T10:00:00.000Z"),
    logger: { error: vi.fn() },
    ...overrides,
  };
}

describe("analysis application service", () => {
  it("maps an empty-news analysis to the compatible rich result", async () => {
    const deps = dependencies({ newsSearch: vi.fn(async () => "未搜到相关新闻") });
    const result = await analyzeMatch(request, deps);

    expect(result).toMatchObject({
      matchId: "match-1",
      analyzedAt: "2026-07-14T10:00:00.000Z",
      newsSummary: "未搜到相关新闻",
      water_direction: "主降水",
      prediction: "主",
      confidence_level: "中",
      total_prediction: "大",
      llmPrediction: { reasoning: "测试推理" },
      priorityRules: { matched: [], topPriority: null },
    });
    expect(result.indicators).toHaveLength(6);
    expect(result).toHaveProperty("probability");
  });

  it("uses the news-search fallback without skipping LLM analysis", async () => {
    const newsSearch = vi.fn(async () => "新闻搜索失败");
    const llmAnalyzer = vi.fn(dependencies().llmAnalyzer);
    await analyzeMatch(request, dependencies({ newsSearch, llmAnalyzer }));
    expect(llmAnalyzer).toHaveBeenCalledWith(expect.objectContaining({ newsSummary: "新闻搜索失败" }));
  });

  it("falls back to rules when the real LLM adapter fails", async () => {
    const logError = vi.fn();
    const llmAnalyzer = createLlmAnalyzer(
      vi.fn(async () => { throw new Error("LLM unavailable"); }),
      logError,
    );

    const result = await analyzeMatch(request, dependencies({ llmAnalyzer }));

    expect(result).toMatchObject({
      matchId: "match-1",
      prediction: "中立",
      confidence_level: "低",
      llmPrediction: {
        strategy: "LLM调用失败(LLM unavailable)，规则引擎兜底",
      },
    });
    expect(logError).toHaveBeenCalledWith("[Analysis] LLM error: LLM unavailable");
  });

  it("propagates an injected LLM analyzer failure", async () => {
    await expect(analyzeMatch(request, dependencies({
      llmAnalyzer: vi.fn(async () => { throw new Error("LLM unavailable"); }),
    }))).rejects.toThrow("LLM unavailable");
  });

  it("uses published strategy context and otherwise keeps default weights", async () => {
    const published = dependencies();
    published.strategyRepository.load = vi.fn(async () => ({
      strategy: { strategyVersion: "strategy-v2", weightsVersion: "strategy-v2:weights", modelVersion: "model-v2", weights: { ...DEFAULT_INDICATOR_WEIGHTS }, rules: {} },
      weights: { ...DEFAULT_INDICATOR_WEIGHTS, indicator_water_direction: 0.5 },
      learnedContext: "已发布策略 strategy-v2",
    }));
    await analyzeMatch(request, published);
    expect(published.llmAnalyzer).toHaveBeenCalledWith(expect.objectContaining({ learnedContext: "已发布策略 strategy-v2" }));
    expect(published.analysisRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      strategy: expect.objectContaining({ strategyVersion: "strategy-v2" }),
    }));

    const defaults = dependencies();
    await analyzeMatch(request, defaults);
    expect(defaults.analysisRepository.save).toHaveBeenCalledWith(expect.objectContaining({ strategy: null }));
  });

  it("propagates persistence failure and does not enqueue or notify", async () => {
    const deps = dependencies({
      analysisRepository: { save: vi.fn(async () => { throw new Error("prediction write failed"); }) },
    });
    await expect(analyzeMatch(request, deps)).rejects.toThrow("prediction write failed");
    expect(deps.enqueueT30).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("persists before enqueue and treats notification as non-blocking", async () => {
    const notify = vi.fn(async () => { throw new Error("webhook unavailable"); });
    const deps = dependencies({ notify });
    await expect(analyzeMatch(request, deps)).resolves.toMatchObject({ matchId: "match-1" });
    expect(deps.analysisRepository.save).toHaveBeenCalledOnce();
    expect(deps.enqueueT30).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
  });
});
