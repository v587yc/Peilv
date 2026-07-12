import { describe, expect, it } from "vitest";
import {
  aggregateBinary,
  aggregateMarket,
  aggregateOneXTwo,
  aggregateOneXTwoOdds,
  createScoreDistribution,
  decimalToNetOdds,
  devigBinary,
  devigOneXTwo,
  expectedValue,
  finalizeAnalysisProbability,
  fitPoissonModel,
  prepareAnalysisProbability,
  probabilitySum,
  recommendCandidate,
  type ScoreDistribution,
} from "./index";

const closeToOne = (value: number) => expect(value).toBeCloseTo(1, 10);

function oneCell(homeGoals: number, awayGoals: number): ScoreDistribution {
  return { maxGoals: Math.max(homeGoals, awayGoals), matrixProbability: 1, tailProbability: 0, cells: [{ homeGoals, awayGoals, probability: 1 }] };
}

describe("odds de-vigging", () => {
  it("conserves probability for 1X2 and binary odds", () => {
    const oneXTwo = devigOneXTwo({ home: 2, draw: 3.5, away: 4 });
    const binary = devigBinary({ first: 1.9, second: 2.05 });
    closeToOne(oneXTwo.value!.home + oneXTwo.value!.draw + oneXTwo.value!.away);
    closeToOne(binary.value!.first + binary.value!.second);
  });

  it("rejects non-positive and non-finite odds without probabilities", () => {
    expect(devigOneXTwo({ home: 0, draw: 3, away: 4 })).toMatchObject({ quality: "invalid_odds", value: null });
    expect(devigBinary({ first: Number.POSITIVE_INFINITY, second: 2 })).toMatchObject({ quality: "invalid_odds", value: null });
  });

  it("aggregates companies by median and does not invent missing companies", () => {
    const result = aggregateOneXTwoOdds([
      { home: 2, draw: 3, away: 4 },
      { home: 2.1, draw: 3.1, away: 3.8 },
      { home: 9, draw: 9, away: 1.1 },
    ]);
    closeToOne(result.value!.home + result.value!.draw + result.value!.away);
    expect(aggregateBinary([])).toMatchObject({ quality: "insufficient_data", value: null });
  });
});

describe("Poisson score distribution and market aggregation", () => {
  it("conserves score-matrix probability and explicitly reports its tail", () => {
    const result = createScoreDistribution(1.6, 1.1, 12);
    expect(result.quality).toBe("available");
    closeToOne(result.value!.cells.reduce((sum, cell) => sum + cell.probability, 0));
    expect(result.value!.matrixProbability + result.value!.tailProbability).toBeCloseTo(1, 12);
    expect(result.value!.tailProbability).toBeGreaterThanOrEqual(0);
  });

  it("keeps 1X2, total-goals, and goal-difference aggregation internally consistent", () => {
    const distribution = createScoreDistribution(1.5, 1.0, 12).value!;
    const oneXTwo = aggregateOneXTwo(distribution);
    const homeZero = aggregateMarket(distribution, "handicap", 0, "home");
    const overTwo = aggregateMarket(distribution, "total", 2, "over");
    closeToOne(oneXTwo.home + oneXTwo.draw + oneXTwo.away);
    expect(homeZero.win).toBeCloseTo(oneXTwo.home, 12);
    expect(homeZero.push).toBeCloseTo(oneXTwo.draw, 12);
    expect(homeZero.loss).toBeCloseTo(oneXTwo.away, 12);
    closeToOne(probabilitySum(overTwo));
    expect(overTwo.push).toBeCloseTo(distribution.cells.filter(c => c.homeGoals + c.awayGoals === 2).reduce((s, c) => s + c.probability, 0), 12);
  });

  it("uses shared settlement semantics for .25 and .75 lines", () => {
    expect(aggregateMarket(oneCell(1, 1), "total", 2.25, "over")).toEqual({ win: 0, half_win: 0, push: 0, half_loss: 1, loss: 0 });
    expect(aggregateMarket(oneCell(2, 1), "total", 2.75, "over")).toEqual({ win: 0, half_win: 1, push: 0, half_loss: 0, loss: 0 });
    expect(aggregateMarket(oneCell(1, 0), "handicap", 0.75, "home")).toEqual({ win: 0, half_win: 1, push: 0, half_loss: 0, loss: 0 });
  });

  it("fits deterministically and defaults to uncalibrated", () => {
    const input = { oneXTwo: { home: 0.5, draw: 0.27, away: 0.23 }, totalLine: 2.5, overProbability: 0.51, maxGoals: 12 };
    const first = fitPoissonModel(input);
    const second = fitPoissonModel(input);
    expect(first.quality).toBe("uncalibrated");
    expect(first.value).not.toBeNull();
    expect(second.value).toEqual(first.value);
  });

  it("returns structured failure rather than fabricated probabilities", () => {
    expect(fitPoissonModel({ oneXTwo: { home: 0.5, draw: 0.3, away: 0.3 }, totalLine: 2.5, overProbability: 0.5 }))
      .toMatchObject({ quality: "insufficient_data", value: null });
    expect(fitPoissonModel({ oneXTwo: { home: 0.5, draw: 0.25, away: 0.25 }, totalLine: 2.5, overProbability: 0.5, maxGoals: 1, maxTailProbability: 0 }))
      .toMatchObject({ quality: "insufficient_data", value: null });
  });
});

