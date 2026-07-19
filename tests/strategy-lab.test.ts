import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STRATEGY_C_REQUIRED_FIELDS,
  evaluateStrategyA,
  evaluateStrategyB,
  evaluateStrategyC,
  defineStrategyDVersion1Adapter,
  normalizeHandicap,
  parseWaterToBasisPoints,
  stableStrategyJson,
  type StrategyCInput,
  type StrategyEvaluationInput,
} from "@/features/strategy-lab";

function input(
  homeWater: string,
  awayWater: string,
  handicap = "半球",
  previousHandicap: string | null = "半球",
  checkpoint: StrategyEvaluationInput["checkpoint"] = "T30",
): StrategyEvaluationInput {
  return {
    checkpoint,
    current: { homeWater, awayWater, handicap },
    ...(previousHandicap === null
      ? {}
      : { previousEffective: { handicap: previousHandicap } }),
  };
}

describe("strategy lab handicap normalization", () => {
  it.each([
    ["半球", 0.5],
    ["*半球", 0.5],
    ["受半球", -0.5],
    ["平/半", 0.25],
    ["*受一/球半", -1.25],
    ["3.5/4", 3.75],
    ["0.5", 0.5],
    ["受0.5", -0.5],
    ["0/0.5", 0.25],
    ["受0/0.5", -0.25],
    ["0.5/1", 0.75],
    ["半球/一球", 0.75],
    ["一/球半", 1.25],
    ["球半/两", 1.75],
    ["两/两球半", 2.25],
    ["两球半/三", 2.75],
    ["20", 20],
  ])("normalizes %s", (raw, expected) => {
    expect(normalizeHandicap(raw)?.goals).toBe(expected);
  });

  it.each([
    "3.5junk",
    "1/2junk",
    "0.5e1",
    "1/2/3",
    "--0.5",
    "受",
    "*",
    "",
    "NaN",
    "Infinity",
    "20.25",
    "0.3",
    "0.1/0.4",
    "19/21",
    "0/20",
    "3.5/3.5",
    "4/3.5",
    "1/3",
    "19/20",
    "0/-0.5",
    "受0/-0.5",
    "20/20.5",
  ])("strictly rejects %s", raw => {
    expect(normalizeHandicap(raw)).toBeNull();
  });

  it("compares normalized values rather than source spelling", () => {
    expect(evaluateStrategyA(input("0.90", "0.98", "*半球", "半球")).decision.status)
      .toBe("recommend");
    expect(evaluateStrategyA(input("0.90", "0.98", "受半球", "半球")).decision.status)
      .toBe("reanalyze_required");
  });
});

describe("strategy lab water normalization", () => {
  it.each([
    ["0", 0],
    [0, 0],
    ["0.0001", 1],
    ["1", 10_000],
    ["5.0000", 50_000],
    [5, 50_000],
  ] as const)("normalizes %s to %s basis points", (raw, expected) => {
    expect(parseWaterToBasisPoints(raw)?.basisPoints).toBe(expected);
  });

  it.each([
    "-0.1",
    "5.0001",
    "0.12345",
    "1e0",
    "NaN",
    "Infinity",
    "1.0junk",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0.1,
    5.0001,
  ])("rejects invalid or out-of-range water %#", raw => {
    expect(parseWaterToBasisPoints(raw)).toBeNull();
  });
});

