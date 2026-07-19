import { createHash, randomUUID } from "node:crypto";
import { evaluateStrategyA } from "./strategy-a";
import { evaluateStrategyB } from "./strategy-b";
import { evaluateStrategyC } from "./strategy-c";
import { deepFreeze, stableStrategyJson } from "./normalization";
import { StrategyLabRepositoryError } from "./repository-errors";
import { StrategyLabServiceError } from "./service-errors";
import type { StrategyCExecutor, StrategyCReadinessData, StrategyEvaluationInput, StrategyId } from "./types";
import type {
  CommandResult, StrategyLabCommandContext, StrategyLabPredictionRecord, StrategyLabRepository,
  StrategyLabRunRecord, StrategyLabSnapshotSetRecord, SettlementLegEvidence,
} from "./repository";
import {
  captureSnapshotApplicationSchema, createRunApplicationSchema, createSettlementApplicationSchema,
  executeStrategyApplicationSchema, strategyLabIdSchema, transitionRunApplicationSchema,
  type CaptureSnapshotApplicationInput, type CreateRunApplicationInput, type CreateSettlementApplicationInput,
  type ExecuteStrategyApplicationInput, type TransitionRunApplicationInput,
} from "./application-schemas";
import {
  createStrategyLabRunSchema, createStrategyLabSnapshotSetSchema,
  strategyDecisionPayloadSchema, type StrategyLabCommandAction, type StrategyLabJsonValue,
} from "./persistence-schemas";
import type { StrategyArtifactDescriptor, StrategyArtifactRuntimeRegistry } from "./strategy-runtime";
import { computeStrategySnapshotSetHash } from "./snapshot-contract";
import { SettlementCalculatorError } from "./postgres-settlement-calculator";
import { computeMatchResultRevisionHash, computeSettlementEvidenceHash } from "./settlement-evidence";

export interface StrategyLabActorContext { readonly actorId: string; readonly traceId: string }
export interface SnapshotStrategyEvidence {
  readonly input: Readonly<StrategyEvaluationInput>;
  readonly cData: Readonly<StrategyCReadinessData>;
  readonly evidenceContentHash: string;
  readonly currentOddsSnapshotId: number | null;
}
export interface SnapshotInputProvider { load(snapshotSetId: string): Promise<Readonly<SnapshotStrategyEvidence> | null> }
export interface SnapshotCaptureValidator { validate(input: Readonly<CaptureSnapshotApplicationInput>, run: Readonly<StrategyLabRunRecord>): Promise<void> }
export class StrategyLabSnapshotIntegrityError extends Error { constructor(){super("Strategy laboratory snapshot evidence is inconsistent");this.name="StrategyLabSnapshotIntegrityError";delete this.stack;} }
export class StrategyLabSnapshotDependencyError extends Error { constructor(){super("Strategy laboratory snapshot dependency is unavailable");this.name="StrategyLabSnapshotDependencyError";delete this.stack;} }
export interface StrategyLabPolicySnapshot {
  readonly mode: "user_focused_leagues";
  readonly artifactHash: string;
  readonly captureId: string;
  readonly capturedAt: string;
  readonly datasetCutoffAt: string;
}
export interface StrategyLabVersionSnapshot {
  readonly codeVersion: string;
  readonly strategyVersions: Readonly<Record<StrategyId, StrategyArtifactDescriptor>>;
  readonly leaguePolicy: Readonly<StrategyLabPolicySnapshot>;
}
export interface StrategyLabVersionProvider { load(input: { datasetCutoffAt: string; createdBy: string; traceId: string }): Promise<Readonly<StrategyLabVersionSnapshot>> }
export interface StrategyLabLeaguePolicy { allows(input: { matchId: string; matchDate: string; policyArtifactHash: string; policyCaptureId: string; datasetCutoffAt: string }): Promise<boolean> }
export interface SettlementCalculation {
  readonly matchResultId: number;
  readonly outcome: "win" | "half_win" | "push" | "half_loss" | "loss" | "unavailable";
  readonly profitMicros: number | null;
  readonly profitDecimal: string | null;
  readonly isCounted: boolean;
  readonly settlementBasis: "actual_quote" | "theoretical_quote";
  readonly evidence: Readonly<Record<string, StrategyLabJsonValue>>;
  readonly calculatorVersion: string;
  readonly quoteHandicapRaw: string;
  readonly quoteHandicapQuarterUnits: number;
  readonly quoteSelectedWater: string;
  readonly quoteSelectedWaterMillionths: number;
  readonly legs: readonly Readonly<SettlementLegEvidence>[];
  readonly matchResultRevisionDraft: Readonly<Record<string, StrategyLabJsonValue>>;
}
export interface SettlementCalculator {
  calculate(input: { prediction: Readonly<StrategyLabPredictionRecord>; quoteBasis: "actual" | "theoretical"; actualQuoteSnapshotId: number | null }): Promise<Readonly<SettlementCalculation>>;
}
export interface StrategyLabApplicationDependencies {
  repository: StrategyLabRepository;
  snapshotProvider: SnapshotInputProvider;
  captureValidator: SnapshotCaptureValidator;
  leaguePolicy: StrategyLabLeaguePolicy;
  versionProvider?: StrategyLabVersionProvider;
  runtimeRegistry: StrategyArtifactRuntimeRegistry;
  currentBuildId: string;
  settlementCalculator?: SettlementCalculator;
  cExecutor?: StrategyCExecutor;
  clock?: () => Date;
  idFactory?: () => string;
}

