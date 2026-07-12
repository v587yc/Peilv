import { describe, expect, it } from "vitest";
import {
  getBacktestLimits,
  parseDateKey,
  validateBacktestInput,
} from "@/lib/backtest/limits";

describe("backtest limits", () => {
  const limits = {
    maxDateRangeDays: 3,
    maxMatches: 10,
    maxConcurrentJobs: 2,
    timeoutMs: 1000,
  };

  it("validates calendar dates and builds an inclusive UTC date range", () => {
    expect(parseDateKey("20260229")).toBeNull();
    expect(validateBacktestInput({
      startDate: "20260227",
      endDate: "20260301",
      maxMatches: 5,
    }, limits)).toEqual({
      startDate: "20260227",
      endDate: "20260301",
      maxMatches: 5,
      dates: ["20260227", "20260228", "20260301"],
    });
  });

  it("rejects reversed or oversized ranges and invalid maxMatches", () => {
    expect(() => validateBacktestInput({ startDate: "20260302", endDate: "20260301", maxMatches: 1 }, limits))
      .toThrow("startDate must not be after endDate");
    expect(() => validateBacktestInput({ startDate: "20260301", endDate: "20260304", maxMatches: 1 }, limits))
      .toThrow("date range exceeds 3 days");
    expect(() => validateBacktestInput({ startDate: "20260301", endDate: "20260301", maxMatches: 11 }, limits))
      .toThrow("maxMatches must be an integer between 1 and 10");
  });

  it("loads positive integer limits and falls back for invalid values", () => {
    const loaded = getBacktestLimits({
      NODE_ENV: "test",
      BACKTEST_MAX_DATE_RANGE_DAYS: "7",
      BACKTEST_MAX_MATCHES: "bad",
      BACKTEST_MAX_CONCURRENT_JOBS: "4",
      BACKTEST_JOB_TIMEOUT_MS: "2500",
    } as NodeJS.ProcessEnv);
    expect(loaded.maxDateRangeDays).toBe(7);
    expect(loaded.maxMatches).toBe(500);
    expect(loaded.maxConcurrentJobs).toBe(4);
    expect(loaded.timeoutMs).toBe(2500);
  });
});