describe("checkpoint previous-effective semantics", () => {
  it.each([evaluateStrategyA, evaluateStrategyB])("allows T1215 without a previous checkpoint", evaluate => {
    const result = evaluate({
      checkpoint: "T1215",
      current: { homeWater: "0.90", awayWater: "0.98", handicap: "半球" },
    });
    expect(result.decision.status).toBe("recommend");
  });

  it.each(["T30", "T03"] as const)("treats omitted and null previous values identically at %s", checkpoint => {
    for (const evaluate of [evaluateStrategyA, evaluateStrategyB]) {
      const base = { checkpoint, current: { homeWater: "0.90", awayWater: "0.98", handicap: "半球" } };
      const omitted = evaluate(base);
      const explicitNull = evaluate({ ...base, previousEffective: null });
      expect(omitted.decision.status).toBe("insufficient_data");
      expect(explicitNull.decision).toEqual(omitted.decision);
      expect(omitted.decision.reasonCode).toContain("PREVIOUS_CHECKPOINT_UNAVAILABLE");
    }
  });

  it.each([null, "", "unknown"])("rejects unavailable previous handicap %#", handicap => {
    for (const evaluate of [evaluateStrategyA, evaluateStrategyB]) {
      const result = evaluate({
        checkpoint: "T30",
        current: { homeWater: "0.90", awayWater: "0.98", handicap: "半球" },
        previousEffective: { handicap },
      });
      expect(result.decision.status).toBe("insufficient_data");
      expect(result.decision.reasonCode).toContain("PREVIOUS_CHECKPOINT_UNAVAILABLE");
    }
  });

  it("uses only the previous handicap and compares normalized values", () => {
    const unchanged = evaluateStrategyA(input("0.90", "0.98", "*半球", "半球"));
    const changed = evaluateStrategyA(input("0.90", "0.98", "受半球", "半球"));
    expect(unchanged.decision.status).toBe("recommend");
    expect(changed.decision.status).toBe("reanalyze_required");
    expect(unchanged.meta.normalizedPreviousEffective).toEqual({
      handicap: { raw: "半球", goals: 0.5, quarterUnits: 2 },
    });
  });
});

describe("strategy A deterministic boundaries", () => {
  it.each([
    ["0.9601", "1.0000", "observe", null],
    ["0.9600", "1.0000", "recommend", "home"],
    ["0.8000", "1.0000", "recommend", "home"],
    ["0.7999", "1.0000", "recommend", "away"],
    ["0.9700", "1.0100", "recommend", "away"],
  ] as const)("evaluates %s/%s", (home, away, status, side) => {
    expect(evaluateStrategyA(input(home, away)).decision).toMatchObject({ status, side });
  });

  it("selects the correct side for reversed low/high water", () => {
    expect(evaluateStrategyA(input("1.00", "0.96")).decision.side).toBe("away");
    expect(evaluateStrategyA(input("1.01", "0.97")).decision.side).toBe("home");
    expect(evaluateStrategyA(input("1.00", "0.7999")).decision.side).toBe("home");
  });
});

describe("strategy B deterministic boundaries", () => {
  it.each([
    ["0.9601", "1.0000", "observe", null],
    ["0.9600", "1.0000", "recommend", "home"],
    ["0.8000", "1.0000", "recommend", "home"],
    ["0.7999", "1.0000", "recommend", "home"],
    ["1.0000", "0.7999", "recommend", "away"],
  ] as const)("evaluates %s/%s", (home, away, status, side) => {
    expect(evaluateStrategyB(input(home, away)).decision).toMatchObject({ status, side });
  });

  it("requires reanalysis on a real line change", () => {
    expect(evaluateStrategyB(input("0.90", "0.98", "一球", "半球")).decision.status)
      .toBe("reanalyze_required");
  });
});

describe("missing and invalid strategy data", () => {
  it.each([
    [{ homeWater: null, awayWater: "0.98", handicap: "半球" }, "current.homeWater"],
    [{ homeWater: "invalid", awayWater: "0.98", handicap: "半球" }, "current.homeWater"],
    [{ homeWater: "0.90", awayWater: "0.98", handicap: "unknown" }, "current.handicap"],
  ])("rejects %#", (current, field) => {
    const result = evaluateStrategyA({ checkpoint: "T1215", current });
    expect(result.decision.status).toBe("insufficient_data");
    expect([...result.meta.missingFields, ...result.meta.invalidFields]).toContain(field);
  });
});

function completeCInput(): StrategyCInput {
  return {
    ...input("0.90", "0.98"),
    cData: {
      marketConsensus: "aligned",
      liquidityProfile: "normal",
      teamContext: "complete",
    },
  };
}

