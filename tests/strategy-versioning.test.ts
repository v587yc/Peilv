import { describe, expect, it } from "vitest";
import {
  MIN_LEARNING_SAMPLES,
  predictionAsOf,
  summarizeBenchmark,
  wilsonLowerBound,
} from "@/lib/analysis/strategy";
import { getApiProtection } from "@/lib/api-protection";

describe("strategy versioning safeguards", () => {
  it("uses match time as the backtest as-of point but current time for production", () => {
    expect(predictionAsOf({ source: "backtest", matchDate: "20260102", matchTime: "03:04" }))
      .toBe("2026-01-02T03:04:00.000Z");
    expect(predictionAsOf({ source: "production", matchDate: "20200101" }, new Date("2026-07-10T12:00:00Z")))
      .toBe("2026-07-10T12:00:00.000Z");
  });

  it("requires at least 20 samples and applies a conservative Wilson gate", () => {
    expect(MIN_LEARNING_SAMPLES).toBe(20);
    expect(wilsonLowerBound(12, 20)).toBeLessThan(0.5);
    expect(wilsonLowerBound(18, 20)).toBeGreaterThan(0.5);
  });

  it("reports factual default and published cohorts without return estimates", () => {
    const comparison = summarizeBenchmark([
      { is_correct: true, strategy_version: null },
      { is_correct: false, strategy_version: null },
      { is_correct: true, strategy_version: "strategy-1" },
      { is_correct: true, strategy_version: "strategy-1" },
      { is_correct: null, strategy_version: "strategy-1" },
    ]);
    expect(comparison).toEqual({
      defaultWeights: { samples: 2, correct: 1, accuracy: 0.5 },
      publishedWeights: { samples: 2, correct: 2, accuracy: 1 },
    });
    expect(comparison).not.toHaveProperty("profit");
  });

  it("protects all strategy mutations through the existing proxy policy", () => {
    expect(getApiProtection("/api/strategy", "POST").protected).toBe(true);
    expect(getApiProtection("/api/strategy/v1/publish", "POST").protected).toBe(true);
    expect(getApiProtection("/api/strategy/v1/rollback", "POST").protected).toBe(true);
    expect(getApiProtection("/api/strategy", "GET").protected).toBe(false);
  });
});
