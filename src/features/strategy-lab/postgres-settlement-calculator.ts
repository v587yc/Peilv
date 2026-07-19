import "server-only";
import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/canonical-json";
import { calculateAsianSettlement } from "@/lib/verification/asian-settlement";
import { normalizeHandicap } from "./normalization";
import type { SettlementCalculation, SettlementCalculator } from "./application-service";
import type { StrategyLabSqlClient } from "./postgres-repository";

export const SETTLEMENT_CALCULATOR_VERSION = "calculator-v2" as const;
export type SettlementCalculatorErrorCode = "not_final" | "integrity" | "dependency";
export class SettlementCalculatorError extends Error {
  constructor(readonly code: SettlementCalculatorErrorCode) { super(`settlement calculator ${code}`); this.name="SettlementCalculatorError"; delete this.stack; }
}

type Row = Record<string, unknown>;
const statusSchema = z.enum(["finished", "pending", "special"]);
const iso = (value: unknown) => new Date(String(value)).toISOString();
const object = (value: unknown): Record<string, unknown> => {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SettlementCalculatorError("integrity");
  return parsed as Record<string, unknown>;
};
const integer = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value));
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const waterMillionths = (value: unknown): { raw: string; decimal: string; millionths: number } | null => {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(raw);
  if (!match) return null;
  const millionths = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(millionths) || millionths < 1 || millionths > 5_000_000) return null;
  return { raw, decimal: `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}`, millionths };
};

export class PostgresSettlementCalculator implements SettlementCalculator {
  constructor(private readonly client: StrategyLabSqlClient) {}

