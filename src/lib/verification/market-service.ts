import {
  resolveEffectiveVerification,
  settlePrediction,
  summarizeSettlementOutcomes,
  type AutomaticVerificationStatus,
  type PredictionMarket,
  type SettlementOutcome,
} from "@/lib/verification";

export interface MarketVerification {
  market: PredictionMarket;
  settlementLine: number | string | null;
  selection: string | null;
  settlementBasis: string | null;
  snapshotId: number | null;
  autoOutcome: SettlementOutcome;
  autoIsCorrect: boolean | null;
  automaticStatus: AutomaticVerificationStatus;
  manualIsCorrect: boolean | null;
  effectiveIsCorrect: boolean | null;
  effectiveStatus: string;
  settlementReason: string | null;
  autoVerifiedAt: string | null;
  manualVerifiedAt: string | null;
  finalVerifiedAt: string | null;
  verifiedBy: string | null;
}

export interface PredictionVerificationRow extends Record<string, unknown> {
  match_id: string;
  match_date: string;
  league: string;
  analyzed_at?: string | null;
  is_correct?: boolean | null;
  strategy_version?: string | null;
}

const SCORED_OUTCOMES = new Set<SettlementOutcome>(["win", "half_win", "push", "half_loss", "loss"]);

export function outcomeCorrectness(outcome: SettlementOutcome): boolean | null {
  if (outcome === "win" || outcome === "half_win") return true;
  if (outcome === "loss" || outcome === "half_loss") return false;
  return null;
}

function automaticStatus(outcome: SettlementOutcome): AutomaticVerificationStatus {
  const correctness = outcomeCorrectness(outcome);
  if (correctness !== null) return correctness ? "correct" : "wrong";
  return outcome === "invalid" ? "invalid" : "pending";
}

export function readMarketVerification(row: Record<string, unknown>, market: PredictionMarket): MarketVerification {
  const prefix = `${market}_`;
  const outcome = (row[`${prefix}auto_outcome`] as SettlementOutcome | null) || "pending";
  const autoIsCorrect = typeof row[`${prefix}auto_is_correct`] === "boolean"
    ? row[`${prefix}auto_is_correct`] as boolean
    : outcomeCorrectness(outcome);
  const manualIsCorrect = typeof row[`${prefix}manual_is_correct`] === "boolean"
    ? row[`${prefix}manual_is_correct`] as boolean
    : null;
  const status = (row[`${prefix}automatic_status`] as AutomaticVerificationStatus | null) || automaticStatus(outcome);
  const effective = resolveEffectiveVerification(autoIsCorrect, manualIsCorrect, status);
  return {
    market,
    settlementLine: row[`${prefix}settlement_line`] as number | string | null ?? null,
    selection: row[`${prefix}selection`] as string | null ?? null,
    settlementBasis: row[`${prefix}settlement_basis`] as string | null ?? null,
    snapshotId: row[`${prefix}snapshot_id`] as number | null ?? null,
    autoOutcome: outcome,
    autoIsCorrect,
    automaticStatus: status,
    manualIsCorrect,
    effectiveIsCorrect: effective.isCorrect,
    effectiveStatus: effective.status,
    settlementReason: row[`${prefix}settlement_reason`] as string | null ?? null,
    autoVerifiedAt: row[`${prefix}auto_verified_at`] as string | null ?? null,
    manualVerifiedAt: row[`${prefix}manual_verified_at`] as string | null ?? null,
    finalVerifiedAt: row[`${prefix}final_verified_at`] as string | null ?? null,
    verifiedBy: row[`${prefix}verified_by`] as string | null ?? null,
  };
}

export function buildManualVerificationUpdate(
  row: Record<string, unknown>,
  market: PredictionMarket,
  manualIsCorrect: boolean | null,
  now: string,
  actor: string | null,
): Record<string, unknown> {
  const current = readMarketVerification(row, market);
  const effective = resolveEffectiveVerification(current.autoIsCorrect, manualIsCorrect, current.automaticStatus);
  const update: Record<string, unknown> = {
    [`${market}_manual_is_correct`]: manualIsCorrect,
    [`${market}_effective_is_correct`]: effective.isCorrect,
    [`${market}_effective_status`]: effective.status === "pending" ? "unverified" : effective.status,
    [`${market}_manual_verified_at`]: manualIsCorrect === null ? null : now,
    [`${market}_final_verified_at`]: effective.isCorrect === null ? null : now,
    [`${market}_verified_by`]: manualIsCorrect === null ? null : actor,
  };
  if (market === "handicap") Object.assign(update, {
    manual_is_correct: manualIsCorrect,
    auto_is_correct: current.autoIsCorrect,
    is_correct: effective.isCorrect,
    verification_status: effective.status,
    water_verification_status: effective.status,
    verified_at: effective.isCorrect === null ? null : now,
  });
  return update;
}

