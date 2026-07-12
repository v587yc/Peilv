export const DEFAULT_MAX_DATE_RANGE_DAYS = 31;
export const DEFAULT_MAX_MATCHES = 500;
export const DEFAULT_MAX_CONCURRENT_JOBS = 2;
export const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;

export interface BacktestLimits {
  maxDateRangeDays: number;
  maxMatches: number;
  maxConcurrentJobs: number;
  timeoutMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getBacktestLimits(env: NodeJS.ProcessEnv = process.env): BacktestLimits {
  return {
    maxDateRangeDays: positiveInt(env.BACKTEST_MAX_DATE_RANGE_DAYS, DEFAULT_MAX_DATE_RANGE_DAYS),
    maxMatches: positiveInt(env.BACKTEST_MAX_MATCHES, DEFAULT_MAX_MATCHES),
    maxConcurrentJobs: positiveInt(env.BACKTEST_MAX_CONCURRENT_JOBS, DEFAULT_MAX_CONCURRENT_JOBS),
    timeoutMs: positiveInt(env.BACKTEST_JOB_TIMEOUT_MS, DEFAULT_JOB_TIMEOUT_MS),
  };
}

export function parseDateKey(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
}

export function validateBacktestInput(
  input: { startDate?: unknown; endDate?: unknown; maxMatches?: unknown },
  limits = getBacktestLimits(),
): { startDate: string; endDate: string; maxMatches: number; dates: string[] } {
  const start = parseDateKey(input.startDate);
  const end = parseDateKey(input.endDate);
  if (!start || !end) throw new Error("startDate and endDate must be valid YYYYMMDD dates");
  if (start > end) throw new Error("startDate must not be after endDate");

  const dayCount = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (dayCount > limits.maxDateRangeDays) {
    throw new Error(`date range exceeds ${limits.maxDateRangeDays} days`);
  }

  const requestedMax = input.maxMatches === undefined ? limits.maxMatches : Number(input.maxMatches);
  if (!Number.isSafeInteger(requestedMax) || requestedMax <= 0 || requestedMax > limits.maxMatches) {
    throw new Error(`maxMatches must be an integer between 1 and ${limits.maxMatches}`);
  }

  const dates: string[] = [];
  for (let timestamp = start.getTime(); timestamp <= end.getTime(); timestamp += 86_400_000) {
    const date = new Date(timestamp);
    dates.push(`${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`);
  }
  return { startDate: input.startDate as string, endDate: input.endDate as string, maxMatches: requestedMax, dates };
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("回测任务已取消");
  }
}
