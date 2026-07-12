export const ODDS_STALE_AFTER_MS = 60_000;

export type SourceTimestamp = string | number | Date | null | undefined;

function timestampValue(timestamp: SourceTimestamp): number | null {
  if (timestamp == null) return null;

  const value = timestamp instanceof Date
    ? timestamp.getTime()
    : typeof timestamp === "number"
      ? timestamp
      : Date.parse(timestamp);

  return Number.isFinite(value) ? value : null;
}

/** Compares source times, treating a missing legacy timestamp as older than a known time. */
export function compareSourceTimestamps(
  left: SourceTimestamp,
  right: SourceTimestamp,
): -1 | 0 | 1 {
  const leftValue = timestampValue(left);
  const rightValue = timestampValue(right);

  if (leftValue === rightValue) return 0;
  if (leftValue === null) return -1;
  if (rightValue === null) return 1;
  return leftValue < rightValue ? -1 : 1;
}

export interface RefreshAcceptance {
  request: number;
  latestRequest: number;
  generation: number;
  latestGeneration: number;
}

/** Accepts only a response belonging to the latest request in the current generation. */
export function isLatestRefreshResponse({
  request,
  latestRequest,
  generation,
  latestGeneration,
}: RefreshAcceptance): boolean {
  return request === latestRequest && generation === latestGeneration;
}

/** Prevents a database read from replacing a newer in-memory source observation. */
export function canApplyDatabaseObservation(
  observedAt: SourceTimestamp,
  currentObservedAt: SourceTimestamp,
): boolean {
  if (currentObservedAt == null) return true;
  return compareSourceTimestamps(observedAt, currentObservedAt) >= 0;
}

/** A value becomes stale at the 60-second boundary. */
export function isOddsStale(
  observedAt: SourceTimestamp,
  now: SourceTimestamp = Date.now(),
): boolean {
  const observedValue = timestampValue(observedAt);
  const nowValue = timestampValue(now);

  if (observedValue === null || nowValue === null) return true;
  return nowValue - observedValue >= ODDS_STALE_AFTER_MS;
}

export interface RefreshQueueItem<T = unknown> {
  key: string;
  priority: number;
  value: T;
}

/**
 * Adds or replaces one keyed job, promotes duplicate priority, and returns a
 * deterministic highest-priority-first queue. Equal priorities keep their
 * existing queue order.
 */
export function enqueueRefreshItem<T>(
  queue: ReadonlyArray<RefreshQueueItem<T>>,
  item: RefreshQueueItem<T>,
): RefreshQueueItem<T>[] {
  const existingIndex = queue.findIndex(queued => queued.key === item.key);
  const next = queue.map(queued => ({ ...queued }));

  if (existingIndex === -1) {
    next.push({ ...item });
  } else {
    next[existingIndex] = {
      ...item,
      priority: Math.max(next[existingIndex].priority, item.priority),
    };
  }

  return next
    .map((queued, index) => ({ queued, index }))
    .sort((left, right) => right.queued.priority - left.queued.priority || left.index - right.index)
    .map(({ queued }) => queued);
}
