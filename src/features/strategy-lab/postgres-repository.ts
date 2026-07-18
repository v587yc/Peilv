import { randomUUID } from "node:crypto";
import { z } from "zod";
import { deepFreeze, stableStrategyJson } from "./normalization";
import {
  createStrategyLabPredictionSchema,
  createStrategyLabRunSchema,
  createStrategyLabSettlementSchema,
  createStrategyLabSnapshotItemSchema,
  createStrategyLabSnapshotSetSchema,
  canonicalUtcMillisecondsSchema,
  strategyLabProfitUnitsSchema,
  strategyLabCommandReceiptSchema,
  type StrategyLabCommandAction,
  type StrategyLabCommandReceipt,
  type CreateStrategyLabSnapshotItem,
  type CreateStrategyLabSnapshotSet,
} from "./persistence-schemas";
import {
  type CreateResult,
  type PredictionCreateCommand,
  type RunCreateCommand,
  type RunTransitionCommand,
  type SettlementCreateCommand,
  type NextSettlementCreateCommand,
  type StrategyLabCommandContext,
  type CommandResult,
  type SnapshotItemCreateCommand,
  type SnapshotSetCreateCommand,
  type StrategyLabPredictionRecord,
  type StrategyLabRepository,
  type StrategyLabRunRecord,
  type StrategyLabSettlementRecord,
  type StrategyLabSnapshotSetRecord,
} from "./repository";
import { StrategyLabRepositoryError, isStrategyLabRepositoryError } from "./repository-errors";
import { computeMatchResultRevisionHash, computeSettlementEvidenceHash } from "./settlement-evidence";
import { calculateAsianSettlement } from "@/lib/verification/asian-settlement";
import { canonicalJsonSha256 } from "@/lib/canonical-json";
import { normalizeHandicap } from "./normalization";

export interface StrategyLabSqlResult<Row> { readonly rows: readonly Row[] }
export interface StrategyLabSqlExecutor {
  query<Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]): Promise<StrategyLabSqlResult<Row>>;
}
export interface StrategyLabSqlClient extends StrategyLabSqlExecutor {
  transaction<T>(callback: (transaction: StrategyLabSqlExecutor) => Promise<T>, options?: Readonly<{ readOnly?: boolean; isolationLevel?: "repeatable read" }>): Promise<T>;
}

export interface PostgresStrategyLabRepositoryOptions {
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
}

type DbRow = Record<string, unknown>;
type DbError = { code?: unknown; constraint?: unknown };

const uuidSchema = z.string().uuid();
const runStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "cancelled"]);
const transitionCommandSchema = z.object({
  id: uuidSchema,
  transition: z.enum(["pending_to_running", "pending_to_cancelled", "running_to_succeeded", "running_to_failed", "running_to_cancelled"]),
  expectedCurrentStatus: z.enum(["pending", "running"]),
  previousUpdatedAt: canonicalUtcMillisecondsSchema,
  errorSummary: z.string().max(2_000).nullable().optional(),
});
const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const iso = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw validationError();
  return date.toISOString();
};
const nullableIso = (value: unknown): string | null => value === null || value === undefined ? null : iso(value);
const objectValue = (value: unknown): Record<string, unknown> => typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : jsonClone(value as Record<string, unknown>);

function validationError(): StrategyLabRepositoryError {
  return new StrategyLabRepositoryError("validation_error");
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError();
  return result.data;
}

function mapDatabaseError(error: unknown): StrategyLabRepositoryError {
  if (isStrategyLabRepositoryError(error)) return error;
  const code = typeof error === "object" && error !== null ? String((error as DbError).code ?? "") : "";
  if (code === "23503" || code === "23514" || code === "P0001" || code === "23P01") {
    return new StrategyLabRepositoryError("integrity_error");
  }
  if (code === "23505" || code.startsWith("22")) return new StrategyLabRepositoryError(code === "23505" ? "integrity_error" : "validation_error");
  return new StrategyLabRepositoryError("unexpected");
}

const UNIQUE_CONSTRAINTS = {
  snapshot: new Set(["strategy_lab_snapshot_sets_revision_unique", "strategy_lab_snapshot_sets_content_unique"]),
  run: new Set(["strategy_lab_experiment_runs_idempotency_key_key"]),
  prediction: new Set(["strategy_lab_predictions_idempotency_key_key", "strategy_lab_predictions_matrix_unique"]),
  settlement: new Set(["strategy_lab_settlements_revision_unique"]),
} as const;

function uniqueConstraint(error: unknown): string | null {
  if (!error || typeof error !== "object" || String((error as DbError).code ?? "") !== "23505") return null;
  const constraint = (error as DbError).constraint;
  return typeof constraint === "string" && constraint !== "" ? constraint : null;
}