const sha256 = (value: unknown) => createHash("sha256").update(stableStrategyJson(value)).digest("hex");
const bindKey = (operationKey: string, ...identity: string[]) => `${operationKey}:${sha256(identity).slice(0, 24)}`;

export class StrategyLabApplicationService {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  constructor(private readonly dependencies: StrategyLabApplicationDependencies) {
    this.clock = dependencies.clock ?? (() => new Date());
    this.idFactory = dependencies.idFactory ?? randomUUID;
  }

  async createRun(raw: CreateRunApplicationInput, actor: StrategyLabActorContext) {
    const input = this.parse(createRunApplicationSchema, raw);
    const action = "run.create" as const;
    const payloadHash = sha256(input);
    const replay = await this.replay<StrategyLabRunRecord>(action, input.operationKey, payloadHash, "run");
    if (replay) return replay;
    const versions = await this.loadVersions(input.datasetCutoffAt, actor);
    const command = this.parse(createStrategyLabRunSchema, {
      id: this.idFactory(), runType: "shadow", status: "pending", datasetMode: "strict_asof",
      startDate: input.startDate, endDate: input.endDate, datasetCutoffAt: input.datasetCutoffAt,
      strategyVersions: versions.strategyVersions,
      configuration: { policy: versions.leaguePolicy }, codeVersion: versions.codeVersion,
      idempotencyKey: bindKey(input.operationKey, "shadow", input.startDate, input.endDate),
      createdBy: actor.actorId, traceId: actor.traceId,
    });
    return this.call(() => this.dependencies.repository.createRunWithReceipt(command, this.context(action, input.operationKey, payloadHash, actor)));
  }

  async transitionRun(raw: TransitionRunApplicationInput, actor: StrategyLabActorContext) {
    const input = this.parse(transitionRunApplicationSchema, raw);
    const action = "run.transition" as const;
    const payloadHash = sha256(input);
    const replay = await this.replay<StrategyLabRunRecord>(action, input.operationKey, payloadHash, "run");
    if (replay) return replay;
    return this.call(() => this.dependencies.repository.transitionRunWithReceipt(input, this.context(action, input.operationKey, payloadHash, actor)));
  }