export function settleMarket(
  row: Record<string, unknown>,
  market: PredictionMarket,
  score: { home_score: unknown; away_score: unknown; status?: unknown } | null,
  evidence?: { line: unknown; basis: string; snapshotId?: number | null },
  now = new Date().toISOString(),
): Record<string, unknown> {
  const selection = market === "handicap" ? row.handicap_selection ?? row.prediction : row.total_selection ?? row.total_prediction;
  const storedLine = row[`${market}_settlement_line`];
  const line = storedLine ?? evidence?.line ?? null;
  const basis = row[`${market}_settlement_basis`] ?? evidence?.basis ?? null;
  const finalScore = score?.status === "finished" ? score : null;
  const outcome = settlePrediction({
    market,
    prediction: selection,
    line,
    homeScore: finalScore?.home_score ?? null,
    awayScore: finalScore?.away_score ?? null,
    specialStatus: finalScore && line === null && !evidence ? "legacy_unknown" : null,
  });
  const autoIsCorrect = outcomeCorrectness(outcome);
  const status = automaticStatus(outcome);
  const manual = typeof row[`${market}_manual_is_correct`] === "boolean" ? row[`${market}_manual_is_correct`] as boolean : null;
  const effective = resolveEffectiveVerification(autoIsCorrect, manual, status);
  const update: Record<string, unknown> = {
    [`${market}_settlement_line`]: line,
    [`${market}_selection`]: typeof selection === "string" ? selection : null,
    [`${market}_settlement_basis`]: basis,
    [`${market}_snapshot_id`]: row[`${market}_snapshot_id`] ?? evidence?.snapshotId ?? null,
    [`${market}_auto_outcome`]: outcome,
    [`${market}_auto_is_correct`]: autoIsCorrect,
    [`${market}_automatic_status`]: status,
    [`${market}_effective_is_correct`]: effective.isCorrect,
    [`${market}_effective_status`]: effective.status === "pending" ? "unverified" : effective.status,
    [`${market}_settlement_reason`]: outcome === "pending" ? "missing_final_score" : outcome === "legacy_unknown" ? "missing_historical_settlement_evidence" : null,
    [`${market}_auto_verified_at`]: SCORED_OUTCOMES.has(outcome) ? now : null,
    [`${market}_final_verified_at`]: effective.isCorrect === null ? null : now,
  };
  if (market === "handicap") Object.assign(update, {
    auto_is_correct: autoIsCorrect,
    is_correct: effective.isCorrect,
    verification_status: effective.status,
    water_verification_status: effective.status,
    verified_at: effective.isCorrect === null ? null : now,
  });
  return update;
}

export function marketVerificationWeight(row: Record<string, unknown>, market: PredictionMarket) {
  const verification = readMarketVerification(row, market);
  const summary = verification.manualIsCorrect === null
    ? summarizeSettlementOutcomes([verification.autoOutcome])
    : summarizeSettlementOutcomes([], [verification.manualIsCorrect]);
  return {
    weightedCorrect: summary.weightedCorrect,
    weightedWrong: summary.weightedWrong,
    weightedTotal: summary.weightedTotal,
  };
}

export function summarizeMarketRows(rows: Record<string, unknown>[], market: PredictionMarket) {
  const outcomes: SettlementOutcome[] = [];
  const manuals: boolean[] = [];
  for (const row of rows) {
    const verification = readMarketVerification(row, market);
    if (verification.manualIsCorrect !== null) manuals.push(verification.manualIsCorrect);
    else outcomes.push(verification.autoOutcome);
  }
  return summarizeSettlementOutcomes(outcomes, manuals);
}

export function serializeVerification(row: Record<string, unknown>) {
  return {
    handicap: readMarketVerification(row, "handicap"),
    total: readMarketVerification(row, "total"),
  };
}

export const MARKET_VERIFICATION_COLUMNS = [
  "prediction_revision", "handicap_settlement_line", "handicap_snapshot_id", "handicap_settlement_basis", "handicap_selection",
  "total_settlement_line", "total_snapshot_id", "total_settlement_basis", "total_selection", "actual_score_margin", "actual_total_goals",
  ...["handicap", "total"].flatMap(market => ["auto_outcome", "auto_is_correct", "manual_is_correct", "effective_is_correct", "automatic_status", "effective_status", "settlement_reason", "auto_verified_at", "manual_verified_at", "final_verified_at", "verified_by"].map(field => `${market}_${field}`)),
].join(",");