  async calculate(input: Parameters<SettlementCalculator["calculate"]>[0]): Promise<Readonly<SettlementCalculation>> {
    try {
      return await this.client.transaction(async tx => {
        const root = await tx.query<Row>(`SELECT p.*,s.content_hash snapshot_content_hash,r.status run_status,r.run_type,
          f.kickoff_at,m.id match_result_id,m.status result_status,m.home_score,m.away_score,m.score_source,
          m.observed_at result_observed_at,m.settled_at result_settled_at,m.updated_at result_updated_at
          FROM strategy_lab_predictions p
          JOIN strategy_lab_snapshot_sets s ON s.id=p.snapshot_set_id
          JOIN strategy_lab_experiment_runs r ON r.id=p.run_id
          JOIN strategy_lab_match_facts f ON f.match_id=p.match_id AND f.match_date=p.match_date
          JOIN match_results m ON m.match_id=p.match_id AND m.match_date=p.match_date
          WHERE p.id=$1 ORDER BY f.revision DESC LIMIT 1`, [input.prediction.id]);
        const row = root.rows[0];
        if (!row || row.decision_status !== "recommend" || (row.selection !== "home" && row.selection !== "away")) throw new SettlementCalculatorError("integrity");
        if (Number(row.evidence_contract_version) !== 2 || !row.execution_cutoff_at || integer(row.executed_actual_quote_snapshot_id) === null) throw new SettlementCalculatorError("integrity");
        if (row.run_type !== "shadow" || !(row.run_status === "running" || row.run_status === "succeeded")) throw new SettlementCalculatorError("integrity");

        const decisionPayload = object(row.decision_payload);
        const details = z.object({ snapshotSetId:z.string().uuid(), snapshotContentHash:z.string().min(1) }).passthrough().safeParse(decisionPayload.details);
        if (!details.success || details.data.snapshotSetId !== row.snapshot_set_id || details.data.snapshotContentHash !== row.snapshot_content_hash) throw new SettlementCalculatorError("integrity");

        const resultStatus = statusSchema.safeParse(row.result_status);
        if (!resultStatus.success) throw new SettlementCalculatorError("integrity");
        if (resultStatus.data === "pending") throw new SettlementCalculatorError("not_final");
        const homeScore = integer(row.home_score), awayScore = integer(row.away_score);
        const revisionDraft = {
          sourceMatchResultId: integer(row.match_result_id), matchId: String(row.match_id), matchDate: String(row.match_date), status: resultStatus.data,
          homeScore, awayScore, scoreSource: String(row.score_source), sourceObservedAt: iso(row.result_observed_at),
          sourceSettledAt: row.result_settled_at === null ? null : iso(row.result_settled_at), sourceUpdatedAt: iso(row.result_updated_at),
        };
        if (revisionDraft.sourceMatchResultId === null) throw new SettlementCalculatorError("integrity");
        let quarterUnits: number;
        let selectedWater: { raw:string; decimal:string; millionths:number };
        let quoteEvidence: Record<string, unknown>;
        if (input.quoteBasis === "theoretical") {
          if (input.actualQuoteSnapshotId !== null) throw new SettlementCalculatorError("integrity");
          const physicalQuarterUnits = integer(row.theoretical_handicap_quarter_units);
          const normalized = normalizeHandicap(typeof row.theoretical_handicap_raw === "string" ? row.theoretical_handicap_raw : null);
          const water = waterMillionths(row.theoretical_selected_water);
          if (physicalQuarterUnits === null || !normalized || normalized.quarterUnits !== physicalQuarterUnits || !water) throw new SettlementCalculatorError("integrity");
          quarterUnits = physicalQuarterUnits; selectedWater = water;
          quoteEvidence = { theoreticalQuote:{ snapshotSetId:String(row.snapshot_set_id), snapshotContentHash:String(row.snapshot_content_hash),
            outputHash:String(row.output_hash), strategyVersion:String(row.strategy_version), handicapRaw:normalized.raw,
            handicapQuarterUnits:quarterUnits, selectedWaterRaw:water.raw, selectedWater:water.decimal, selectedWaterMillionths:water.millionths } };
        } else {
          const boundId = integer(row.executed_actual_quote_snapshot_id);
          if (boundId === null || input.actualQuoteSnapshotId !== boundId) throw new SettlementCalculatorError("integrity");
          const quote = (await tx.query<Row>("SELECT * FROM odds_snapshots WHERE id=$1", [boundId])).rows[0];
          if (!quote || integer(quote.id) !== boundId || quote.company_id !== "3" || quote.market_type !== "asian_handicap" || quote.hash_version !== "canonical-json-v2") throw new SettlementCalculatorError("integrity");
          const odds = object(quote.odds);
          if (canonicalJsonSha256(odds) !== quote.canonical_content_hash || quote.content_hash !== quote.canonical_content_hash
            || quote.match_id !== row.match_id || quote.match_date !== row.match_date || !quote.source_observed_at) throw new SettlementCalculatorError("integrity");
          const observedAt=iso(quote.source_observed_at), collectedAt=iso(quote.collected_at), cutoff=iso(row.execution_cutoff_at), kickoff=iso(row.kickoff_at);
          if (Date.parse(observedAt)>Date.parse(collectedAt) || Date.parse(observedAt)>Date.parse(cutoff)
            || Date.parse(collectedAt)>Date.parse(cutoff) || Date.parse(observedAt)>=Date.parse(kickoff) || Date.parse(collectedAt)>=Date.parse(kickoff)) throw new SettlementCalculatorError("integrity");
          const handicap = normalizeHandicap(typeof odds.handicapLine === "string" ? odds.handicapLine : null);
          const water = waterMillionths(row.selection === "home" ? odds.handicapHome : odds.handicapAway);
          if (!handicap || !water) throw new SettlementCalculatorError("integrity");
          quarterUnits=handicap.quarterUnits; selectedWater=water;
          quoteEvidence={ actualQuote:{ snapshotId:boundId, contentHash:String(quote.content_hash), source:String(quote.source), observedAt, collectedAt,
            handicapRaw:handicap.raw, handicapQuarterUnits:quarterUnits, selectedWaterRaw:water.raw, selectedWater:water.decimal, selectedWaterMillionths:water.millionths } };
        }
        const quoteHandicapRaw=input.quoteBasis === "actual" ? String((quoteEvidence.actualQuote as Record<string,unknown>).handicapRaw) : String((quoteEvidence.theoreticalQuote as Record<string,unknown>).handicapRaw);
        if (resultStatus.data === "special") {
          if (homeScore !== null || awayScore !== null || revisionDraft.sourceSettledAt !== null) throw new SettlementCalculatorError("integrity");
          return Object.freeze({ matchResultId:revisionDraft.sourceMatchResultId, outcome:"unavailable", profitMicros:null, profitDecimal:null,
            isCounted:false, settlementBasis:input.quoteBasis === "actual" ? "actual_quote" : "theoretical_quote",
            quoteHandicapRaw,quoteHandicapQuarterUnits:quarterUnits,quoteSelectedWater:selectedWater.decimal,quoteSelectedWaterMillionths:selectedWater.millionths,
            legs:[],calculatorVersion:SETTLEMENT_CALCULATOR_VERSION, matchResultRevisionDraft:revisionDraft,
            evidence:{ schemaVersion:"strategy-lab-settlement-evidence-v2", reasonCode:`result_special:${revisionDraft.scoreSource}`, selection:String(row.selection),
              handicapQuarterUnits:quarterUnits,selectedWaterMillionths:selectedWater.millionths,selectedWater:selectedWater.decimal,legs:[],...quoteEvidence } });
        }
        if (homeScore === null || awayScore === null || homeScore < 0 || awayScore < 0 || !revisionDraft.sourceSettledAt) throw new SettlementCalculatorError("integrity");
        const settled=calculateAsianSettlement({ selection:row.selection as "home"|"away", handicapQuarterUnits:quarterUnits,
          homeScore, awayScore, selectedWaterMillionths:selectedWater.millionths });
        return Object.freeze({ matchResultId:revisionDraft.sourceMatchResultId, outcome:settled.outcome, profitMicros:settled.profitMicros,
          profitDecimal:settled.profitDecimal, isCounted:true, settlementBasis:input.quoteBasis === "actual" ? "actual_quote" : "theoretical_quote",
          quoteHandicapRaw,
          quoteHandicapQuarterUnits:quarterUnits,quoteSelectedWater:selectedWater.decimal,quoteSelectedWaterMillionths:selectedWater.millionths,
          legs:settled.legs.map(leg=>({ handicapQuarterUnits:leg.handicapQuarterUnits, stakeMicros:leg.stakeMicros, result:leg.result, profitMicros:leg.profitMicros })),
          calculatorVersion:SETTLEMENT_CALCULATOR_VERSION, matchResultRevisionDraft:revisionDraft,
          evidence:{ schemaVersion:"strategy-lab-settlement-evidence-v2", reasonCode:"finished", selection:String(row.selection),
            handicapQuarterUnits:quarterUnits, selectedWaterMillionths:selectedWater.millionths, selectedWater:selectedWater.decimal,
            legs:settled.legs.map(leg=>({ handicapQuarterUnits:leg.handicapQuarterUnits, stakeMicros:leg.stakeMicros, result:leg.result, profitMicros:leg.profitMicros })), ...quoteEvidence } });
      }, { readOnly:true, isolationLevel:"repeatable read" });
    } catch (error) {
      if (error instanceof SettlementCalculatorError) throw error;
      throw new SettlementCalculatorError("dependency");
    }
  }
}
