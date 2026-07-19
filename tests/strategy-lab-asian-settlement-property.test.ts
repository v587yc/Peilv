import { describe, expect, it } from "vitest";
import { calculateAsianSettlement } from "@/lib/verification/asian-settlement";

const waters = [1, 10_000, 850_000, 900_000, 1_000_000, 5_000_000] as const;
const outcomes = new Set(["win", "half_win", "push", "half_loss", "loss"]);

describe("Asian settlement exhaustive Phase4 properties", () => {
  it("covers 21x21 scores, 161 quarter lines, both selections and six water boundaries", () => {
    let combinations = 0;
    const fail = (condition: boolean, message: string) => { if (!condition) throw new Error(`${message} at combination ${combinations}`); };
    for (let homeScore = 0; homeScore <= 20; homeScore++) for (let awayScore = 0; awayScore <= 20; awayScore++) {
      for (let handicapQuarterUnits = -80; handicapQuarterUnits <= 80; handicapQuarterUnits++) for (const selection of ["home", "away"] as const) for (const selectedWaterMillionths of waters) {
        const input = Object.freeze({ selection, handicapQuarterUnits, homeScore, awayScore, selectedWaterMillionths });
        const before = JSON.stringify(input);
        const value = calculateAsianSettlement(input);
        combinations++;
        fail(outcomes.has(value.outcome), "invalid outcome");
        fail(value.profitDecimal === `${value.profitMicros < 0 ? "-" : ""}${Math.floor(Math.abs(value.profitMicros) / 1_000_000)}.${String(Math.abs(value.profitMicros) % 1_000_000).padStart(6, "0")}`, "noncanonical decimal");
        fail(value.legs.reduce((sum, leg) => sum + leg.stakeMicros, 0) === 1_000_000, "stake mismatch");
        fail(!(value.legs.some(leg => leg.result === "win") && value.legs.some(leg => leg.result === "loss")), "opposed legs");
        fail(Math.sign(value.profitMicros) === (value.outcome === "loss" || value.outcome === "half_loss" ? -1 : value.outcome === "push" ? 0 : 1), "profit sign mismatch");
        fail(value.legs.length === (handicapQuarterUnits % 2 === 0 ? 1 : 2), "leg cardinality mismatch");
        fail(JSON.stringify(input) === before, "input mutated");
        const mirror = calculateAsianSettlement({ selection: selection === "home" ? "away" : "home", handicapQuarterUnits: -handicapQuarterUnits, homeScore: awayScore, awayScore: homeScore, selectedWaterMillionths });
        fail(mirror.outcome === value.outcome && mirror.profitMicros === value.profitMicros && mirror.profitDecimal === value.profitDecimal
          && JSON.stringify(mirror.legs.map(leg => leg.result).sort()) === JSON.stringify(value.legs.map(leg => leg.result).sort())
          && mirror.legs.reduce((sum,leg)=>sum+leg.stakeMicros,0) === value.legs.reduce((sum,leg)=>sum+leg.stakeMicros,0), "home/away mirror mismatch");
      }
    }
    expect(combinations).toBe(852_012);
  }, 120_000);

  it("is deeply stable across 100 replays", () => {
    const input = { selection: "home" as const, handicapQuarterUnits: 3, homeScore: 2, awayScore: 1, selectedWaterMillionths: 900_000 };
    const first = calculateAsianSettlement(input);
    for (let index = 0; index < 100; index++) expect(calculateAsianSettlement(input)).toEqual(first);
  });
});
