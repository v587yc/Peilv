import { describe, expect, it, vi } from "vitest";
import {
  StrategyLabApplicationService,
  type SettlementCalculator,
  type SnapshotInputProvider,
  type StrategyLabLeaguePolicy,
  type StrategyLabVersionProvider,
} from "@/features/strategy-lab/application-service";
import type {
  CommandResult, StrategyLabPredictionRecord, StrategyLabRepository, StrategyLabRunRecord,
  StrategyLabSnapshotSetRecord,
} from "@/features/strategy-lab/repository";
import type { StrategyLabCommandAction, StrategyLabCommandReceipt } from "@/features/strategy-lab/persistence-schemas";
import type { StrategyCExecutor } from "@/features/strategy-lab/types";
import { BUILT_IN_STRATEGY_ARTIFACTS } from "@/features/strategy-lab/strategy-artifacts";
import { BuiltInStrategyArtifactRuntimeRegistry } from "@/features/strategy-lab/strategy-runtime";

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const run: StrategyLabRunRecord = {
  id: id(10), runType: "shadow", status: "running", datasetMode: "strict_asof",
  startDate: "20260717", endDate: "20260717", datasetCutoffAt: "2026-07-17T13:00:00.000Z",
  strategyVersions: BUILT_IN_STRATEGY_ARTIFACTS,
  configuration: { policy: { mode: "user_focused_leagues", artifactHash: "a".repeat(64), captureId: id(80), capturedAt: "2026-07-17T13:00:00.000Z", datasetCutoffAt: "2026-07-17T13:00:00.000Z", evidenceHash:"b".repeat(64) } },
  codeVersion: "code-v1", idempotencyKey: "run-key", createdBy: "admin", traceId: "trace",
  errorSummary: null, startedAt: "2026-07-17T11:01:00.000Z", finishedAt: null,
  createdAt: "2026-07-17T11:00:00.000Z", updatedAt: "2026-07-17T11:01:00.000Z",
};
const snapshot: StrategyLabSnapshotSetRecord = {
  id: id(1), runId: run.id, matchId: "m1", matchDate: "20260717", checkpointType: "T1215",
  checkpointAt: "2026-07-17T12:15:00.000Z", datasetMode: "strict_asof", status: "ready",
  previousSnapshotSetId: null, revision: 1, supersedesSnapshotSetId: null,
  sourceCutoffAt: "2026-07-17T12:15:00.000Z", contentHash: "snapshot-content",
  schemaVersion: 2, completeness: { ready: true }, traceId: "trace", createdAt: "2026-07-17T12:15:00.000Z",
};
const evidence = {
  input: { checkpoint: "T1215" as const, current: { homeWater: "0.90", awayWater: "0.98", handicap: "半球" } },
  cData: { marketConsensus: null, liquidityProfile: "normal", teamContext: "known" },
  evidenceContentHash: snapshot.contentHash,
  currentOddsSnapshotId: 2,
};
const actor = { actorId: "real-admin", traceId: "request-real" };

function receipt(action: StrategyLabCommandAction, key: string, resultId: string): StrategyLabCommandReceipt {
  const resultType = action.startsWith("run.") ? "strategy_lab_run"
    : action === "snapshot.capture" ? "strategy_lab_snapshot"
      : action === "prediction.execute" ? "strategy_lab_prediction" : "strategy_lab_settlement";
  return { id: id(900), action, operationKey: key, payloadHash: "a".repeat(64), status: "audit_pending", resultType, resultId, actorId: actor.actorId, requestId: actor.traceId, auditAttempts: 0, lastAuditErrorCode: null, createdAt: "2026-07-17T11:00:00.000Z", updatedAt: "2026-07-17T11:00:00.000Z", auditedAt: null };
}
function commandResult<T extends { id: string }>(action: StrategyLabCommandAction, key: string, value: T): CommandResult<T> {
  return { status: "created", replayed: false, value, receipt: receipt(action, key, value.id) };
}