describe("strategy C readiness and fallback", () => {
  it.each(STRATEGY_C_REQUIRED_FIELDS)("falls back to the same A decision when %s is missing", field => {
    const candidate = completeCInput();
    const cData = { ...candidate.cData, [field]: null };
    const directA = evaluateStrategyA(candidate);
    const result = evaluateStrategyC({ ...candidate, cData });
    expect(result.decision).toEqual(directA.decision);
    expect(result.cMeta).toMatchObject({ requested: "C", executed: "A", availability: "fallback" });
    expect(result.cMeta.missingFields).toEqual([field]);
  });

  it.each([
    input("0.9901", "1.0000"),
    input("0.90", "0.98", "一球", "半球"),
    { checkpoint: "T03" as const, current: { homeWater: null, awayWater: "0.98", handicap: "半球" } },
  ])("passes every A terminal state through unchanged", base => {
    const directA = evaluateStrategyA(base);
    const result = evaluateStrategyC({
      ...base,
      cData: { marketConsensus: null, liquidityProfile: "normal", teamContext: "complete" },
    });
    expect(result.decision).toEqual(directA.decision);
    expect(result.meta.requestedStrategy).toBe("C");
    expect(result.meta.executedStrategy).toBe("A");
  });

  it("marks complete C data unavailable without simulating a recommendation", () => {
    const result = evaluateStrategyC(completeCInput());
    expect(result.decision).toMatchObject({
      status: "insufficient_data",
      side: null,
      reasonCode: "C_EXECUTOR_UNAVAILABLE",
      lockedByDeterministicRule: false,
    });
    expect(result.cMeta.availability).toBe("unavailable");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cMeta.missingFields)).toBe(true);
  });

  it("treats blank critical values as missing with stable ordered unique fields", () => {
    const result = evaluateStrategyC({
      ...completeCInput(),
      cData: { marketConsensus: "  ", liquidityProfile: "", teamContext: null },
    });
    expect(result.cMeta.missingFields).toEqual([
      "marketConsensus",
      "liquidityProfile",
      "teamContext",
    ]);
    expect(new Set(result.cMeta.missingFields).size).toBe(result.cMeta.missingFields.length);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.decision)).toBe(true);
    expect(Object.isFrozen(result.cMeta.missingFields)).toBe(true);
  });

  it("validates, detaches and deeply freezes an injected executor result", () => {
    const mutable = {
      decision: {
        status: "recommend" as const,
        side: "home" as const,
        reasonCode: "C_REAL_RESULT",
        branchId: "C-REAL",
        lockedByDeterministicRule: false,
      },
      meta: {
        checkpoint: "T30" as const,
        requestedStrategy: "C" as const,
        executedStrategy: "C" as const,
        normalizedCurrent: null,
        normalizedPreviousEffective: null,
        waterDiffBasisPoints: null,
        missingFields: [] as string[],
        invalidFields: [] as string[],
      },
    };
    const result = evaluateStrategyC(completeCInput(), () => mutable);
    mutable.decision.reasonCode = "MUTATED";
    mutable.meta.missingFields.push("late");
    expect(result.decision.reasonCode).toBe("C_REAL_RESULT");
    expect(result.meta.missingFields).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.meta)).toBe(true);
    expect(Object.isFrozen(result.meta.missingFields)).toBe(true);
  });

  it.each([
    ["A", "A"],
    ["C", "A"],
    ["D", "D"],
    ["A", "C"],
  ] as const)("rejects executor identity %s/%s instead of rewriting it", (requestedStrategy, executedStrategy) => {
    const invalid = {
      decision: {
        status: "recommend" as const,
        side: "home" as const,
        reasonCode: "INVALID_IDENTITY",
        branchId: "C-INVALID-IDENTITY",
        lockedByDeterministicRule: false,
      },
      meta: {
        checkpoint: "T30" as const,
        requestedStrategy,
        executedStrategy,
        normalizedCurrent: null,
        normalizedPreviousEffective: null,
        waterDiffBasisPoints: null,
        missingFields: [],
        invalidFields: [],
      },
    };
    expect(() => evaluateStrategyC(completeCInput(), () => invalid))
      .toThrow("Invalid strategy result: meta");
  });

  it("rejects an executor result for a different checkpoint", () => {
    const invalid = {
      decision: {
        status: "recommend" as const,
        side: "home" as const,
        reasonCode: "WRONG_CHECKPOINT",
        branchId: "C-WRONG-CHECKPOINT",
        lockedByDeterministicRule: false,
      },
      meta: {
        checkpoint: "T03" as const,
        requestedStrategy: "C" as const,
        executedStrategy: "C" as const,
        normalizedCurrent: null,
        normalizedPreviousEffective: null,
        waterDiffBasisPoints: null,
        missingFields: [],
        invalidFields: [],
      },
    };
    expect(() => evaluateStrategyC(completeCInput(), () => invalid))
      .toThrow("Invalid strategy result: meta");
  });
});

