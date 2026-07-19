import type {
  CreateStrategyLabPrediction,
  CreateStrategyLabRun,
  CreateStrategyLabSettlement,
  CreateStrategyLabSnapshotItem,
  CreateStrategyLabSnapshotSet,
  StrategyLabCommandAction,
  StrategyLabCommandReceipt,
} from "./persistence-schemas";

export type CreateStatus = "created" | "existing";
export interface CreateResult<T> { readonly status: CreateStatus; readonly value: Readonly<T> }

export interface StrategyLabSnapshotSetRecord extends CreateStrategyLabSnapshotSet { readonly createdAt: string }
export interface StrategyLabRunRecord extends Omit<CreateStrategyLabRun, "status" | "createdAt" | "updatedAt"> {
  readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  readonly errorSummary: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface StrategyLabPredictionRecord extends CreateStrategyLabPrediction { readonly createdAt: string }
export type StrategyLabSettlementRecord = CreateStrategyLabSettlement & { readonly createdAt: string };

export type SnapshotSetCreateCommand = Omit<CreateStrategyLabSnapshotSet, "id"> & { readonly id?: string };
export type SnapshotItemCreateCommand = Omit<CreateStrategyLabSnapshotItem, "snapshotSetId">;
export type RunCreateCommand = Omit<CreateStrategyLabRun, "id" | "createdAt" | "updatedAt"> & { readonly id?: string };
export type PredictionCreateCommand = Omit<CreateStrategyLabPrediction, "id"> & { readonly id?: string };
export type SettlementCreateCommand = Omit<CreateStrategyLabSettlement, "id"> & { readonly id?: string };
export interface MatchResultRevisionDraft {
  readonly sourceMatchResultId:number; readonly matchId:string; readonly matchDate:string;
  readonly status:"finished"|"pending"|"special"; readonly homeScore:number|null; readonly awayScore:number|null;
  readonly scoreSource:string; readonly sourceObservedAt:string; readonly sourceSettledAt:string|null;
  readonly sourceUpdatedAt:string; readonly contentHash:string;
}
export interface SettlementLegEvidence {
  readonly handicapQuarterUnits: number;
  readonly stakeMicros: number;
  readonly result: "win" | "push" | "loss";
  readonly profitMicros: number;
}
export type NextSettlementCreateCommand = Omit<CreateStrategyLabSettlement, "id" | "revision" | "supersedes" | "matchResultRevisionId"> & {
  readonly profitMicros: number | null;
  readonly profitDecimal: string | null;
  readonly legs: readonly Readonly<SettlementLegEvidence>[];
  readonly matchResultRevisionDraft: Readonly<MatchResultRevisionDraft>;
};
export interface StrategyLabCommandContext {
  readonly action: StrategyLabCommandAction;
  readonly operationKey: string;
  readonly payloadHash: string;
  readonly actorId: string;
  readonly requestId: string;
}
export interface CommandResult<T> extends CreateResult<T> {
  readonly replayed: boolean;
  readonly receipt: Readonly<StrategyLabCommandReceipt>;
}

export type RunTransitionCommand = {
  readonly id: string;
  readonly transition: "pending_to_running" | "pending_to_cancelled" | "running_to_succeeded" | "running_to_failed" | "running_to_cancelled";
  readonly expectedCurrentStatus: "pending" | "running";
  /** Canonical UTC millisecond CAS token returned by the repository. */
  readonly previousUpdatedAt: string;
  readonly errorSummary?: string | null;
};

/** Facts are create-only. Only run lifecycle transitions are mutable and use compare-and-set. */
export interface StrategyLabRepository {
  createSnapshotSetWithItems(command: Readonly<SnapshotSetCreateCommand>, items: readonly Readonly<SnapshotItemCreateCommand>[]): Promise<CreateResult<StrategyLabSnapshotSetRecord>>;
  createRun(command: Readonly<RunCreateCommand>): Promise<CreateResult<StrategyLabRunRecord>>;
  transitionRun(command: Readonly<RunTransitionCommand>): Promise<Readonly<StrategyLabRunRecord>>;
  createPrediction(command: Readonly<PredictionCreateCommand>): Promise<CreateResult<StrategyLabPredictionRecord>>;
  createSettlement(command: Readonly<SettlementCreateCommand>): Promise<CreateResult<StrategyLabSettlementRecord>>;
  createRunWithReceipt(command: Readonly<RunCreateCommand>, context: Readonly<StrategyLabCommandContext>): Promise<CommandResult<StrategyLabRunRecord>>;
  transitionRunWithReceipt(command: Readonly<RunTransitionCommand>, context: Readonly<StrategyLabCommandContext>): Promise<CommandResult<StrategyLabRunRecord>>;
  createSnapshotSetWithItemsAndReceipt(command: Readonly<SnapshotSetCreateCommand>, items: readonly Readonly<SnapshotItemCreateCommand>[], context: Readonly<StrategyLabCommandContext>): Promise<CommandResult<StrategyLabSnapshotSetRecord>>;
  createPredictionWithReceipt(command: Readonly<PredictionCreateCommand>, context: Readonly<StrategyLabCommandContext>): Promise<CommandResult<StrategyLabPredictionRecord>>;
  createNextSettlementWithReceipt(command: Readonly<NextSettlementCreateCommand>, context: Readonly<StrategyLabCommandContext>): Promise<CommandResult<StrategyLabSettlementRecord>>;
  getCommandReceipt(action: StrategyLabCommandAction, operationKey: string): Promise<Readonly<StrategyLabCommandReceipt> | null>;
  markCommandReceiptAudit(action: StrategyLabCommandAction, operationKey: string, succeeded: boolean, safeErrorCode?: string): Promise<Readonly<StrategyLabCommandReceipt>>;
  listPendingCommandReceipts(limit: number): Promise<readonly Readonly<StrategyLabCommandReceipt>[]>;
  getSnapshotSetById(id: string): Promise<Readonly<StrategyLabSnapshotSetRecord> | null>;
  getRunById(id: string): Promise<Readonly<StrategyLabRunRecord> | null>;
  getPredictionById(id: string): Promise<Readonly<StrategyLabPredictionRecord> | null>;
  getSettlementById(id: string): Promise<Readonly<StrategyLabSettlementRecord> | null>;
}