function harness(options: { policy?: boolean; policyThrows?: boolean; calculator?: SettlementCalculator; cExecutor?: StrategyCExecutor } = {}) {
  const prediction: StrategyLabPredictionRecord = {
    id: id(20), runId: run.id, matchId: "m1", matchDate: "20260717", checkpointType: "T1215",
    snapshotSetId: snapshot.id, requestedStrategy: "A", executedStrategy: "A", strategyVersion: "A-v1",
    decisionStatus: "recommend", selection: "home", lockedDeterministic: true, reasonCode: "A", branchId: "A-1",
    inputHash: "in", outputHash: "out", decisionPayload: { current: null, previousEffective: null, waterDiffBasisPoints: null, details: {} },
    fallbackReason: null, legacyPredictionId: null, source: "experiment", idempotencyKey: "key", traceId: "trace", createdAt: "2026-07-17T12:16:00.000Z",
    evidenceContractVersion: 2, executionCutoffAt: snapshot.checkpointAt, executedActualQuoteSnapshotId: 2,
    theoreticalHandicapRaw: "半球", theoreticalHandicapQuarterUnits: 2, theoreticalSelectedWater: "0.900000",
  };
  const repository = {
    createSnapshotSetWithItems: vi.fn(), createRun: vi.fn(), transitionRun: vi.fn(), createPrediction: vi.fn(), createSettlement: vi.fn(),
    createRunWithReceipt: vi.fn(async command => commandResult("run.create", "run-op", { ...run, ...command })),
    transitionRunWithReceipt: vi.fn(async () => commandResult("run.transition", "transition-op", run)),
    createSnapshotSetWithItemsAndReceipt: vi.fn(async command => commandResult("snapshot.capture", "snapshot-op", { ...snapshot, ...command })),
    createPredictionWithReceipt: vi.fn(async (command, context) => {
      void context;
      return commandResult("prediction.execute", "prediction-op", { ...prediction, ...command });
    }),
    createNextSettlementWithReceipt: vi.fn(async (command, context) => {
      void context;
      return commandResult("settlement.create", "settlement-op", { id: id(30), revision: 1, supersedes: null, createdAt: "2026-07-17T15:00:00.000Z", ...command });
    }),
    getCommandReceipt: vi.fn<StrategyLabRepository["getCommandReceipt"]>(async () => null), markCommandReceiptAudit: vi.fn(), listPendingCommandReceipts: vi.fn(async () => []),
    getSnapshotSetById: vi.fn(async () => snapshot), getRunById: vi.fn(async () => run), getPredictionById: vi.fn(async () => prediction), getSettlementById: vi.fn(async () => null),
  } satisfies StrategyLabRepository;
  const provider: SnapshotInputProvider = { load: vi.fn(async () => evidence) };
  const captureValidator = { validate: vi.fn(async () => undefined) };
  const policy: StrategyLabLeaguePolicy = { allows: vi.fn(async () => {
    if (options.policyThrows) throw new Error("policy backend unavailable");
    return options.policy ?? true;
  }) };
  const versionProvider: StrategyLabVersionProvider = { load: vi.fn(async () => ({
    codeVersion: "code-v1", strategyVersions: BUILT_IN_STRATEGY_ARTIFACTS,
    leaguePolicy: { mode: "user_focused_leagues" as const, artifactHash: "a".repeat(64), captureId: id(80), capturedAt: "2026-07-17T13:00:00.000Z", datasetCutoffAt: "2026-07-17T13:00:00.000Z", evidenceHash:"b".repeat(64) },
  })) };
  let sequence = 100;
  const service = new StrategyLabApplicationService({ repository, snapshotProvider: provider, captureValidator, leaguePolicy: policy, versionProvider, runtimeRegistry: new BuiltInStrategyArtifactRuntimeRegistry(BUILT_IN_STRATEGY_ARTIFACTS), currentBuildId: "code-v1", settlementCalculator: options.calculator, cExecutor: options.cExecutor, idFactory: () => id(sequence++), clock: () => new Date("2026-07-17T15:00:00.000Z") });
  return { service, repository, provider, captureValidator, policy, versionProvider, prediction };
}

const createRun = { startDate: "20260717", endDate: "20260717", datasetCutoffAt: "2026-07-17T13:00:00.000Z", operationKey: "run-operation-0001" };
const execute = (strategy: "A" | "B" | "C" | "D") => ({ runId: run.id, snapshotSetId: snapshot.id, strategy, operationKey: `execute-${strategy}-0001` });