  async captureSnapshotSet(raw: CaptureSnapshotApplicationInput, actor: StrategyLabActorContext) {
    const input = this.parse(captureSnapshotApplicationSchema, raw);
    const action = "snapshot.capture" as const;
    const payloadHash = sha256(input);
    const replay = await this.replay<StrategyLabSnapshotSetRecord>(action, input.operationKey, payloadHash, "snapshot");
    if (replay) return replay;
    const run = await this.requireRunningShadowRun(input.runId);
    this.assertSnapshotWithinRun(run, input);
    await this.requirePolicy(run, input.matchId, input.matchDate);
    if (!this.dependencies.captureValidator) throw new StrategyLabServiceError("dependency_unavailable");
    try { await this.dependencies.captureValidator.validate(input, run); }
    catch(error){ if(error instanceof StrategyLabSnapshotIntegrityError) throw new StrategyLabServiceError("integrity_error"); throw new StrategyLabServiceError("dependency_unavailable"); }
    const { items, ...withOperation } = input;
    const { operationKey, ...snapshot } = withOperation;
    void operationKey;
    const contentHash = computeStrategySnapshotSetHash({ ...snapshot, datasetMode: run.datasetMode }, items);
    const command = this.parse(createStrategyLabSnapshotSetSchema, {
      ...snapshot, id: this.idFactory(), datasetMode: run.datasetMode, contentHash, traceId: actor.traceId,
    });
    return this.call(() => this.dependencies.repository.createSnapshotSetWithItemsAndReceipt(
      command, items, this.context(action, input.operationKey, payloadHash, actor),
    ));
  }

  async executeStrategy(raw: ExecuteStrategyApplicationInput, actor: StrategyLabActorContext) {
    const input = this.parse(executeStrategyApplicationSchema, raw);
    const action = "prediction.execute" as const;
    const payloadHash = sha256(input);
    const replay = await this.replay<StrategyLabPredictionRecord>(action, input.operationKey, payloadHash, "prediction");
    if (replay) return replay;
    if (input.strategy === "D") throw new StrategyLabServiceError("strategy_d_not_executable");
    const run = await this.requireRunningShadowRun(input.runId);
    const snapshot = await this.authoritativeSnapshot(input.snapshotSetId);
    if (snapshot.runId !== run.id) throw new StrategyLabServiceError("integrity_error");
    this.assertSnapshotWithinRun(run, snapshot);
    await this.requirePolicy(run, snapshot.matchId, snapshot.matchDate);
    const strategyArtifact = this.strategyArtifact(run, input.strategy);
    if (!strategyArtifact.executable || !this.dependencies.runtimeRegistry.resolve({ descriptor: strategyArtifact, runBuildId: run.codeVersion, currentBuildId: this.dependencies.currentBuildId })) throw new StrategyLabServiceError("dependency_unavailable");
    const strategyVersion = strategyArtifact.version;
    const evidence = await this.loadEvidence(snapshot.id);
    if (evidence.evidenceContentHash !== snapshot.contentHash || evidence.input.checkpoint !== snapshot.checkpointType) {
      throw new StrategyLabServiceError("integrity_error");
    }
    let result;
    try {
      result = input.strategy === "A" ? evaluateStrategyA(evidence.input)
        : input.strategy === "B" ? evaluateStrategyB(evidence.input)
          : evaluateStrategyC({ ...evidence.input, cData: evidence.cData }, this.dependencies.cExecutor);
    } catch (error) {
      if (error instanceof TypeError) throw new StrategyLabServiceError("integrity_error");
      throw new StrategyLabServiceError("dependency_unavailable");
    }
    const payload = this.parse(strategyDecisionPayloadSchema, {
      current: result.meta.normalizedCurrent, previousEffective: result.meta.normalizedPreviousEffective,
      waterDiffBasisPoints: result.meta.waterDiffBasisPoints,
      details: { schemaVersion: 1, snapshotSetId: snapshot.id, snapshotContentHash: snapshot.contentHash },
    });
    const fallbackReason = input.strategy === "C" && result.meta.executedStrategy === "A" ? "missing_critical_data" : null;
    const recommend = result.decision.status === "recommend";
    const normalized = result.meta.normalizedCurrent;
    if (recommend && (!normalized || !result.decision.side || evidence.currentOddsSnapshotId === null)) throw new StrategyLabServiceError("integrity_error");
    const selectedWater = recommend && normalized
      ? (result.decision.side === "home" ? normalized.homeWater : normalized.awayWater)
      : null;
    const command = {
      id: this.idFactory(), runId: run.id, matchId: snapshot.matchId, matchDate: snapshot.matchDate,
      checkpointType: snapshot.checkpointType, snapshotSetId: snapshot.id, requestedStrategy: input.strategy,
      executedStrategy: result.meta.executedStrategy, strategyVersion, decisionStatus: result.decision.status,
      selection: result.decision.side, lockedDeterministic: result.decision.lockedByDeterministicRule,
      reasonCode: result.decision.reasonCode, branchId: result.decision.branchId,
      inputHash: sha256({ snapshotSetId: snapshot.id, contentHash: snapshot.contentHash, strategy: input.strategy, version: strategyVersion }),
      outputHash: sha256({ decision: result.decision, meta: result.meta, fallbackReason }), decisionPayload: payload,
      fallbackReason, legacyPredictionId: null, source: "experiment" as const,
      idempotencyKey: bindKey(input.operationKey, run.id, snapshot.id, input.strategy), traceId: actor.traceId,
      evidenceContractVersion: 2 as const,
      executionCutoffAt: recommend ? snapshot.checkpointAt : null,
      executedActualQuoteSnapshotId: recommend ? evidence.currentOddsSnapshotId : null,
      theoreticalHandicapRaw: recommend ? normalized!.handicap.raw : null,
      theoreticalHandicapQuarterUnits: recommend ? normalized!.handicap.quarterUnits : null,
      theoreticalSelectedWater: recommend ? `${Math.floor(selectedWater!.basisPoints / 10_000)}.${String((selectedWater!.basisPoints % 10_000) * 100).padStart(6, "0")}` : null,
    };
    return this.call(() => this.dependencies.repository.createPredictionWithReceipt(
      command, this.context(action, input.operationKey, payloadHash, actor),
    ));
  }