function canonicalProfitDecimal(value: number): string {
  const parsed = strategyLabProfitUnitsSchema.safeParse(value);
  if (!parsed.success) throw validationError();
  const fixed = parsed.data.toFixed(6);
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function profitFromDatabase(value: unknown): number | null {
  if (value === null) return null;
  const raw = String(value);
  if (!/^-?\d{1,6}(?:\.\d{1,6})?$/.test(raw)) throw validationError();
  const parsed = Number(raw);
  if (!strategyLabProfitUnitsSchema.safeParse(parsed).success) throw validationError();
  return parsed;
}

function canonicalSixFromMillionths(value: number): string {
  if (!Number.isSafeInteger(value)) throw validationError();
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 1_000_000)}.${String(absolute % 1_000_000).padStart(6, "0")}`;
}

function parseUnsignedDecimalMillionths(value: unknown): { readonly raw: string; readonly decimal: string; readonly millionths: number } {
  if (typeof value !== "string") throw new StrategyLabRepositoryError("integrity_error");
  const raw = value.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(raw);
  if (!match) throw new StrategyLabRepositoryError("integrity_error");
  const millionths = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(millionths) || millionths < 1 || millionths > 5_000_000) throw new StrategyLabRepositoryError("integrity_error");
  return { raw, decimal: canonicalSixFromMillionths(millionths), millionths };
}

function strictNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(parsed)) throw new StrategyLabRepositoryError("integrity_error");
  return parsed;
}

function snapshotFromRow(row: DbRow): StrategyLabSnapshotSetRecord {
  const value = parseInput(createStrategyLabSnapshotSetSchema, {
    id: row.id, runId: row.run_id, matchId: row.match_id, matchDate: row.match_date, checkpointType: row.checkpoint_type,
    checkpointAt: iso(row.checkpoint_at), datasetMode: row.dataset_mode, status: row.status,
    previousSnapshotSetId: row.previous_snapshot_set_id, revision: row.revision,
    supersedesSnapshotSetId: row.supersedes_snapshot_set_id, sourceCutoffAt: iso(row.source_cutoff_at),
    contentHash: row.content_hash, schemaVersion: row.schema_version, completeness: objectValue(row.completeness), traceId: row.trace_id,
  });
  return deepFreeze({ ...value, createdAt: iso(row.created_at) }) as StrategyLabSnapshotSetRecord;
}

function receiptFromRow(row: DbRow): StrategyLabCommandReceipt {
  return deepFreeze(parseInput(strategyLabCommandReceiptSchema, {
    id: row.id, action: row.action, operationKey: row.operation_key, payloadHash: row.payload_hash,
    status: row.status, resultType: row.result_type, resultId: row.result_id, actorId: row.actor_id,
    requestId: row.request_id, auditAttempts: row.audit_attempts,
    lastAuditErrorCode: row.last_audit_error_code, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    auditedAt: nullableIso(row.audited_at),
  })) as StrategyLabCommandReceipt;
}

function runFromRow(row: DbRow): StrategyLabRunRecord {
  const base = parseInput(createStrategyLabRunSchema, {
    id: row.id, runType: row.run_type, status: "pending", datasetMode: row.dataset_mode,
    startDate: row.start_date, endDate: row.end_date, datasetCutoffAt: iso(row.dataset_cutoff_at),
    strategyVersions: objectValue(row.strategy_versions), configuration: objectValue(row.configuration),
    codeVersion: row.code_version, idempotencyKey: row.idempotency_key, createdBy: row.created_by,
    traceId: row.trace_id, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  });
  return deepFreeze({
    ...base, status: runStatusSchema.parse(row.status),
    errorSummary: row.error_summary === null ? null : z.string().parse(row.error_summary),
    startedAt: nullableIso(row.started_at), finishedAt: nullableIso(row.finished_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  }) as StrategyLabRunRecord;
}

function predictionFromRow(row: DbRow): StrategyLabPredictionRecord {
  const value = parseInput(createStrategyLabPredictionSchema, {
    id: row.id, runId: row.run_id, matchId: row.match_id, matchDate: row.match_date,
    checkpointType: row.checkpoint_type, snapshotSetId: row.snapshot_set_id,
    requestedStrategy: row.requested_strategy, executedStrategy: row.executed_strategy,
    strategyVersion: row.strategy_version, decisionStatus: row.decision_status, selection: row.selection,
    lockedDeterministic: row.locked_deterministic, reasonCode: row.reason_code, branchId: row.branch_id,
    inputHash: row.input_hash, outputHash: row.output_hash, decisionPayload: objectValue(row.decision_payload),
    fallbackReason: row.fallback_reason, legacyPredictionId: row.legacy_prediction_id,
    source: row.source, idempotencyKey: row.idempotency_key, traceId: row.trace_id,
    evidenceContractVersion: row.evidence_contract_version ?? 1,
    executionCutoffAt: nullableIso(row.execution_cutoff_at),
    executedActualQuoteSnapshotId: row.executed_actual_quote_snapshot_id === null || row.executed_actual_quote_snapshot_id === undefined ? null : Number(row.executed_actual_quote_snapshot_id),
    theoreticalHandicapRaw: row.theoretical_handicap_raw ?? null,
    theoreticalHandicapQuarterUnits: row.theoretical_handicap_quarter_units === null || row.theoretical_handicap_quarter_units === undefined ? null : Number(row.theoretical_handicap_quarter_units),
    theoreticalSelectedWater: row.theoretical_selected_water === null || row.theoretical_selected_water === undefined ? null : String(row.theoretical_selected_water),
  });
  return deepFreeze({ ...value, createdAt: iso(row.created_at) }) as StrategyLabPredictionRecord;
}

function settlementFromRow(row: DbRow): StrategyLabSettlementRecord {
  const value = parseInput(createStrategyLabSettlementSchema, {
    id: row.id, predictionId: row.prediction_id, revision: row.revision, matchResultId: row.match_result_id,
    matchResultRevisionId: row.match_result_revision_id ?? null, calculatorVersion: row.calculator_version ?? null,
    evidenceHash: row.evidence_hash ?? null,
    quoteHandicapRaw: row.quote_handicap_raw ?? null,
    quoteHandicapQuarterUnits: strictNullableInteger(row.quote_handicap_quarter_units),
    quoteSelectedWater: row.quote_selected_water === null || row.quote_selected_water === undefined ? null : String(row.quote_selected_water),
    quoteSelectedWaterMillionths: strictNullableInteger(row.quote_selected_water_millionths),
    actualQuoteSnapshotId: row.actual_quote_snapshot_id, quoteBasis: row.quote_basis, outcome: row.outcome,
    profitUnits: profitFromDatabase(row.profit_units), isCounted: row.is_counted,
    settlementBasis: row.settlement_basis, evidence: objectValue(row.evidence), settledAt: iso(row.settled_at),
    settledBy: row.settled_by, supersedes: row.supersedes, traceId: row.trace_id,
  });
  return deepFreeze({ ...value, createdAt: iso(row.created_at) }) as StrategyLabSettlementRecord;
}

const SNAPSHOT_SELECT = `SELECT * FROM strategy_lab_snapshot_sets`;
const RUN_SELECT = `SELECT * FROM strategy_lab_experiment_runs`;
const PREDICTION_SELECT = `SELECT * FROM strategy_lab_predictions`;
const SETTLEMENT_SELECT = `SELECT * FROM strategy_lab_settlements`;
const RECEIPT_SELECT = `SELECT * FROM strategy_lab_command_receipts`;

function samePayload(left: unknown, right: unknown, ignored: readonly string[] = ["id", "createdAt", "updatedAt"]): boolean {
  const strip = (value: unknown) => Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !ignored.includes(key)));
  return stableStrategyJson(strip(left)) === stableStrategyJson(strip(right));
}

function snapshotIdentity(value: CreateStrategyLabSnapshotSet | StrategyLabSnapshotSetRecord) {
  return {
    runId: value.runId,
    matchId: value.matchId,
    matchDate: value.matchDate,
    checkpointType: value.checkpointType,
    checkpointAt: value.checkpointAt,
    datasetMode: value.datasetMode,
    status: value.status,
    previousSnapshotSetId: value.previousSnapshotSetId,
    revision: value.revision,
    supersedesSnapshotSetId: value.supersedesSnapshotSetId,
    sourceCutoffAt: value.sourceCutoffAt,
    contentHash: value.contentHash,
    schemaVersion: value.schemaVersion,
    completeness: value.completeness,
    traceId: value.traceId,
  };
}

function snapshotItemIdentity(value: CreateStrategyLabSnapshotItem | DbRow) {
  return {
    oddsSnapshotId: "oddsSnapshotId" in value ? value.oddsSnapshotId : value.odds_snapshot_id,
    role: value.role,
    companyId: "companyId" in value ? value.companyId : value.company_id,
    marketType: "marketType" in value ? value.marketType : value.market_type,
    snapshotType: "snapshotType" in value ? value.snapshotType : value.snapshot_type,
    sourceObservedAt: "sourceObservedAt" in value ? value.sourceObservedAt : nullableIso(value.source_observed_at),
    collectedAt: "collectedAt" in value ? value.collectedAt : iso(value.collected_at),
  };
}

function canonicalSnapshotItems(values: readonly (CreateStrategyLabSnapshotItem | DbRow)[]): string[] {
  return values.map(value => stableStrategyJson(snapshotItemIdentity(value))).sort();
}

function runIdentity(value: RunCreateCommand | StrategyLabRunRecord) {
  return {
    runType: value.runType, datasetMode: value.datasetMode, startDate: value.startDate, endDate: value.endDate,
    datasetCutoffAt: value.datasetCutoffAt, strategyVersions: value.strategyVersions,
    configuration: value.configuration, codeVersion: value.codeVersion, idempotencyKey: value.idempotencyKey,
    createdBy: value.createdBy, traceId: value.traceId,
  };
}

export class PostgresStrategyLabRepository implements StrategyLabRepository {
  private readonly idFactory: () => string;
  private readonly clock: () => Date;

  constructor(private readonly client: StrategyLabSqlClient, options: PostgresStrategyLabRepositoryOptions = {}) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
  }

  async getSnapshotSetById(id: string) { return this.findOne(`${SNAPSHOT_SELECT} WHERE id=$1`, [this.parseId(id)], snapshotFromRow); }
  async getRunById(id: string) { return this.findOne(`${RUN_SELECT} WHERE id=$1`, [this.parseId(id)], runFromRow); }
  async getPredictionById(id: string) { return this.findOne(`${PREDICTION_SELECT} WHERE id=$1`, [this.parseId(id)], predictionFromRow); }
  async getSettlementById(id: string) { return this.findOne(`${SETTLEMENT_SELECT} WHERE id=$1`, [this.parseId(id)], settlementFromRow); }
  async getCommandReceipt(action: StrategyLabCommandAction, operationKey: string) {
    return this.findOne(`${RECEIPT_SELECT} WHERE action=$1 AND operation_key=$2`, [action, operationKey], receiptFromRow);
  }
  async listPendingCommandReceipts(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw validationError();
    const result = await this.client.query<DbRow>(`${RECEIPT_SELECT} WHERE status='audit_pending' ORDER BY created_at LIMIT $1`, [limit]);
    return deepFreeze(result.rows.map(receiptFromRow));
  }
  async markCommandReceiptAudit(action: StrategyLabCommandAction, operationKey: string, succeeded: boolean, safeErrorCode?: string) {
    const now = iso(this.clock());
    const result = await this.client.query<DbRow>(`UPDATE strategy_lab_command_receipts SET
      status=$1,last_audit_error_code=$2,audit_attempts=audit_attempts+1,updated_at=$3,
      audited_at=CASE WHEN $1='audited' THEN $3::timestamptz ELSE NULL END
      WHERE action=$4 AND operation_key=$5 AND status='audit_pending' RETURNING *`, [
      succeeded ? "audited" : "audit_pending", succeeded ? null : (safeErrorCode || "AUDIT_FAILED"), now, action, operationKey,
    ]);
    if (result.rows[0]) return receiptFromRow(result.rows[0]);
    const existing = await this.getCommandReceipt(action, operationKey);
    if (!existing) throw new StrategyLabRepositoryError("not_found");
    return existing;
  }

  async createRunWithReceipt(command: Readonly<RunCreateCommand>, context: Readonly<StrategyLabCommandContext>) {
    return this.withReceipt(context, "strategy_lab_run", runFromRow, async transaction => {
      const now = iso(this.clock());
      const input = parseInput(createStrategyLabRunSchema, { ...command, id: command.id ?? this.idFactory(), createdAt: now, updatedAt: now });
      const result = await transaction.query<DbRow>(`INSERT INTO strategy_lab_experiment_runs(
        id,run_type,status,dataset_mode,start_date,end_date,dataset_cutoff_at,strategy_versions,configuration,
        code_version,idempotency_key,created_by,trace_id,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$14) RETURNING *`, [
        input.id,input.runType,input.status,input.datasetMode,input.startDate,input.endDate,input.datasetCutoffAt,
        JSON.stringify(input.strategyVersions),JSON.stringify(input.configuration),input.codeVersion,input.idempotencyKey,
        input.createdBy,input.traceId,now,
      ]);
      return runFromRow(result.rows[0]);
    });
  }

  async createSnapshotSetWithItemsAndReceipt(command: Readonly<SnapshotSetCreateCommand>, items: readonly Readonly<SnapshotItemCreateCommand>[], context: Readonly<StrategyLabCommandContext>) {
    return this.withReceipt(context, "strategy_lab_snapshot", snapshotFromRow, async transaction => {
      const input = parseInput(createStrategyLabSnapshotSetSchema, { ...command, id: command.id ?? this.idFactory() });
      const parsedItems = items.map(item => parseInput(createStrategyLabSnapshotItemSchema, { ...item, snapshotSetId: input.id }));
      const inserted = await transaction.query<DbRow>(`INSERT INTO strategy_lab_snapshot_sets(
        id,run_id,match_id,match_date,checkpoint_type,checkpoint_at,dataset_mode,status,previous_snapshot_set_id,revision,
        supersedes_snapshot_set_id,source_cutoff_at,content_hash,schema_version,completeness,trace_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16) RETURNING *`, [
        input.id,input.runId,input.matchId,input.matchDate,input.checkpointType,input.checkpointAt,input.datasetMode,input.status,
        input.previousSnapshotSetId,input.revision,input.supersedesSnapshotSetId,input.sourceCutoffAt,input.contentHash,
        input.schemaVersion,JSON.stringify(input.completeness),input.traceId,
      ]);
      for (const item of parsedItems) await transaction.query(`INSERT INTO strategy_lab_snapshot_items(
        snapshot_set_id,odds_snapshot_id,role,company_id,market_type,snapshot_type,source_observed_at,collected_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [item.snapshotSetId,item.oddsSnapshotId,item.role,item.companyId,item.marketType,item.snapshotType,item.sourceObservedAt,item.collectedAt]);
      return snapshotFromRow(inserted.rows[0]);
    });
  }

  async createPredictionWithReceipt(command: Readonly<PredictionCreateCommand>, context: Readonly<StrategyLabCommandContext>) {
    return this.withReceipt(context, "strategy_lab_prediction", predictionFromRow, async transaction => {
      const input = parseInput(createStrategyLabPredictionSchema, { ...command, id: command.id ?? this.idFactory() });
      const result = await transaction.query<DbRow>(`INSERT INTO strategy_lab_predictions(
        id,run_id,match_id,match_date,checkpoint_type,snapshot_set_id,requested_strategy,executed_strategy,
        strategy_version,decision_status,selection,locked_deterministic,reason_code,branch_id,input_hash,output_hash,
        decision_payload,fallback_reason,legacy_prediction_id,source,idempotency_key,trace_id,evidence_contract_version,
        execution_cutoff_at,executed_actual_quote_snapshot_id,theoretical_handicap_raw,theoretical_handicap_quarter_units,theoretical_selected_water
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::numeric) RETURNING *`, [
        input.id,input.runId,input.matchId,input.matchDate,input.checkpointType,input.snapshotSetId,input.requestedStrategy,
        input.executedStrategy,input.strategyVersion,input.decisionStatus,input.selection,input.lockedDeterministic,
        input.reasonCode,input.branchId,input.inputHash,input.outputHash,JSON.stringify(input.decisionPayload),input.fallbackReason,
        input.legacyPredictionId,input.source,input.idempotencyKey,input.traceId,input.evidenceContractVersion,input.executionCutoffAt,
        input.executedActualQuoteSnapshotId,input.theoreticalHandicapRaw,input.theoreticalHandicapQuarterUnits,input.theoreticalSelectedWater,
      ]);
      return predictionFromRow(result.rows[0]);
    });
  }

  async transitionRunWithReceipt(command: Readonly<RunTransitionCommand>, context: Readonly<StrategyLabCommandContext>) {
    return this.withReceipt(context, "strategy_lab_run", runFromRow, async transaction => this.transitionWithExecutor(transaction, command));
  }

  async createNextSettlementWithReceipt(command: Readonly<NextSettlementCreateCommand>, context: Readonly<StrategyLabCommandContext>) {
    return this.withReceipt(context, "strategy_lab_settlement", settlementFromRow, async transaction => {
       const predictionRows=await transaction.query<DbRow>(`SELECT p.*,r.status run_status,r.run_type,s.content_hash snapshot_content_hash
         FROM strategy_lab_predictions p JOIN strategy_lab_experiment_runs r ON r.id=p.run_id
         JOIN strategy_lab_snapshot_sets s ON s.id=p.snapshot_set_id WHERE p.id=$1 FOR UPDATE OF p,r,s`,[command.predictionId]);
       const prediction=predictionRows.rows[0];
       if(!prediction||prediction.decision_status!=="recommend"||(prediction.selection!=="home"&&prediction.selection!=="away")||Number(prediction.evidence_contract_version)!==2
         ||prediction.run_type!=="shadow"||!(prediction.run_status==="running"||prediction.run_status==="succeeded")) throw new StrategyLabRepositoryError("integrity_error");
       const expectedActual=prediction.executed_actual_quote_snapshot_id===null?null:Number(prediction.executed_actual_quote_snapshot_id);
       if(command.quoteBasis==="actual" ? command.actualQuoteSnapshotId!==expectedActual||expectedActual===null : command.actualQuoteSnapshotId!==null) throw new StrategyLabRepositoryError("integrity_error");
        const evidence=command.evidence as Record<string, unknown>;
        let authoritativeQuoteRaw: string;
        let authoritativeQuarterUnits: number;
        let authoritativeWaterDecimal: string;
        let authoritativeWaterMillionths: number;
        if(command.quoteBasis==="actual"){
         const quoteResult=await transaction.query<DbRow>(`SELECT o.*,f.kickoff_at FROM odds_snapshots o
           JOIN strategy_lab_match_facts f ON f.match_id=o.match_id AND f.match_date=o.match_date
           WHERE o.id=$1 ORDER BY f.revision DESC LIMIT 1 FOR SHARE OF o,f`,[expectedActual]);
         const quote=quoteResult.rows[0]; const quoteEvidence=evidence.actualQuote as Record<string,unknown>|undefined;
         if(!quote||!quoteEvidence||quote.company_id!=="3"||quote.market_type!=="asian_handicap"||quote.hash_version!=="canonical-json-v2"
           ||quote.match_id!==prediction.match_id||quote.match_date!==prediction.match_date||canonicalJsonSha256(objectValue(quote.odds))!==quote.canonical_content_hash
           ||quote.content_hash!==quote.canonical_content_hash||Number(quoteEvidence.snapshotId)!==expectedActual||quoteEvidence.contentHash!==quote.content_hash) throw new StrategyLabRepositoryError("integrity_error");
         const observed=iso(quote.source_observed_at),collected=iso(quote.collected_at),cutoff=iso(prediction.execution_cutoff_at),kickoff=iso(quote.kickoff_at);
         if(observed!==quoteEvidence.observedAt||collected!==quoteEvidence.collectedAt||Date.parse(observed)>Date.parse(collected)
           ||Date.parse(observed)>Date.parse(cutoff)||Date.parse(collected)>Date.parse(cutoff)||Date.parse(observed)>=Date.parse(kickoff)||Date.parse(collected)>=Date.parse(kickoff)) throw new StrategyLabRepositoryError("integrity_error");
          const odds=objectValue(quote.odds),line=normalizeHandicap(typeof odds.handicapLine==="string"?odds.handicapLine:null);
          if(!line) throw new StrategyLabRepositoryError("integrity_error");
          const selected=prediction.selection==="home"?odds.handicapHome:odds.handicapAway;
          const water=parseUnsignedDecimalMillionths(selected);
          authoritativeQuoteRaw=line.raw; authoritativeQuarterUnits=line.quarterUnits;
          authoritativeWaterDecimal=water.decimal; authoritativeWaterMillionths=water.millionths;
          if(line.quarterUnits!==strictNullableInteger(quoteEvidence.handicapQuarterUnits)||line.raw!==quoteEvidence.handicapRaw
            ||water.raw!==quoteEvidence.selectedWaterRaw||water.decimal!==quoteEvidence.selectedWater
            ||water.millionths!==strictNullableInteger(quoteEvidence.selectedWaterMillionths)) throw new StrategyLabRepositoryError("integrity_error");
        } else {
          const quoteEvidence=evidence.theoreticalQuote as Record<string,unknown>|undefined;
          const line=normalizeHandicap(typeof prediction.theoretical_handicap_raw==="string"?prediction.theoretical_handicap_raw:null);
          const storedQuarterUnits=strictNullableInteger(prediction.theoretical_handicap_quarter_units);
          const water=parseUnsignedDecimalMillionths(prediction.theoretical_selected_water);
          if(!line||storedQuarterUnits===null||line.quarterUnits!==storedQuarterUnits||!quoteEvidence
            ||quoteEvidence.snapshotSetId!==prediction.snapshot_set_id||quoteEvidence.snapshotContentHash!==prediction.snapshot_content_hash
            ||quoteEvidence.outputHash!==prediction.output_hash||quoteEvidence.handicapRaw!==prediction.theoretical_handicap_raw
            ||strictNullableInteger(quoteEvidence.handicapQuarterUnits)!==storedQuarterUnits
            ||quoteEvidence.selectedWater!==water.decimal||strictNullableInteger(quoteEvidence.selectedWaterMillionths)!==water.millionths) throw new StrategyLabRepositoryError("integrity_error");
          authoritativeQuoteRaw=line.raw; authoritativeQuarterUnits=storedQuarterUnits;
          authoritativeWaterDecimal=water.decimal; authoritativeWaterMillionths=water.millionths;
        }
        if(command.quoteHandicapRaw!==authoritativeQuoteRaw||command.quoteHandicapQuarterUnits!==authoritativeQuarterUnits
          ||command.quoteSelectedWater!==authoritativeWaterDecimal||command.quoteSelectedWaterMillionths!==authoritativeWaterMillionths) throw new StrategyLabRepositoryError("integrity_error");
       let matchResultRevisionId: string | null = null;
         const draft=command.matchResultRevisionDraft;
         const source=await transaction.query<DbRow>(`SELECT * FROM match_results WHERE id=$1 FOR UPDATE`,[draft.sourceMatchResultId]);
         const current=source.rows[0];
          const authoritativeDraft={sourceMatchResultId:draft.sourceMatchResultId,matchId:String(current?.match_id??""),matchDate:String(current?.match_date??""),
            status:String(current?.status??"") as "finished"|"pending"|"special",homeScore:strictNullableInteger(current?.home_score),awayScore:strictNullableInteger(current?.away_score),
            scoreSource:String(current?.score_source??""),sourceObservedAt:current?iso(current.observed_at):"",sourceSettledAt:current?nullableIso(current.settled_at):null,sourceUpdatedAt:current?iso(current.updated_at):""};
           const unhashedDraft=Object.fromEntries(Object.entries(draft).filter(([key])=>key!=="contentHash"));
          if(!current||command.matchResultId!==draft.sourceMatchResultId||prediction.match_id!==authoritativeDraft.matchId||prediction.match_date!==authoritativeDraft.matchDate
            ||stableStrategyJson(authoritativeDraft)!==stableStrategyJson(unhashedDraft)
            ||computeMatchResultRevisionHash(authoritativeDraft)!==draft.contentHash) throw new StrategyLabRepositoryError("integrity_error");
         if(authoritativeDraft.status==="pending") throw new StrategyLabRepositoryError("integrity_error");
         let authoritativeOutcome: NextSettlementCreateCommand["outcome"];
         let authoritativeProfitMicros: number|null;
         let authoritativeProfitDecimal: string|null;
         let authoritativeLegs: NextSettlementCreateCommand["legs"];
         if(authoritativeDraft.status==="special"){
           if(authoritativeDraft.homeScore!==null||authoritativeDraft.awayScore!==null||authoritativeDraft.sourceSettledAt!==null) throw new StrategyLabRepositoryError("integrity_error");
           authoritativeOutcome="unavailable"; authoritativeProfitMicros=null; authoritativeProfitDecimal=null; authoritativeLegs=[];
         } else {
           if(authoritativeDraft.homeScore===null||authoritativeDraft.awayScore===null||authoritativeDraft.sourceSettledAt===null) throw new StrategyLabRepositoryError("integrity_error");
           const settled=calculateAsianSettlement({selection:prediction.selection as "home"|"away",handicapQuarterUnits:authoritativeQuarterUnits,
             homeScore:authoritativeDraft.homeScore,awayScore:authoritativeDraft.awayScore,selectedWaterMillionths:authoritativeWaterMillionths});
           authoritativeOutcome=settled.outcome; authoritativeProfitMicros=settled.profitMicros; authoritativeProfitDecimal=settled.profitDecimal;
           authoritativeLegs=settled.legs.map(leg=>({handicapQuarterUnits:leg.handicapQuarterUnits,stakeMicros:leg.stakeMicros,result:leg.result,profitMicros:leg.profitMicros}));
         }
         const expectedProfitUnits=authoritativeProfitMicros===null?null:authoritativeProfitMicros/1_000_000;
         if(command.outcome!==authoritativeOutcome||command.profitMicros!==authoritativeProfitMicros||command.profitDecimal!==authoritativeProfitDecimal
           ||command.profitUnits!==expectedProfitUnits||command.isCounted!==(authoritativeOutcome!=="unavailable")
           ||stableStrategyJson(command.legs)!==stableStrategyJson(authoritativeLegs)
           ||evidence.handicapQuarterUnits!==authoritativeQuarterUnits||evidence.selectedWaterMillionths!==authoritativeWaterMillionths
           ||evidence.selectedWater!==authoritativeWaterDecimal||stableStrategyJson(evidence.legs)!==stableStrategyJson(authoritativeLegs)) throw new StrategyLabRepositoryError("integrity_error");
         const existing=await transaction.query<DbRow>(`SELECT id FROM strategy_lab_match_result_revisions WHERE source_match_result_id=$1 AND content_hash=$2`,[draft.sourceMatchResultId,draft.contentHash]);
        if(existing.rows[0]) matchResultRevisionId=String(existing.rows[0].id);
        else {
          await transaction.query(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`,[draft.matchId,draft.matchDate]);
          const latestRevision=await transaction.query<DbRow>(`SELECT id,revision FROM strategy_lab_match_result_revisions WHERE match_id=$1 AND match_date=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,[draft.matchId,draft.matchDate]);
          const resultId=this.idFactory(); const revision=latestRevision.rows[0]?Number(latestRevision.rows[0].revision)+1:1;
          await transaction.query(`INSERT INTO strategy_lab_match_result_revisions(id,source_match_result_id,match_id,match_date,status,home_score,away_score,score_source,source_observed_at,source_settled_at,source_updated_at,content_hash,revision,supersedes)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[resultId,draft.sourceMatchResultId,draft.matchId,draft.matchDate,draft.status,draft.homeScore,draft.awayScore,draft.scoreSource,draft.sourceObservedAt,draft.sourceSettledAt,draft.sourceUpdatedAt,draft.contentHash,revision,latestRevision.rows[0]?.id??null]);
          matchResultRevisionId=resultId;
      }
       await transaction.query(`SELECT pg_advisory_xact_lock(hashtext('strategy_lab_settlement'),hashtext($1))`,[command.predictionId]);
       const latest = await transaction.query<DbRow>(`${SETTLEMENT_SELECT} WHERE prediction_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`, [command.predictionId]);
      const revision = latest.rows[0] ? Number(latest.rows[0].revision) + 1 : 1;
      const supersedes = latest.rows[0] ? String(latest.rows[0].id) : null;
        const excludedSettlementFields=new Set(["matchResultRevisionDraft","profitMicros","profitDecimal","legs"]);
        const settlementCommand=Object.fromEntries(Object.entries(command).filter(([key])=>!excludedSettlementFields.has(key)));
       const input = parseInput(createStrategyLabSettlementSchema, { ...settlementCommand,matchResultRevisionId, id: this.idFactory(), revision, supersedes });
        const expectedEvidenceHash=computeSettlementEvidenceHash({calculatorVersion:input.calculatorVersion!,operationBinding:String(input.evidence.operationBinding),
          predictionId:input.predictionId,matchResultRevisionHash:command.matchResultRevisionDraft!.contentHash,quoteBasis:input.quoteBasis,
          actualQuoteSnapshotId:input.actualQuoteSnapshotId,quoteHandicapRaw:input.quoteHandicapRaw!,quoteHandicapQuarterUnits:input.quoteHandicapQuarterUnits!,
          quoteSelectedWater:input.quoteSelectedWater!,quoteSelectedWaterMillionths:input.quoteSelectedWaterMillionths!,outcome:input.outcome,
          profitMicros:command.profitMicros,profitDecimal:command.profitDecimal,legs:[...command.legs],evidence:input.evidence});
       if(expectedEvidenceHash!==input.evidenceHash) throw new StrategyLabRepositoryError("integrity_error");
      const result = await transaction.query<DbRow>(`INSERT INTO strategy_lab_settlements(
        id,prediction_id,revision,match_result_id,match_result_revision_id,actual_quote_snapshot_id,quote_basis,outcome,profit_units,is_counted,
         settlement_basis,evidence,calculator_version,evidence_hash,quote_handicap_raw,quote_handicap_quarter_units,
         quote_selected_water,quote_selected_water_millionths,settled_at,settled_by,supersedes,trace_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10,$11,$12::jsonb,$13,$14,$15,$16,$17::numeric,$18,$19,$20,$21,$22) RETURNING *`, [
        input.id,input.predictionId,input.revision,input.matchResultId,input.matchResultRevisionId,input.actualQuoteSnapshotId,input.quoteBasis,input.outcome,
        input.profitUnits===null?null:canonicalProfitDecimal(input.profitUnits),input.isCounted,input.settlementBasis,
         JSON.stringify(input.evidence),input.calculatorVersion,input.evidenceHash,input.quoteHandicapRaw,input.quoteHandicapQuarterUnits,
         input.quoteSelectedWater,input.quoteSelectedWaterMillionths,input.settledAt,input.settledBy,input.supersedes,input.traceId,
      ]);
      return settlementFromRow(result.rows[0]);
    });
  }

  async createSnapshotSetWithItems(command: Readonly<SnapshotSetCreateCommand>, items: readonly Readonly<SnapshotItemCreateCommand>[]): Promise<CreateResult<StrategyLabSnapshotSetRecord>> {
    const input = parseInput(createStrategyLabSnapshotSetSchema, { ...command, id: command.id ?? this.idFactory() });
    const parsedItems = items.map(item => parseInput(createStrategyLabSnapshotItemSchema, { ...item, snapshotSetId: input.id }));
    try {
      return await this.client.transaction(async transaction => {
        const conflict = await this.resolveSnapshotConflict(transaction, input, parsedItems);
        if (conflict) return conflict;
        const inserted = await transaction.query<DbRow>(`INSERT INTO strategy_lab_snapshot_sets(
          id,run_id,match_id,match_date,checkpoint_type,checkpoint_at,dataset_mode,status,previous_snapshot_set_id,revision,
          supersedes_snapshot_set_id,source_cutoff_at,content_hash,schema_version,completeness,trace_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16) RETURNING *`, [
          input.id, input.runId, input.matchId, input.matchDate, input.checkpointType, input.checkpointAt, input.datasetMode,
          input.status, input.previousSnapshotSetId, input.revision, input.supersedesSnapshotSetId,
          input.sourceCutoffAt, input.contentHash, input.schemaVersion, JSON.stringify(input.completeness), input.traceId,
        ]);
        for (const item of parsedItems) await transaction.query(`INSERT INTO strategy_lab_snapshot_items(
          snapshot_set_id,odds_snapshot_id,role,company_id,market_type,snapshot_type,source_observed_at,collected_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [item.snapshotSetId, item.oddsSnapshotId, item.role, item.companyId, item.marketType, item.snapshotType, item.sourceObservedAt, item.collectedAt]);
        return { status: "created", value: snapshotFromRow(inserted.rows[0]) } as const;
      });
    } catch (error) {
      const constraint = uniqueConstraint(error);
      if (constraint && UNIQUE_CONSTRAINTS.snapshot.has(constraint)) {
        const conflict = await this.resolveSnapshotConflict(this.client, input, parsedItems);
        if (conflict) return conflict;
      }
      throw mapDatabaseError(error);
    }
  }

  async createRun(command: Readonly<RunCreateCommand>): Promise<CreateResult<StrategyLabRunRecord>> {
    const now = this.clock().toISOString();
    const input = parseInput(createStrategyLabRunSchema, { ...command, id: command.id ?? this.idFactory(), createdAt: now, updatedAt: now });
    try {
      const result = await this.client.query<DbRow>(`INSERT INTO strategy_lab_experiment_runs(
        id,run_type,status,dataset_mode,start_date,end_date,dataset_cutoff_at,strategy_versions,configuration,
        code_version,idempotency_key,created_by,trace_id,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$14) RETURNING *`, [
        input.id, input.runType, input.status, input.datasetMode, input.startDate, input.endDate,
        input.datasetCutoffAt, JSON.stringify(input.strategyVersions), JSON.stringify(input.configuration),
        input.codeVersion, input.idempotencyKey, input.createdBy, input.traceId, now,
      ]);
      return { status: "created", value: runFromRow(result.rows[0]) };
    } catch (error) {
      const constraint = uniqueConstraint(error);
      if (!constraint || !UNIQUE_CONSTRAINTS.run.has(constraint)) throw mapDatabaseError(error);
      const existing = await this.findOne(`${RUN_SELECT} WHERE idempotency_key=$1`, [input.idempotencyKey], runFromRow);
      if (existing && stableStrategyJson(runIdentity(input)) === stableStrategyJson(runIdentity(existing))) {
        return { status: "existing", value: existing };
      }
      throw new StrategyLabRepositoryError("idempotency_conflict");
    }
  }

  async transitionRun(command: Readonly<RunTransitionCommand>): Promise<Readonly<StrategyLabRunRecord>> {
    return this.transitionWithExecutor(this.client, command);
  }

  private async transitionWithExecutor(executor: StrategyLabSqlExecutor, command: Readonly<RunTransitionCommand>): Promise<Readonly<StrategyLabRunRecord>> {
    const parsed = parseInput(transitionCommandSchema, { ...command, errorSummary: command.errorSummary ?? null });
    const now = iso(this.clock());
    const targets = {
      pending_to_running: ["pending", "running"], pending_to_cancelled: ["pending", "cancelled"],
      running_to_succeeded: ["running", "succeeded"], running_to_failed: ["running", "failed"],
      running_to_cancelled: ["running", "cancelled"],
    } as const;
    const target = targets[parsed.transition];
    if (target[0] !== parsed.expectedCurrentStatus) throw validationError();
    try {
      const result = await executor.query<DbRow>(`WITH target AS (
          SELECT id FROM strategy_lab_experiment_runs WHERE id=$1
        ), updated AS (
          UPDATE strategy_lab_experiment_runs AS run SET
            status=$2,error_summary=$3,
            started_at=CASE WHEN $4='pending_to_running' THEN $5::timestamptz ELSE run.started_at END,
            finished_at=CASE WHEN $2='running' THEN NULL ELSE $5::timestamptz END,
            updated_at=$5::timestamptz
          WHERE run.id=$1 AND run.status=$6
            AND date_trunc('milliseconds',run.updated_at)=$7::timestamptz
          RETURNING run.*
        )
        SELECT 'updated' AS kind,to_jsonb(updated) AS row_data FROM updated
        UNION ALL
        SELECT CASE WHEN EXISTS(SELECT 1 FROM target) THEN 'concurrency_conflict' ELSE 'not_found' END AS kind,
          NULL::jsonb AS row_data
        WHERE NOT EXISTS(SELECT 1 FROM updated)`, [
        parsed.id, target[1], parsed.errorSummary, parsed.transition, now,
        parsed.expectedCurrentStatus, parsed.previousUpdatedAt,
      ]);
      const classified = result.rows[0];
      if (classified?.kind === "updated") return runFromRow(objectValue(classified.row_data));
      if (classified?.kind === "not_found") throw new StrategyLabRepositoryError("not_found");
      if (classified?.kind === "concurrency_conflict") throw new StrategyLabRepositoryError("concurrency_conflict");
      throw new StrategyLabRepositoryError("unexpected");
    } catch (error) { throw mapDatabaseError(error); }
  }

  async createPrediction(command: Readonly<PredictionCreateCommand>): Promise<CreateResult<StrategyLabPredictionRecord>> {
    const input = parseInput(createStrategyLabPredictionSchema, { ...command, id: command.id ?? this.idFactory() });
    try {
      const result = await this.client.query<DbRow>(`INSERT INTO strategy_lab_predictions(
        id,run_id,match_id,match_date,checkpoint_type,snapshot_set_id,requested_strategy,executed_strategy,
        strategy_version,decision_status,selection,locked_deterministic,reason_code,branch_id,input_hash,output_hash,
        decision_payload,fallback_reason,legacy_prediction_id,source,idempotency_key,trace_id,evidence_contract_version,
        execution_cutoff_at,executed_actual_quote_snapshot_id,theoretical_handicap_raw,theoretical_handicap_quarter_units,theoretical_selected_water
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::numeric) RETURNING *`, [
        input.id, input.runId, input.matchId, input.matchDate, input.checkpointType, input.snapshotSetId,
        input.requestedStrategy, input.executedStrategy, input.strategyVersion, input.decisionStatus, input.selection,
        input.lockedDeterministic, input.reasonCode, input.branchId, input.inputHash, input.outputHash,
        JSON.stringify(input.decisionPayload), input.fallbackReason, input.legacyPredictionId, input.source,
        input.idempotencyKey, input.traceId,input.evidenceContractVersion,input.executionCutoffAt,input.executedActualQuoteSnapshotId,
        input.theoreticalHandicapRaw,input.theoreticalHandicapQuarterUnits,input.theoreticalSelectedWater,
      ]);
      return { status: "created", value: predictionFromRow(result.rows[0]) };
    } catch (error) {
      const constraint = uniqueConstraint(error);
      if (!constraint || !UNIQUE_CONSTRAINTS.prediction.has(constraint)) throw mapDatabaseError(error);
      const existing = constraint === "strategy_lab_predictions_idempotency_key_key"
        ? await this.findOne(`${PREDICTION_SELECT} WHERE idempotency_key=$1`, [input.idempotencyKey], predictionFromRow)
        : await this.findOne(`${PREDICTION_SELECT} WHERE run_id=$1 AND match_id=$2 AND match_date=$3 AND checkpoint_type=$4 AND requested_strategy=$5`, [
          input.runId, input.matchId, input.matchDate, input.checkpointType, input.requestedStrategy,
        ], predictionFromRow);
      const ignored = constraint === "strategy_lab_predictions_matrix_unique"
        ? ["id", "createdAt", "updatedAt", "idempotencyKey"]
        : undefined;
      if (existing && samePayload(input, existing, ignored)) return { status: "existing", value: existing };
      throw new StrategyLabRepositoryError("idempotency_conflict");
    }
  }

  async createSettlement(command: Readonly<SettlementCreateCommand>): Promise<CreateResult<StrategyLabSettlementRecord>> {
    const input = parseInput(createStrategyLabSettlementSchema, { ...command, id: command.id ?? this.idFactory() });
    try {
      const result = await this.client.query<DbRow>(`INSERT INTO strategy_lab_settlements(
        id,prediction_id,revision,match_result_id,match_result_revision_id,actual_quote_snapshot_id,quote_basis,outcome,profit_units,
        is_counted,settlement_basis,evidence,calculator_version,evidence_hash,quote_handicap_raw,quote_handicap_quarter_units,
        quote_selected_water,quote_selected_water_millionths,settled_at,settled_by,supersedes,trace_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10,$11,$12::jsonb,$13,$14,$15,$16,$17::numeric,$18,$19,$20,$21,$22) RETURNING *`, [
        input.id, input.predictionId, input.revision, input.matchResultId,input.matchResultRevisionId,input.actualQuoteSnapshotId,
        input.quoteBasis, input.outcome, input.profitUnits === null ? null : canonicalProfitDecimal(input.profitUnits),
        input.isCounted, input.settlementBasis, JSON.stringify(input.evidence),input.calculatorVersion,input.evidenceHash,
        input.quoteHandicapRaw,input.quoteHandicapQuarterUnits,input.quoteSelectedWater,input.quoteSelectedWaterMillionths,input.settledAt,
        input.settledBy, input.supersedes, input.traceId,
      ]);
      return { status: "created", value: settlementFromRow(result.rows[0]) };
    } catch (error) {
      const constraint = uniqueConstraint(error);
      if (!constraint || !UNIQUE_CONSTRAINTS.settlement.has(constraint)) throw mapDatabaseError(error);
      const existing = await this.findOne(`${SETTLEMENT_SELECT} WHERE prediction_id=$1 AND revision=$2`, [input.predictionId, input.revision], settlementFromRow);
      if (existing && samePayload(input, existing)) return { status: "existing", value: existing };
      throw new StrategyLabRepositoryError("idempotency_conflict");
    }
  }

  private parseId(id: string): string {
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) throw validationError();
    return parsed.data;
  }

  private async withReceipt<T>(
    context: Readonly<StrategyLabCommandContext>,
    resultType: string,
    mapper: (row: DbRow) => T,
    effect: (transaction: StrategyLabSqlExecutor) => Promise<T>,
  ): Promise<CommandResult<T>> {
    try {
      return await this.client.transaction(async transaction => {
        await transaction.query(
          "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
          [context.action, context.operationKey],
        );
        const receiptRows = await transaction.query<DbRow>(`${RECEIPT_SELECT} WHERE action=$1 AND operation_key=$2 FOR UPDATE`, [context.action, context.operationKey]);
        if (receiptRows.rows[0]) {
          const receipt = receiptFromRow(receiptRows.rows[0]);
          if (receipt.payloadHash !== context.payloadHash) throw new StrategyLabRepositoryError("idempotency_conflict");
          const table = receipt.resultType === "strategy_lab_run" ? "strategy_lab_experiment_runs"
            : receipt.resultType === "strategy_lab_snapshot" ? "strategy_lab_snapshot_sets"
              : receipt.resultType === "strategy_lab_prediction" ? "strategy_lab_predictions"
                : receipt.resultType === "strategy_lab_settlement" ? "strategy_lab_settlements" : null;
          if (!table || receipt.resultType !== resultType) throw new StrategyLabRepositoryError("integrity_error");
          const found = await transaction.query<DbRow>(`SELECT * FROM ${table} WHERE id=$1`, [receipt.resultId]);
          if (!found.rows[0]) throw new StrategyLabRepositoryError("integrity_error");
          return deepFreeze({ status: "existing" as const, replayed: true, value: mapper(found.rows[0]), receipt });
        }
        const value = await effect(transaction);
        const now = iso(this.clock());
        const inserted = await transaction.query<DbRow>(`INSERT INTO strategy_lab_command_receipts(
          id,action,operation_key,payload_hash,status,result_type,result_id,actor_id,request_id,created_at,updated_at
        ) VALUES($1,$2,$3,$4,'audit_pending',$5,$6,$7,$8,$9,$9) RETURNING *`, [
          this.idFactory(),context.action,context.operationKey,context.payloadHash,resultType,
          (value as { id: string }).id,context.actorId,context.requestId,now,
        ]);
        return deepFreeze({ status: "created" as const, replayed: false, value, receipt: receiptFromRow(inserted.rows[0]) });
      });
    } catch (error) {
      const constraint = uniqueConstraint(error);
      if (constraint === "strategy_lab_command_receipts_action_key_unique") {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const recovered = await this.recoverReceiptResult(context, resultType, mapper);
          if (recovered) return recovered;
          await Promise.resolve();
        }
        throw new StrategyLabRepositoryError("concurrency_conflict");
      }
      throw mapDatabaseError(error);
    }
  }

  private async recoverReceiptResult<T>(
    context: Readonly<StrategyLabCommandContext>,
    resultType: string,
    mapper: (row: DbRow) => T,
  ): Promise<CommandResult<T> | null> {
    const receipt = await this.getCommandReceipt(context.action, context.operationKey);
    if (!receipt) return null;
    if (receipt.payloadHash !== context.payloadHash) throw new StrategyLabRepositoryError("idempotency_conflict");
    if (receipt.resultType !== resultType) throw new StrategyLabRepositoryError("integrity_error");
    const table = resultType === "strategy_lab_run" ? "strategy_lab_experiment_runs"
      : resultType === "strategy_lab_snapshot" ? "strategy_lab_snapshot_sets"
        : resultType === "strategy_lab_prediction" ? "strategy_lab_predictions"
          : resultType === "strategy_lab_settlement" ? "strategy_lab_settlements" : null;
    if (!table) throw new StrategyLabRepositoryError("integrity_error");
    const found = await this.client.query<DbRow>(`SELECT * FROM ${table} WHERE id=$1`, [receipt.resultId]);
    if (!found.rows[0]) throw new StrategyLabRepositoryError("integrity_error");
    return deepFreeze({ status: "existing", replayed: true, value: mapper(found.rows[0]), receipt });
  }

  private async findOne<T>(sql: string, parameters: readonly unknown[], mapper: (row: DbRow) => T): Promise<T | null> {
    try {
      const result = await this.client.query<DbRow>(sql, parameters);
      return result.rows[0] ? mapper(result.rows[0]) : null;
    } catch (error) { throw mapDatabaseError(error); }
  }

  private async resolveSnapshotConflict(executor: StrategyLabSqlExecutor, input: CreateStrategyLabSnapshotSet, items: readonly CreateStrategyLabSnapshotItem[]): Promise<CreateResult<StrategyLabSnapshotSetRecord> | null> {
    const result = await executor.query<DbRow>(`${SNAPSHOT_SELECT} WHERE
      run_id=$1 AND match_id=$2 AND match_date=$3 AND checkpoint_type=$4 AND checkpoint_at=$5 AND dataset_mode=$6
      AND schema_version=$7 AND (revision=$8 OR content_hash=$9)`, [
      input.runId, input.matchId, input.matchDate, input.checkpointType, input.checkpointAt, input.datasetMode,
      input.schemaVersion, input.revision, input.contentHash,
    ]);
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw new StrategyLabRepositoryError("idempotency_conflict");
    const existing = snapshotFromRow(result.rows[0]);
    const itemRows = await executor.query<DbRow>(`SELECT snapshot_set_id,odds_snapshot_id,role,company_id,market_type,
      snapshot_type,source_observed_at,collected_at FROM strategy_lab_snapshot_items WHERE snapshot_set_id=$1 ORDER BY odds_snapshot_id,role`, [existing.id]);
    const sameIdentity = stableStrategyJson(snapshotIdentity(input)) === stableStrategyJson(snapshotIdentity(existing));
    const sameItems = stableStrategyJson(canonicalSnapshotItems(items)) === stableStrategyJson(canonicalSnapshotItems(itemRows.rows));
    if (sameIdentity && sameItems) {
      return { status: "existing", value: existing };
    }
    throw new StrategyLabRepositoryError("idempotency_conflict");
  }
}