describe("strategy lab authoritative application service", () => {
  it("fixes management runs to shadow and injects server versions and policy snapshot", async () => {
    const { service, repository } = harness();
    await service.createRun(createRun, actor);
    expect(repository.createRunWithReceipt).toHaveBeenCalledWith(expect.objectContaining({
      runType: "shadow", datasetMode: "strict_asof", strategyVersions: BUILT_IN_STRATEGY_ARTIFACTS,
      codeVersion: "code-v1", configuration: { policy: expect.objectContaining({ mode: "user_focused_leagues", artifactHash: "a".repeat(64), captureId: id(80), evidenceHash:"b".repeat(64) }) },
      createdBy: actor.actorId, traceId: actor.traceId,
    }), expect.objectContaining({ action: "run.create", actorId: actor.actorId }));
  });

  it.each(["manual", "backtest"])("strictly rejects client runType %s and version forgery", async runType => {
    const { service, repository } = harness();
    await expect(service.createRun({ ...createRun, runType, strategyVersions: { A: "evil" }, codeVersion: "evil" } as never, actor)).rejects.toMatchObject({ code: "validation_error" });
    expect(repository.createRunWithReceipt).not.toHaveBeenCalled();
  });

  it("returns dependency_unavailable when version registry is unavailable", async () => {
    const h = harness(); vi.mocked(h.versionProvider.load).mockRejectedValue(new Error("down"));
    await expect(h.service.createRun(createRun, actor)).rejects.toMatchObject({ code: "dependency_unavailable" });
  });

  it.each([
    [null, "not_found"],
    [{ ...run, status: "pending" as const }, "integrity_error"],
    [{ ...run, runType: "manual" as const }, "integrity_error"],
  ])("rejects absent/not-running/non-shadow run %#", async (runValue, code) => {
    const h = harness(); vi.mocked(h.repository.getRunById).mockResolvedValue(runValue as never);
    await expect(h.service.executeStrategy(execute("A"), actor)).rejects.toMatchObject({ code });
    expect(h.provider.load).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...snapshot, runId: id(999) }, "cross run"],
    [{ ...snapshot, matchDate: "20260718" }, "cross date"],
    [{ ...snapshot, datasetMode: "reconstructed" as const }, "cross mode"],
    [{ ...snapshot, checkpointAt: "2026-07-17T13:01:00.000Z" }, "late checkpoint"],
    [{ ...snapshot, sourceCutoffAt: "2026-07-17T13:01:00.000Z" }, "late cutoff"],
  ])("rejects authoritative snapshot mismatch: %s", async (snapshotValue) => {
    const h = harness(); vi.mocked(h.repository.getSnapshotSetById).mockResolvedValue(snapshotValue);
    await expect(h.service.executeStrategy(execute("A"), actor)).rejects.toMatchObject({ code: "integrity_error" });
    expect(h.repository.createPredictionWithReceipt).not.toHaveBeenCalled();
  });

  it("rejects provider hash/checkpoint mismatch and never trusts provider metadata", async () => {
    const h = harness(); vi.mocked(h.provider.load).mockResolvedValue({ ...evidence, evidenceContentHash: "wrong" });
    await expect(h.service.executeStrategy(execute("A"), actor)).rejects.toMatchObject({ code: "integrity_error" });
    expect(h.repository.createPredictionWithReceipt).not.toHaveBeenCalled();
  });

  it.each(["A", "B"] as const)("maps %s from provider evidence using run version", async strategy => {
    const h = harness(); await h.service.executeStrategy(execute(strategy), actor);
    expect(h.repository.createPredictionWithReceipt).toHaveBeenCalledWith(expect.objectContaining({ requestedStrategy: strategy, strategyVersion: `${strategy}-v1` }), expect.anything());
  });

  it("covers C fallback, complete unavailable, available executor, and executor failures", async () => {
    const fallback = harness(); await fallback.service.executeStrategy(execute("C"), actor);
    expect(fallback.repository.createPredictionWithReceipt).toHaveBeenCalledWith(expect.objectContaining({ requestedStrategy: "C", executedStrategy: "A", fallbackReason: "missing_critical_data" }), expect.anything());
    const unavailable = harness(); vi.mocked(unavailable.provider.load).mockResolvedValue({ ...evidence, cData: { marketConsensus: "yes", liquidityProfile: "normal", teamContext: "known" } });
    await unavailable.service.executeStrategy(execute("C"), actor);
    expect(unavailable.repository.createPredictionWithReceipt).toHaveBeenCalledWith(expect.objectContaining({ executedStrategy: "C", reasonCode: "C_EXECUTOR_UNAVAILABLE" }), expect.anything());
    const availableExecutor: StrategyCExecutor = input => ({
      decision: { status: "recommend", side: "away", reasonCode: "C_EXECUTED", branchId: "C-EXECUTED", lockedByDeterministicRule: false },
      meta: { checkpoint: input.checkpoint, requestedStrategy: "C", executedStrategy: "C", normalizedCurrent: { handicap:{raw:"半球",goals:0.5,quarterUnits:2},homeWater:{raw:"0.90",basisPoints:9000},awayWater:{raw:"0.98",basisPoints:9800} }, normalizedPreviousEffective: null, waterDiffBasisPoints: null, missingFields: [], invalidFields: [] },
    });
    const available = harness({ cExecutor: availableExecutor });
    vi.mocked(available.provider.load).mockResolvedValue({ ...evidence, cData: { marketConsensus: "yes", liquidityProfile: "normal", teamContext: "known" } });
    await available.service.executeStrategy(execute("C"), actor);
    expect(available.repository.createPredictionWithReceipt).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: "C_EXECUTED", selection: "away" }), expect.anything());
    const throws = harness({ cExecutor: () => { throw new Error("bad executor"); } }); vi.mocked(throws.provider.load).mockResolvedValue({ ...evidence, cData: { marketConsensus: "yes", liquidityProfile: "normal", teamContext: "known" } });
    await expect(throws.service.executeStrategy(execute("C"), actor)).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(throws.repository.createPredictionWithReceipt).not.toHaveBeenCalled();
    const invalid = harness({ cExecutor: (() => ({ decision: { status: "recommend", side: "home", reasonCode: "BAD", branchId: "BAD", lockedByDeterministicRule: false }, meta: { checkpoint: "T03", requestedStrategy: "A", executedStrategy: "A", normalizedCurrent: null, normalizedPreviousEffective: null, waterDiffBasisPoints: null, missingFields: [], invalidFields: [] } })) as StrategyCExecutor });
    vi.mocked(invalid.provider.load).mockResolvedValue({ ...evidence, cData: { marketConsensus: "yes", liquidityProfile: "normal", teamContext: "known" } });
    await expect(invalid.service.executeStrategy(execute("C"), actor)).rejects.toMatchObject({ code: "integrity_error" });
    expect(invalid.repository.createPredictionWithReceipt).not.toHaveBeenCalled();
  });

  it("returns stable 422 domain error for D and performs zero writes", async () => {
    const h = harness(); await expect(h.service.executeStrategy(execute("D"), actor)).rejects.toMatchObject({ code: "strategy_d_not_executable" });
    expect(h.repository.createPredictionWithReceipt).not.toHaveBeenCalled(); expect(h.provider.load).not.toHaveBeenCalled();
  });

  it("maps policy denial to 403 and dependency exceptions to 503", async () => {
    const denied = harness({ policy: false }); await expect(denied.service.executeStrategy(execute("A"), actor)).rejects.toMatchObject({ code: "policy_denied" });
    const down = harness({ policyThrows: true }); await expect(down.service.executeStrategy(execute("A"), actor)).rejects.toMatchObject({ code: "dependency_unavailable" });
  });

  it("validates snapshot run window and empty-item semantics", async () => {
    const h = harness();
    const currentItem = { oddsSnapshotId: 1, role: "current" as const, companyId: "3", marketType: "asian_handicap", snapshotType: "crown12", sourceObservedAt: "2026-07-17T12:14:59.000Z", collectedAt: "2026-07-17T12:15:00.000Z" };
    const base = { runId: run.id, matchId: "m1", matchDate: "20260717", checkpointType: "T1215" as const, checkpointAt: "2026-07-17T12:15:00.000Z", previousSnapshotSetId: null, revision: 1, supersedesSnapshotSetId: null, sourceCutoffAt: "2026-07-17T12:15:00.000Z", schemaVersion: 2, operationKey: "snapshot-status-0001" };
    for (const status of ["ready", "partial"] as const) {
      await h.service.captureSnapshotSet({ ...base, status, completeness: {}, items: [currentItem], operationKey: `snapshot-${status}-0001` }, actor);
      expect(h.repository.createSnapshotSetWithItemsAndReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ runId: run.id, datasetMode: "strict_asof", schemaVersion: 2, status }), [currentItem], expect.anything());
      await expect(h.service.captureSnapshotSet({ ...base, status, completeness: {}, items: [], operationKey: `snapshot-${status}-empty` }, actor)).rejects.toMatchObject({ code: "validation_error" });
    }
    for (const status of ["missing", "insufficient", "invalid"] as const) {
      await h.service.captureSnapshotSet({ ...base, status, completeness: { reasonCode: `SOURCE_${status.toUpperCase()}` }, items: [], operationKey: `snapshot-${status}-0001` }, actor);
      expect(h.repository.createSnapshotSetWithItemsAndReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ status }), [], expect.anything());
      await expect(h.service.captureSnapshotSet({ ...base, status, completeness: { reasonCode: "HAS_ITEM" }, items: [currentItem], operationKey: `snapshot-${status}-item` }, actor)).rejects.toMatchObject({ code: "validation_error" });
    }
    await expect(h.service.captureSnapshotSet({ ...base, status: "missing", completeness: {}, items: [], operationKey: "snapshot-missing-no-reason" }, actor)).rejects.toMatchObject({ code: "validation_error" });
  });

  it("settlement calculator cannot control revision, quote identity, actor or trace", async () => {
    const calculator: SettlementCalculator = { calculate: vi.fn(async () => ({ matchResultId: 1, outcome: "win" as const, profitMicros: 900000, profitDecimal:"0.900000", isCounted: true, settlementBasis: "actual_quote" as const, evidence: {}, calculatorVersion:"calculator-v2", quoteHandicapRaw:"半球",quoteHandicapQuarterUnits:2,quoteSelectedWater:"0.900000",quoteSelectedWaterMillionths:900000,legs:[{handicapQuarterUnits:2,stakeMicros:500000,result:"win" as const,profitMicros:450000},{handicapQuarterUnits:2,stakeMicros:500000,result:"win" as const,profitMicros:450000}],matchResultRevisionDraft:{sourceMatchResultId:1,matchId:"m1",matchDate:"20260717",status:"finished",homeScore:1,awayScore:0,scoreSource:"official",sourceObservedAt:"2026-07-17T14:00:00.000Z",sourceSettledAt:"2026-07-17T14:00:00.000Z",sourceUpdatedAt:"2026-07-17T14:00:00.000Z"} })) };
    const h = harness({ calculator });
    await h.service.createSettlement({ predictionId: id(20), quoteBasis: "actual", operationKey: "settlement-operation-0001" }, actor);
    expect(h.repository.createNextSettlementWithReceipt).toHaveBeenCalledWith(expect.objectContaining({
      actualQuoteSnapshotId: 2, settledBy: actor.actorId, traceId: actor.traceId,
    }), expect.objectContaining({ action: "settlement.create" }));
    const command = vi.mocked(h.repository.createNextSettlementWithReceipt).mock.calls[0][0];
    expect(command).not.toHaveProperty("revision"); expect(command).not.toHaveProperty("supersedes");
  });

  it("receipt replay skips versions, provider, policy, calculator and fact writes", async () => {
    const calculator: SettlementCalculator = { calculate: vi.fn() };
    const h = harness({ calculator });
    vi.mocked(h.repository.getCommandReceipt).mockResolvedValue(null);
    await h.service.executeStrategy(execute("A"), actor);
    expect(h.provider.load).toHaveBeenCalledOnce();
    // A real replay hash is learned from the first command context.
    const context = vi.mocked(h.repository.createPredictionWithReceipt).mock.calls[0][1];
    vi.clearAllMocks();
    vi.mocked(h.repository.getCommandReceipt).mockResolvedValue({ ...receipt("prediction.execute", "execute-A-0001", id(20)), payloadHash: context.payloadHash });
    vi.mocked(h.repository.getPredictionById).mockResolvedValue(h.prediction);
    const replayed = await h.service.executeStrategy(execute("A"), actor);
    expect(replayed.replayed).toBe(true); expect(h.provider.load).not.toHaveBeenCalled(); expect(h.captureValidator.validate).not.toHaveBeenCalled(); expect(h.policy.allows).not.toHaveBeenCalled(); expect(h.repository.createPredictionWithReceipt).not.toHaveBeenCalled();
  });

  it("maps capture validator integrity to 422 and performs zero snapshot writes", async () => {
    const h = harness();
    vi.mocked(h.captureValidator.validate).mockRejectedValue(new (await import("@/features/strategy-lab/application-service")).StrategyLabSnapshotIntegrityError());
    const item = { oddsSnapshotId: 1, role: "current" as const, companyId: "3", marketType: "asian_handicap", snapshotType: "crown12", sourceObservedAt: "2026-07-17T12:14:59.000Z", collectedAt: "2026-07-17T12:15:00.000Z" };
    await expect(h.service.captureSnapshotSet({ runId: run.id, matchId: "m1", matchDate: "20260717", checkpointType: "T1215", checkpointAt: "2026-07-17T12:15:00.000Z", status: "ready", previousSnapshotSetId: null, revision: 1, supersedesSnapshotSetId: null, sourceCutoffAt: "2026-07-17T12:15:00.000Z", schemaVersion: 2, completeness: {}, items: [item], operationKey: "validator-integrity" }, actor)).rejects.toMatchObject({ code: "integrity_error" });
    expect(h.repository.createSnapshotSetWithItemsAndReceipt).not.toHaveBeenCalled();
  });

  it("maps capture validator dependency failure to 503 and performs zero snapshot writes", async () => {
    const h = harness();
    vi.mocked(h.captureValidator.validate).mockRejectedValue(new Error("database unavailable"));
    const item = { oddsSnapshotId: 1, role: "current" as const, companyId: "3", marketType: "asian_handicap", snapshotType: "crown12", sourceObservedAt: "2026-07-17T12:14:59.000Z", collectedAt: "2026-07-17T12:15:00.000Z" };
    await expect(h.service.captureSnapshotSet({ runId: run.id, matchId: "m1", matchDate: "20260717", checkpointType: "T1215", checkpointAt: "2026-07-17T12:15:00.000Z", status: "ready", previousSnapshotSetId: null, revision: 1, supersedesSnapshotSetId: null, sourceCutoffAt: "2026-07-17T12:15:00.000Z", schemaVersion: 2, completeness: {}, items: [item], operationKey: "validator-dependency" }, actor)).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(h.repository.createSnapshotSetWithItemsAndReceipt).not.toHaveBeenCalled();
  });

  it("settlement receipt replay skips calculator and next-revision persistence", async () => {
    const calculator: SettlementCalculator = { calculate: vi.fn(async () => ({ matchResultId: 1, outcome: "win" as const, profitMicros:900000,profitDecimal:"0.900000",isCounted:true,settlementBasis:"actual_quote" as const,evidence:{},calculatorVersion:"calculator-v2",quoteHandicapRaw:"半球",quoteHandicapQuarterUnits:2,quoteSelectedWater:"0.900000",quoteSelectedWaterMillionths:900000,legs:[{handicapQuarterUnits:2,stakeMicros:500000,result:"win" as const,profitMicros:450000},{handicapQuarterUnits:2,stakeMicros:500000,result:"win" as const,profitMicros:450000}],matchResultRevisionDraft:{sourceMatchResultId:1,matchId:"m1",matchDate:"20260717",status:"finished",homeScore:1,awayScore:0,scoreSource:"official",sourceObservedAt:"2026-07-17T14:00:00.000Z",sourceSettledAt:"2026-07-17T14:00:00.000Z",sourceUpdatedAt:"2026-07-17T14:00:00.000Z"} })) };
    const h = harness({ calculator });
    const input = { predictionId: id(20), quoteBasis: "actual" as const, operationKey: "settlement-replay-0001" };
    await h.service.createSettlement(input, actor);
    const commandContext = vi.mocked(h.repository.createNextSettlementWithReceipt).mock.calls[0][1];
    const settlement = vi.mocked(h.repository.createNextSettlementWithReceipt).mock.results[0];
    const created = await settlement.value;
    vi.clearAllMocks();
    vi.mocked(h.repository.getCommandReceipt).mockResolvedValue({ ...receipt("settlement.create", input.operationKey, created.value.id), payloadHash: commandContext.payloadHash });
    vi.mocked(h.repository.getSettlementById).mockResolvedValue(created.value);
    const replay = await h.service.createSettlement(input, actor);
    expect(replay.replayed).toBe(true);
    expect(calculator.calculate).not.toHaveBeenCalled();
    expect(h.repository.createNextSettlementWithReceipt).not.toHaveBeenCalled();
  });
});