describe("analysis probability integration", () => {
  const companies = [
    { companyId: "3", euroHomeInit: "2.00", euroDrawInit: "3.40", euroAwayInit: "4.00" },
    { companyId: "35", euroHomeInit: "2.10", euroDrawInit: "3.30", euroAwayInit: "3.80" },
  ];

  it("de-vigs Hong Kong total prices and conserves selected five-outcome probabilities", () => {
    const prepared = prepareAnalysisProbability({
      scheduleMode: "today",
      companies,
      crown12Handicap: { home: "0.94", line: "0.25", away: "0.96" },
      crown12Total: { over: "0.90", line: "2.75", under: "1.00" },
      sourceObservedAt: "2026-07-12T10:00:00.000Z",
    });

    expect(prepared).toMatchObject({
      quality: "uncalibrated",
      modelVersion: "market-poisson-v1",
      companyCount: 2,
      sourceObservedAt: "2026-07-12T10:00:00.000Z",
      totalTarget: { line: 2.75 },
    });
    expect(prepared.totalTarget?.overProbability).toBeCloseTo((1 / 1.9) / ((1 / 1.9) + (1 / 2)), 12);
    expect(prepared.candidates.map(item => item.id)).toEqual([
      "reference-handicap-home",
      "reference-handicap-away",
      "reference-total-over",
      "reference-total-under",
    ]);

    const output = finalizeAnalysisProbability(prepared, { handicap: "主", total: "大" });
    expect(output.markets.handicap).toMatchObject({ line: 0.25, selection: "home" });
    expect(output.markets.total).toMatchObject({ line: 2.75, selection: "over" });
    closeToOne(probabilitySum(output.markets.handicap!.probabilities));
    closeToOne(probabilitySum(output.markets.total!.probabilities));
    expect(output.recommendations.handicap.evaluated.map(item => item.id)).toEqual([
      "reference-handicap-home",
      "reference-handicap-away",
    ]);
    expect(output.recommendations.total.evaluated.map(item => item.id)).toEqual([
      "reference-total-over",
      "reference-total-under",
    ]);
  });

  it("uses live references for future analysis and never invents missing candidates", () => {
    const prepared = prepareAnalysisProbability({
      scheduleMode: "future",
      companies,
      crown12Handicap: { home: "0.80", line: "1.5", away: "1.10" },
      crown12Total: { over: "0.80", line: "3.5", under: "1.10" },
      crownLiveHandicap: { home: "0.92", line: "0.75", away: "0.98" },
      sourceObservedAt: "2026-07-12T11:00:00.000Z",
    });

    expect(prepared.totalTarget).toBeNull();
    expect(prepared.model).toBeNull();
    expect(prepared.quality).toBe("insufficient_data");
    expect(prepared.candidates.map(item => item.id)).toEqual([
      "reference-handicap-home",
      "reference-handicap-away",
    ]);
    expect(prepared.candidates.every(item => item.source === "crown_live" && item.line === 0.75)).toBe(true);

    const output = finalizeAnalysisProbability(prepared, { handicap: "主", total: "大" });
    expect(output.markets.handicap).toBeNull();
    expect(output.markets.total).toBeNull();
    expect(output.recommendations.handicap.recommended).toBeNull();
    expect(output.recommendations.total.evaluated).toEqual([]);
  });
});

describe("expected value and candidate selection", () => {
  it("prices all five settlement outcomes correctly", () => {
    const probabilities = { win: 0.3, half_win: 0.2, push: 0.1, half_loss: 0.15, loss: 0.25 };
    expect(expectedValue(probabilities, 0.9)).toBeCloseTo(0.3 * 0.9 + 0.2 * 0.45 - 0.15 * 0.5 - 0.25, 12);
    expect(decimalToNetOdds(1.92)).toBeCloseTo(0.92, 12);
    expect(decimalToNetOdds(1)).toBeNull();
  });

  it("selects only among supplied real candidates and marks uncalibrated output provisional", () => {
    const distribution = createScoreDistribution(1.8, 0.8, 12).value!;
    const candidates = [
      { id: "real-home", market: "handicap" as const, line: 0.5, selection: "home" as const, netOdds: 0.95 },
      { id: "real-away", market: "handicap" as const, line: 0.5, selection: "away" as const, netOdds: 0.95 },
    ];
    const result = recommendCandidate(distribution, "uncalibrated", candidates);
    expect(candidates.map(candidate => candidate.id)).toContain(result.recommended!.id);
    expect(result.evaluated).toHaveLength(2);
    expect(result.recommended!.provisional).toBe(true);
  });

  it("returns none when no candidates or probabilities are supplied", () => {
    const distribution = createScoreDistribution(1, 1, 12).value!;
    expect(recommendCandidate(distribution, "available", []).recommended).toBeNull();
    expect(recommendCandidate(null, "insufficient_data", [{ id: "x", market: "total", line: 2.5, selection: "over", netOdds: 0.9 }]).recommended).toBeNull();
  });
});