  async createSettlement(raw: CreateSettlementApplicationInput, actor: StrategyLabActorContext) {
    const input = this.parse(createSettlementApplicationSchema, raw);
    const action = "settlement.create" as const;
    const payloadHash = sha256(input);
    const replay = await this.replay(action, input.operationKey, payloadHash, "settlement");
    if (replay) return replay;
    if (!this.dependencies.settlementCalculator) throw new StrategyLabServiceError("capability_unavailable");
    const prediction = await this.call(() => this.dependencies.repository.getPredictionById(input.predictionId));
    if (!prediction) throw new StrategyLabServiceError("not_found");
    if (prediction.decisionStatus !== "recommend" || prediction.selection === null) throw new StrategyLabServiceError("validation_error");
    const run = await this.requireSettlementShadowRun(prediction.runId);
    if (run.id !== prediction.runId) throw new StrategyLabServiceError("integrity_error");
    await this.requirePolicy(run, prediction.matchId, prediction.matchDate);
    let calculated: SettlementCalculation;
    try {
      calculated = await this.dependencies.settlementCalculator.calculate({
        prediction, quoteBasis: input.quoteBasis,
        actualQuoteSnapshotId: input.quoteBasis === "actual" ? prediction.executedActualQuoteSnapshotId : null,
      });
    } catch (error) {
      if(error instanceof SettlementCalculatorError) throw new StrategyLabServiceError(error.code==="dependency"?"dependency_unavailable":error.code==="integrity"?"integrity_error":"validation_error");
      throw new StrategyLabServiceError("dependency_unavailable");
    }
    const evidence = {
      ...calculated.evidence,
      operationBinding: bindKey(input.operationKey, prediction.id, input.quoteBasis, String(prediction.executedActualQuoteSnapshotId ?? "theoretical")),
    };
    const revisionHash = computeMatchResultRevisionHash(calculated.matchResultRevisionDraft as never);
    const finalEvidenceHash = computeSettlementEvidenceHash({ calculatorVersion: calculated.calculatorVersion,
      operationBinding: String(evidence.operationBinding), predictionId: prediction.id, matchResultRevisionHash: revisionHash,
      quoteBasis: input.quoteBasis, actualQuoteSnapshotId: input.quoteBasis === "actual" ? prediction.executedActualQuoteSnapshotId : null,
      quoteHandicapRaw: calculated.quoteHandicapRaw, quoteHandicapQuarterUnits: calculated.quoteHandicapQuarterUnits,
      quoteSelectedWater: calculated.quoteSelectedWater, quoteSelectedWaterMillionths: calculated.quoteSelectedWaterMillionths,
      outcome: calculated.outcome, profitMicros: calculated.profitMicros, profitDecimal: calculated.profitDecimal,
      legs: [...calculated.legs], evidence });
    const command = {
      predictionId: prediction.id, matchResultId: calculated.matchResultId,
      actualQuoteSnapshotId: input.quoteBasis === "actual" ? prediction.executedActualQuoteSnapshotId : null, quoteBasis: input.quoteBasis,
      outcome: calculated.outcome, profitUnits: calculated.profitMicros === null ? null : calculated.profitMicros / 1_000_000, isCounted: calculated.isCounted,
      profitMicros: calculated.profitMicros, profitDecimal: calculated.profitDecimal, legs: calculated.legs,
      settlementBasis: calculated.settlementBasis, evidence, settledAt: this.clock().toISOString(),
      calculatorVersion: calculated.calculatorVersion, evidenceHash: finalEvidenceHash,
      quoteHandicapRaw: calculated.quoteHandicapRaw,
      quoteHandicapQuarterUnits: calculated.quoteHandicapQuarterUnits,
      quoteSelectedWater: calculated.quoteSelectedWater,
      quoteSelectedWaterMillionths: calculated.quoteSelectedWaterMillionths,
      matchResultRevisionDraft: { ...calculated.matchResultRevisionDraft, contentHash: revisionHash } as never,
      settledBy: actor.actorId, traceId: actor.traceId,
    };
    return this.call(() => this.dependencies.repository.createNextSettlementWithReceipt(
      command, this.context(action, input.operationKey, payloadHash, actor),
    ));
  }

