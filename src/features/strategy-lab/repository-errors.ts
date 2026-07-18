export type StrategyLabRepositoryErrorCode =
  | "not_found"
  | "idempotency_conflict"
  | "concurrency_conflict"
  | "validation_error"
  | "integrity_error"
  | "unexpected";

const SAFE_MESSAGES: Record<StrategyLabRepositoryErrorCode, string> = {
  not_found: "Strategy laboratory record was not found",
  idempotency_conflict: "The idempotency key is already bound to different data",
  concurrency_conflict: "The record changed before the operation completed",
  validation_error: "The strategy laboratory input is invalid",
  integrity_error: "The strategy laboratory data violates an integrity constraint",
  unexpected: "The strategy laboratory persistence operation failed",
};

export class StrategyLabRepositoryError extends Error {
  constructor(public readonly code: StrategyLabRepositoryErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "StrategyLabRepositoryError";
    // Repository errors are safe transport objects; raw database stacks and causes never escape.
    delete this.stack;
  }
}

export function isStrategyLabRepositoryError(error: unknown): error is StrategyLabRepositoryError {
  return error instanceof StrategyLabRepositoryError;
}