describe("strategy D-v1 adapter boundary", () => {
  it("copies registration data and deeply freezes every result snapshot", () => {
    const mutableResult = {
      decision: {
        status: "recommend" as const,
        side: "away" as const,
        reasonCode: "D_RESULT",
        branchId: "D-V1-RESULT",
        lockedByDeterministicRule: false,
      },
      meta: {
        checkpoint: "T03" as const,
        requestedStrategy: "D" as const,
        executedStrategy: "D" as const,
        normalizedCurrent: null,
        normalizedPreviousEffective: null,
        waterDiffBasisPoints: null,
        missingFields: ["nested"] as string[],
        invalidFields: [] as string[],
      },
    };
    const registration = {
      strategy: "D" as const,
      version: "D-v1" as const,
      evaluate: () => mutableResult,
    };
    const adapter = defineStrategyDVersion1Adapter(registration);
    (registration as { strategy: string }).strategy = "changed";
    const result = adapter.evaluate({ checkpoint: "T03", payload: { nested: [1, 2] } });
    mutableResult.decision.reasonCode = "MUTATED";
    mutableResult.meta.missingFields.push("late");
    expect(adapter.strategy).toBe("D");
    expect(adapter.version).toBe("D-v1");
    expect(result.decision.reasonCode).toBe("D_RESULT");
    expect(result.meta.missingFields).toEqual(["nested"]);
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.decision)).toBe(true);
    expect(Object.isFrozen(result.meta.missingFields)).toBe(true);
  });

  it("rejects invalid registration identity", () => {
    expect(() => defineStrategyDVersion1Adapter({
      strategy: "X",
      version: "D-v1",
      evaluate: () => evaluateStrategyA(input("0.90", "0.98")),
    } as never)).toThrow("Invalid D-v1 strategy adapter");
  });

  it.each([undefined, null, "not-a-function"])("rejects missing or invalid evaluate %#", evaluate => {
    expect(() => defineStrategyDVersion1Adapter({
      strategy: "D",
      version: "D-v1",
      evaluate,
    } as never)).toThrow("Invalid D-v1 strategy adapter");
  });

  it.each([
    ["A", "A", "T03"],
    ["C", "C", "T03"],
    ["D", "D", "T30"],
  ] as const)("rejects output identity/checkpoint %s/%s/%s", (requestedStrategy, executedStrategy, checkpoint) => {
    const adapter = defineStrategyDVersion1Adapter({
      strategy: "D",
      version: "D-v1",
      evaluate: () => ({
        decision: {
          status: "recommend",
          side: "home",
          reasonCode: "INVALID_D_OUTPUT",
          branchId: "D-INVALID-OUTPUT",
          lockedByDeterministicRule: false,
        },
        meta: {
          checkpoint,
          requestedStrategy,
          executedStrategy,
          normalizedCurrent: null,
          normalizedPreviousEffective: null,
          waterDiffBasisPoints: null,
          missingFields: [],
          invalidFields: [],
        },
      }),
    } as never);
    expect(() => adapter.evaluate({ checkpoint: "T03", payload: {} }))
      .toThrow("Invalid strategy result: meta");
  });
});

describe("strategy output stability", () => {
  it.each([evaluateStrategyA, evaluateStrategyB])("is deeply equal and canonically stable over 100 runs", evaluate => {
    const results = Array.from({ length: 100 }, () => evaluate(input("0.90", "0.98")));
    for (const result of results) {
      expect(result).toEqual(results[0]);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.decision)).toBe(true);
    }
    const hashes = new Set(results.map(result => createHash("sha256")
      .update(stableStrategyJson(result))
      .digest("hex")));
    expect(hashes.size).toBe(1);
  });
});
