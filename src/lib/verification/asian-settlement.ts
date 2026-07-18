export type AsianSelection = "home" | "away";
export type AsianLegResult = "win" | "push" | "loss";
export type AsianSettlementOutcome = "win" | "half_win" | "push" | "half_loss" | "loss";

export interface AsianSettlementLeg {
  readonly handicapQuarterUnits: number;
  readonly stakeMicros: 500_000 | 1_000_000;
  readonly result: AsianLegResult;
  readonly profitMicros: number;
}

export interface AsianSettlementResult {
  readonly legs: readonly AsianSettlementLeg[];
  readonly outcome: AsianSettlementOutcome;
  readonly profitMicros: number;
  readonly profitUnits: number;
  readonly profitDecimal: string;
}

function safeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

/** Pure deterministic Asian-handicap settlement using quarter units and micros. */
export function calculateAsianSettlement(input: Readonly<{
  selection: AsianSelection;
  handicapQuarterUnits: number;
  homeScore: number;
  awayScore: number;
  selectedWaterMillionths: number;
}>): AsianSettlementResult {
  safeInteger(input.handicapQuarterUnits, "handicapQuarterUnits");
  safeInteger(input.homeScore, "homeScore");
  safeInteger(input.awayScore, "awayScore");
  safeInteger(input.selectedWaterMillionths, "selectedWaterMillionths");
  if (input.selection !== "home" && input.selection !== "away") throw new TypeError("selection is invalid");
  if (input.handicapQuarterUnits < -80 || input.handicapQuarterUnits > 80) throw new TypeError("handicapQuarterUnits is out of range");
  if (input.homeScore < 0 || input.homeScore > 99 || input.awayScore < 0 || input.awayScore > 99) throw new TypeError("scores are out of range");
  if (input.selectedWaterMillionths < 1 || input.selectedWaterMillionths > 5_000_000) throw new TypeError("selectedWaterMillionths is out of range");

  const lower = Math.floor(input.handicapQuarterUnits / 2) * 2;
  const upper = Math.ceil(input.handicapQuarterUnits / 2) * 2;
  const scoreMarginQuarterUnits = (input.homeScore - input.awayScore) * 4;
  const handicapParts = lower === upper ? [lower] : [lower, upper];
  const stakeMicros = handicapParts.length === 1 ? 1_000_000 as const : 500_000 as const;
  const legDrafts = handicapParts.map(handicapQuarterUnits => {
    const adjusted = input.selection === "home"
      ? scoreMarginQuarterUnits - handicapQuarterUnits
      : -scoreMarginQuarterUnits + handicapQuarterUnits;
    const result: AsianLegResult = adjusted > 0 ? "win" : adjusted < 0 ? "loss" : "push";
    return { handicapQuarterUnits, result };
  });
  const results = legDrafts.map(leg => leg.result);
  if (results.includes("win") && results.includes("loss")) throw new TypeError("integrity: mutually opposed legs");
  const outcome: AsianSettlementOutcome = results.every(result => result === "win") ? "win"
    : results.every(result => result === "loss") ? "loss"
      : results.every(result => result === "push") ? "push"
        : results.includes("win") ? "half_win" : "half_loss";
  const winningLegs = results.filter(result => result === "win").length;
  let allocatedWinMicros = 0;
  const totalWinMicros = winningLegs === legDrafts.length
    ? input.selectedWaterMillionths
    : winningLegs === 1 ? Math.floor((input.selectedWaterMillionths + 1) / 2) : 0;
  const legs = legDrafts.map((leg, index) => {
    let profitMicros = 0;
    if (leg.result === "loss") profitMicros = -stakeMicros;
    if (leg.result === "win") {
      const remainingWins = legDrafts.slice(index).filter(candidate => candidate.result === "win").length;
      profitMicros = Math.floor((totalWinMicros - allocatedWinMicros) / remainingWins);
      allocatedWinMicros += profitMicros;
    }
    return Object.freeze({ ...leg, stakeMicros, profitMicros });
  });
  const profitMicros = legs.reduce((sum, leg) => sum + leg.profitMicros, 0);
  const sign = profitMicros < 0 ? "-" : "";
  const absolute = Math.abs(profitMicros);
  const profitDecimal = `${sign}${Math.floor(absolute / 1_000_000)}.${String(absolute % 1_000_000).padStart(6, "0")}`;
  return Object.freeze({ legs: Object.freeze(legs), outcome, profitMicros, profitUnits: profitMicros / 1_000_000, profitDecimal });
}