  getSnapshotSet(id: string) { return this.get(id, value => this.dependencies.repository.getSnapshotSetById(value)); }
  getRun(id: string) { return this.get(id, value => this.dependencies.repository.getRunById(value)); }
  getPrediction(id: string) { return this.get(id, value => this.dependencies.repository.getPredictionById(value)); }
  getSettlement(id: string) { return this.get(id, value => this.dependencies.repository.getSettlementById(value)); }
  markCommandAudit(action: StrategyLabCommandAction, operationKey: string, succeeded: boolean, safeErrorCode?: string) {
    return this.call(() => this.dependencies.repository.markCommandReceiptAudit(action, operationKey, succeeded, safeErrorCode));
  }

  private context(action: StrategyLabCommandAction, operationKey: string, payloadHash: string, actor: StrategyLabActorContext): StrategyLabCommandContext {
    return { action, operationKey, payloadHash, actorId: actor.actorId, requestId: actor.traceId };
  }
  private async replay<T>(action: StrategyLabCommandAction, key: string, payloadHash: string, type: "run" | "snapshot" | "prediction" | "settlement"): Promise<CommandResult<T> | null> {
    const receipt = await this.call(() => this.dependencies.repository.getCommandReceipt(action, key));
    if (!receipt) return null;
    if (receipt.payloadHash !== payloadHash) throw new StrategyLabServiceError("idempotency_conflict");
    let value: unknown;
    if (type === "run") value = await this.call(() => this.dependencies.repository.getRunById(receipt.resultId));
    else if (type === "snapshot") value = await this.call(() => this.dependencies.repository.getSnapshotSetById(receipt.resultId));
    else if (type === "prediction") value = await this.call(() => this.dependencies.repository.getPredictionById(receipt.resultId));
    else value = await this.call(() => this.dependencies.repository.getSettlementById(receipt.resultId));
    if (!value) throw new StrategyLabServiceError("integrity_error");
    return deepFreeze({ status: "existing", replayed: true, value: value as T, receipt }) as CommandResult<T>;
  }
  private async loadVersions(datasetCutoffAt: string, actor: StrategyLabActorContext) {
    if (!this.dependencies.versionProvider) throw new StrategyLabServiceError("dependency_unavailable");
    try {
      const value = await this.dependencies.versionProvider.load({ datasetCutoffAt, createdBy: actor.actorId, traceId: actor.traceId });
      if (!value.codeVersion || !value.strategyVersions.A || !value.strategyVersions.B || !value.strategyVersions.C || value.strategyVersions.D.executable
        || value.leaguePolicy.mode !== "user_focused_leagues" || !value.leaguePolicy.artifactHash || !value.leaguePolicy.captureId
        || value.leaguePolicy.datasetCutoffAt !== datasetCutoffAt) {
        throw new Error("invalid version snapshot");
      }
      return value;
    } catch { throw new StrategyLabServiceError("dependency_unavailable"); }
  }
  private async loadEvidence(snapshotId: string) {
    try {
      const value = await this.dependencies.snapshotProvider.load(snapshotId);
      if (!value) throw new StrategyLabServiceError("not_found");
      return value;
    } catch (error) {
      if (error instanceof StrategyLabServiceError) throw error;
      if (error instanceof StrategyLabSnapshotIntegrityError) throw new StrategyLabServiceError("integrity_error");
      if (error instanceof StrategyLabSnapshotDependencyError) throw new StrategyLabServiceError("dependency_unavailable");
      throw new StrategyLabServiceError("dependency_unavailable");
    }
  }
  private async requirePolicy(run: StrategyLabRunRecord, matchId: string, matchDate: string) {
    try {
      const policy = run.configuration.policy;
      if (!policy || policy.datasetCutoffAt !== run.datasetCutoffAt) throw new StrategyLabServiceError("integrity_error");
      if (!await this.dependencies.leaguePolicy.allows({ matchId, matchDate, policyArtifactHash: policy.artifactHash, policyCaptureId: policy.captureId, datasetCutoffAt: run.datasetCutoffAt })) throw new StrategyLabServiceError("policy_denied");
    } catch (error) {
      if (error instanceof StrategyLabServiceError) throw error;
      throw new StrategyLabServiceError("dependency_unavailable");
    }
  }
  private async requireRunningShadowRun(id: string) {
    const run = await this.call(() => this.dependencies.repository.getRunById(id));
    if (!run) throw new StrategyLabServiceError("not_found");
    if (run.runType !== "shadow" || run.status !== "running" || run.datasetMode !== "strict_asof" || !run.datasetCutoffAt) {
      throw new StrategyLabServiceError("integrity_error");
    }
    return run;
  }
  private async requireSettlementShadowRun(id: string) {
    const run=await this.call(()=>this.dependencies.repository.getRunById(id));
    if(!run)throw new StrategyLabServiceError("not_found");
    if(run.runType!=="shadow"||!(run.status==="running"||run.status==="succeeded")||run.datasetMode!=="strict_asof")throw new StrategyLabServiceError("integrity_error");
    return run;
  }
  private async authoritativeSnapshot(id: string) {
    const snapshot = await this.call(() => this.dependencies.repository.getSnapshotSetById(id));
    if (!snapshot) throw new StrategyLabServiceError("not_found");
    return snapshot;
  }
  private assertSnapshotWithinRun(run: StrategyLabRunRecord, snapshot: { matchDate: string; datasetMode?: string; checkpointAt: string; sourceCutoffAt: string }) {
    if (snapshot.matchDate < run.startDate || snapshot.matchDate > run.endDate
      || (snapshot.datasetMode && snapshot.datasetMode !== run.datasetMode)
      || Date.parse(snapshot.checkpointAt) > Date.parse(run.datasetCutoffAt)
      || Date.parse(snapshot.sourceCutoffAt) > Date.parse(run.datasetCutoffAt)) {
      throw new StrategyLabServiceError("integrity_error");
    }
  }
  private strategyArtifact(run: StrategyLabRunRecord, strategy: StrategyId): StrategyArtifactDescriptor {
    return run.strategyVersions[strategy];
  }
  private async get<T>(raw: string, load: (id: string) => Promise<T | null>): Promise<Readonly<T>> {
    const id = this.parse(strategyLabIdSchema, raw); const value = await this.call(() => load(id));
    if (!value) throw new StrategyLabServiceError("not_found"); return deepFreeze(value) as Readonly<T>;
  }
  private parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
    const result = schema.safeParse(value); if (!result.success) throw new StrategyLabServiceError("validation_error"); return result.data;
  }
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try { return deepFreeze(await operation()) as T; }
    catch (error) {
      if (error instanceof StrategyLabServiceError) throw error;
      if (error instanceof StrategyLabRepositoryError) throw new StrategyLabServiceError(error.code);
      throw new StrategyLabServiceError("unexpected");
    }
  }
}
