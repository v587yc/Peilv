import type { StrategyLabRepositoryErrorCode } from "./repository-errors";

export type StrategyLabServiceErrorCode = StrategyLabRepositoryErrorCode | "capability_unavailable" | "dependency_unavailable" | "policy_denied" | "strategy_d_not_executable";
const messages: Record<StrategyLabServiceErrorCode, string> = {
  validation_error: "Invalid strategy laboratory request", not_found: "Strategy laboratory record was not found",
  idempotency_conflict: "The operation key is already bound to different data",
  concurrency_conflict: "The record changed before the operation completed",
  integrity_error: "Strategy laboratory evidence is inconsistent", unexpected: "Strategy laboratory operation failed",
  capability_unavailable: "The requested strategy laboratory capability is unavailable",
  dependency_unavailable: "A required strategy laboratory dependency is unavailable",
  policy_denied: "The match is not permitted by strategy laboratory policy",
  strategy_d_not_executable: "Strategy D is registered for compatibility but is not executable",
};
export class StrategyLabServiceError extends Error {
  constructor(public readonly code: StrategyLabServiceErrorCode) { super(messages[code]); this.name = "StrategyLabServiceError"; delete this.stack; }
}
