import { describe, expect, it } from "vitest";
import {
  appendAssistantMessage,
  appendUserMessage,
  createBatchAnalysisController,
  runAnalysisBatch,
  runVerificationLearning,
  type AnalysisBatchProgress,
} from "@/features/odds/analysis-orchestrator";

describe("odds analysis orchestration", () => {
  it("runs with bounded concurrency, reports progress, and retains partial successes", async () => {
    let active = 0;
    let maxActive = 0;
    const progress: AnalysisBatchProgress[] = [];
    const resultBatches: string[][] = [];
    const items = ["1", "2", "3", "4"].map(id => ({ id, homeTeam: `主${id}`, awayTeam: `客${id}` }));
    const summary = await runAnalysisBatch({
      items,
      concurrency: 2,
      flushSize: 2,
      controller: createBatchAnalysisController(),
      analyze: async item => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        if (item.id === "2") throw new Error("失败");
        return { matchId: item.id } as never;
      },
      onProgress: value => progress.push(value),
      onResults: values => resultBatches.push([...values.keys()]),
    });
    expect(maxActive).toBe(2);
    expect(summary).toMatchObject({ completed: 4, succeeded: 3, failed: 1, cancelled: false });
    expect(progress.at(-1)).toMatchObject({ current: 4, total: 4, succeeded: 3, failed: 1 });
    expect(resultBatches.flat()).toEqual(expect.arrayContaining(["1", "3", "4"]));
  });

  it("cancels queued work and protects the caller from stale post-cancel results", async () => {
    const controller = createBatchAnalysisController();
    const applied: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const running = runAnalysisBatch({
      items: ["1", "2", "3"].map(id => ({ id, homeTeam: id, awayTeam: id })), concurrency: 1,
      controller,
      analyze: async item => { await gate; return { matchId: item.id } as never; },
      onResults: values => applied.push(...values.keys()),
    });
    controller.cancel();
    release();
    await expect(running).resolves.toMatchObject({ cancelled: true, completed: 1, succeeded: 0 });
    expect(applied).toEqual([]);
  });

  it("stops verification and learning on verify errors without triggering learning", async () => {
    let learned = 0;
    await expect(runVerificationLearning({
      dateKeys: ["20260713", "20260714"],
      syncScores: async () => ({ persistedResults: 1 }),
      verify: async date => {
        if (date === "20260714") throw new Error("自动验证失败");
        return { verified: 2, correct: 1 };
      },
      reloadPredictions: async () => undefined,
      learn: async () => { learned += 1; return { patternsFound: 1 }; },
      refreshStats: async () => undefined,
    })).rejects.toThrow("自动验证失败");
    expect(learned).toBe(0);
  });

  it("aggregates verification and both learning markets", async () => {
    await expect(runVerificationLearning({
      dateKeys: ["20260714"],
      syncScores: async () => ({ persistedResults: 3 }),
      verify: async () => ({ verified: 2, correct: 1 }),
      reloadPredictions: async () => undefined,
      learn: async market => ({ patternsFound: market === "handicap" ? 2 : 4 }),
      refreshStats: async () => undefined,
    })).resolves.toEqual({ synced: 3, verified: 2, correct: 1, learnedPatterns: 6 });
  });

  it("appends user and assistant chat messages without replacing history", () => {
    const initial = [{ role: "assistant" as const, content: "旧回答" }];
    const user = appendUserMessage(initial, " 新问题 ");
    expect(user).toEqual([initial[0], { role: "user", content: "新问题" }]);
    const pending = appendAssistantMessage(user, "");
    expect(appendAssistantMessage(pending, "新回答", true)).toEqual([
      initial[0], { role: "user", content: "新问题" }, { role: "assistant", content: "新回答" },
    ]);
  });
});
