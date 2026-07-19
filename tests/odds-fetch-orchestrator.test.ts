import { describe, expect, it, vi } from "vitest";
import {
  createOddsFetchCoordinator,
  type OddsFetchSourceResult,
} from "@/features/odds/odds-fetch-orchestrator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

const sourceResult = (matchId: string, marker: string): OddsFetchSourceResult => ({
  data: { matchId, openTime: "", companies: [], marker },
  source: "titan-analysis-odds",
  sourceObservedAt: `2026-07-14T04:00:0${marker}.000Z`,
});

describe("odds fetch coordinator", () => {
  it("rejects an older response and its database write after a newer request wins", async () => {
    const first = deferred<OddsFetchSourceResult>();
    const second = deferred<OddsFetchSourceResult>();
    const applied: string[] = [];
    const persisted: string[] = [];
    let calls = 0;
    const coordinator = createOddsFetchCoordinator({
      fetchMatch: () => (++calls === 1 ? first.promise : second.promise),
      persistMatch: async ({ oddsData }) => {
        persisted.push(String(oddsData.marker));
        return { applied: true };
      },
      onApplyMatch: ({ data }) => { applied.push(String(data.marker)); },
    });

    const older = coordinator.fetchMatch("m1", 1, { matchDate: "20260714", companyIds: ["3"] });
    const newer = coordinator.fetchMatch("m1", 1, { matchDate: "20260714", companyIds: ["3"] });
    second.resolve(sourceResult("m1", "2"));
    await expect(newer).resolves.toBe(true);
    first.resolve(sourceResult("m1", "1"));
    await expect(older).resolves.toBe(false);

    expect(applied).toEqual(["2"]);
    expect(persisted).toEqual(["2"]);
    expect(coordinator.getPersistedVersion("m1")).toBe(2);
  });

  it("does not let an older generation invalidate an active current-generation request", async () => {
    const currentResult = deferred<OddsFetchSourceResult>();
    const applied: string[] = [];
    const persisted: string[] = [];
    const fetchSource = vi.fn()
      .mockImplementationOnce(() => currentResult.promise)
      .mockImplementationOnce(async () => sourceResult("m1", "stale"));
    const coordinator = createOddsFetchCoordinator({
      fetchMatch: fetchSource,
      persistMatch: async ({ oddsData }) => {
        persisted.push(String(oddsData.marker));
        return { applied: true };
      },
      onApplyMatch: ({ data }) => { applied.push(String(data.marker)); },
    });
    coordinator.setGeneration(7);

    const current = coordinator.fetchMatch("m1", 7, { matchDate: "20260714", companyIds: ["3"] });
    const stale = coordinator.fetchMatch("m1", 6, { matchDate: "20260714", companyIds: ["3"] });
    currentResult.resolve(sourceResult("m1", "current"));

    await expect(stale).resolves.toBe(false);
    await expect(current).resolves.toBe(true);
    expect(fetchSource).toHaveBeenCalledTimes(1);
    expect(applied).toEqual(["current"]);
    expect(persisted).toEqual(["current"]);
  });

  it("does not persist when a newer request starts during the older UI apply", async () => {
    const releaseApply = deferred<void>();
    const first = deferred<OddsFetchSourceResult>();
    const persisted: string[] = [];
    let calls = 0;
    const coordinator = createOddsFetchCoordinator({
      fetchMatch: async (matchId) => {
        calls += 1;
        return calls === 1 ? first.promise : sourceResult(matchId, "2");
      },
      persistMatch: async ({ oddsData }) => {
        persisted.push(String(oddsData.marker));
        return { applied: true };
      },
      onApplyMatch: async ({ data }) => {
        if (data.marker === "1") await releaseApply.promise;
      },
    });

    const older = coordinator.fetchMatch("m1", 1, { matchDate: "20260714", companyIds: ["3"] });
    first.resolve(sourceResult("m1", "1"));
    await Promise.resolve();
    const newer = coordinator.fetchMatch("m1", 1, { matchDate: "20260714", companyIds: ["3"] });
    releaseApply.resolve();

    await expect(older).resolves.toBe(false);
    await expect(newer).resolves.toBe(true);
    expect(persisted).toEqual(["2"]);
  });

  it("accepts a partial source response and preserves exact persistence payload ordering", async () => {
    const events: string[] = [];
    const coordinator = createOddsFetchCoordinator({
      fetchMatch: async () => ({
        data: { matchId: "m1", companies: [] },
        source: "titan-analysis-odds",
        sourceObservedAt: "2026-07-14T04:00:00.000Z",
      }),
      persistMatch: async (request) => {
        events.push(`persist:${request.matchId}:${request.matchDate}:${request.companyIds}:${request.writeToken.split(":").slice(0, 3).join(":")}`);
        return { applied: true, sourceObservedAt: request.sourceObservedAt };
      },
      onApplyMatch: () => { events.push("apply"); },
      now: () => 123,
    });

    await expect(coordinator.fetchMatch("m1", 7, {
      matchDate: "20260714",
      companyIds: ["3", "8"],
    })).resolves.toBe(true);

    expect(events).toEqual([
      "apply",
      "persist:m1:20260714:3,8:7:1:m1",
    ]);
    expect(coordinator.getPersistedVersion("m1")).toBe(1);
  });

  it("stops a bulk run after abort while retaining completed progress", async () => {
    const controller = new AbortController();
    const fetched: string[] = [];
    const progress: Array<{ done: number; total: number; phase: string }> = [];
    const coordinator = createOddsFetchCoordinator({
      fetchMatch: async (matchId) => {
        fetched.push(matchId);
        if (matchId === "m1") controller.abort();
        return sourceResult(matchId, "1");
      },
      persistMatch: async () => ({ applied: true }),
      onApplyMatch: () => undefined,
      delay: async () => undefined,
    });

    await coordinator.runBulk({
      matchIds: ["m1", "m2"],
      generation: 1,
      signal: controller.signal,
      contextFor: () => ({ matchDate: "20260714", companyIds: ["3"] }),
      onProgress: (value) => progress.push(value),
    });

    expect(fetched).toEqual(["m1"]);
    expect(progress).toEqual([
      { done: 0, total: 2, phase: "刷新最新赔率" },
      { done: 1, total: 2, phase: "刷新最新赔率" },
    ]);
  });

  it("normalizes per-match failures and continues progress", async () => {
    const failures: Array<[string, string]> = [];
    const progress = vi.fn();
    const coordinator = createOddsFetchCoordinator({
      fetchMatch: async (matchId) => {
        if (matchId === "m1") throw "bad gateway";
        return sourceResult(matchId, "2");
      },
      persistMatch: async () => ({ applied: true }),
      onApplyMatch: () => undefined,
      onFailure: (matchId, message) => failures.push([matchId, message]),
      delay: async () => undefined,
    });

    await coordinator.runBulk({
      matchIds: ["m1", "m2"],
      generation: 1,
      contextFor: () => ({ matchDate: "20260714", companyIds: ["3"] }),
      onProgress: progress,
    });

    expect(failures).toEqual([["m1", "抓取失败"]]);
    expect(progress).toHaveBeenLastCalledWith({ done: 2, total: 2, phase: "刷新最新赔率" });
  });
});
