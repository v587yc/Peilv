import { describe, expect, it } from "vitest";
import {
  canApplyDatabaseObservation,
  compareSourceTimestamps,
  enqueueRefreshItem,
  isLatestRefreshResponse,
  isOddsStale,
} from "@/lib/odds-refresh";

describe("refresh response ordering", () => {
  it("rejects an older response", () => {
    expect(isLatestRefreshResponse({
      request: 4,
      latestRequest: 5,
      generation: 2,
      latestGeneration: 2,
    })).toBe(false);
  });

  it("rejects a response from an older generation", () => {
    expect(isLatestRefreshResponse({
      request: 5,
      latestRequest: 5,
      generation: 1,
      latestGeneration: 2,
    })).toBe(false);
  });

  it("accepts only the latest request in the latest generation", () => {
    expect(isLatestRefreshResponse({
      request: 5,
      latestRequest: 5,
      generation: 2,
      latestGeneration: 2,
    })).toBe(true);
  });
});

describe("source observation ordering", () => {
  it("compares source timestamps chronologically", () => {
    expect(compareSourceTimestamps("2026-07-11T10:00:00Z", "2026-07-11T10:00:01Z")).toBe(-1);
    expect(compareSourceTimestamps(1_000, new Date(1_000))).toBe(0);
  });

  it("rejects an older database observation", () => {
    expect(canApplyDatabaseObservation(
      "2026-07-11T10:00:00Z",
      "2026-07-11T10:00:01Z",
    )).toBe(false);
  });

  it("allows a null legacy current database observation to be replaced", () => {
    expect(canApplyDatabaseObservation("2026-07-11T10:00:00Z", null)).toBe(true);
    expect(canApplyDatabaseObservation(null, null)).toBe(true);
  });
});

describe("stale policy", () => {
  it("becomes stale at the 60-second threshold", () => {
    const observedAt = Date.parse("2026-07-11T10:00:00Z");

    expect(isOddsStale(observedAt, observedAt + 59_999)).toBe(false);
    expect(isOddsStale(observedAt, observedAt + 60_000)).toBe(true);
  });
});

describe("refresh queue", () => {
  it("deduplicates a job and promotes its priority deterministically", () => {
    const queue = [
      { key: "a", priority: 1, value: "old a" },
      { key: "b", priority: 2, value: "b" },
    ];

    const result = enqueueRefreshItem(queue, {
      key: "a",
      priority: 3,
      value: "new a",
    });

    expect(result).toEqual([
      { key: "a", priority: 3, value: "new a" },
      { key: "b", priority: 2, value: "b" },
    ]);
    expect(queue).toEqual([
      { key: "a", priority: 1, value: "old a" },
      { key: "b", priority: 2, value: "b" },
    ]);
  });

  it("does not demote a duplicate and preserves equal-priority order", () => {
    const result = enqueueRefreshItem([
      { key: "a", priority: 3, value: "a" },
      { key: "b", priority: 2, value: "b" },
    ], {
      key: "a",
      priority: 1,
      value: "updated a",
    });

    expect(result).toEqual([
      { key: "a", priority: 3, value: "updated a" },
      { key: "b", priority: 2, value: "b" },
    ]);
  });
});
