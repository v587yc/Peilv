export interface OddsFetchSourceResult {
  data: Record<string, unknown> & { matchId: string };
  source: string;
  sourceObservedAt: string;
}

export interface OddsFetchContext {
  matchDate: string;
  companyIds: string[];
}

export interface OddsPersistenceRequest {
  matchId: string;
  matchDate: string;
  companyIds: string;
  oddsData: OddsFetchSourceResult["data"];
  source: string;
  sourceObservedAt: string;
  writeToken: string;
}

export interface OddsPersistenceResult {
  applied: boolean;
  sourceObservedAt?: string;
}

export interface OddsBatchProgress {
  done: number;
  total: number;
  phase: string;
}

interface OddsFetchCoordinatorDependencies {
  fetchMatch(matchId: string, signal?: AbortSignal): Promise<OddsFetchSourceResult>;
  persistMatch(request: OddsPersistenceRequest, signal?: AbortSignal): Promise<OddsPersistenceResult>;
  onRequestStart?(matchId: string, requestVersion: number, generation: number): void;
  onApplyMatch(result: OddsFetchSourceResult, requestVersion: number): void | Promise<void>;
  onPersistedMatch?(
    matchId: string,
    requestVersion: number,
    result: OddsPersistenceResult,
    request: OddsPersistenceRequest,
  ): void;
  onFailure?(matchId: string, message: string): void;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

export interface RunOddsBulkOptions {
  matchIds: string[];
  generation: number;
  signal?: AbortSignal;
  phase?: string;
  delayMs?: number;
  contextFor(matchId: string): OddsFetchContext;
  onProgress(value: OddsBatchProgress): void;
}

export interface RunOddsBatchOptions {
  matchIds: string[];
  signal?: AbortSignal;
  phase: string;
  delayMs: number;
  fetchOne(matchId: string, signal?: AbortSignal): Promise<unknown>;
  onProgress(value: OddsBatchProgress): void;
  delay?: (milliseconds: number) => Promise<void>;
}

export async function runOddsFetchBatch({
  matchIds,
  signal,
  phase,
  delayMs,
  fetchOne,
  onProgress,
  delay = (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
}: RunOddsBatchOptions): Promise<void> {
  onProgress({ done: 0, total: matchIds.length, phase });
  let completed = 0;
  for (const matchId of matchIds) {
    if (signal?.aborted) break;
    await Promise.allSettled([fetchOne(matchId, signal)]);
    completed += 1;
    onProgress({ done: completed, total: matchIds.length, phase });
    if (!signal?.aborted && completed < matchIds.length) await delay(delayMs);
  }
}

export function createSerializedExecutor() {
  let tail: Promise<void> = Promise.resolve();
  return function runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

export interface OddsRefreshQueueStatus {
  queued: number;
  inFlight: number;
  lastSuccessAt: number;
}

export interface OddsRefreshQueueOptions {
  run(matchId: string, generation: number): Promise<boolean>;
  maxQueued?: number;
  delayMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  onStatus?: (status: OddsRefreshQueueStatus) => void;
}

interface QueuedRefresh {
  matchId: string;
  priority: number;
  generation: number;
  order: number;
  resolvers: Array<(success: boolean) => void>;
}

export function createOddsRefreshQueue(options: OddsRefreshQueueOptions) {
  const maxQueued = options.maxQueued ?? 200;
  const delayMs = options.delayMs ?? 100;
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  let queue: QueuedRefresh[] = [];
  let workerRunning = false;
  let sequence = 0;
  let lastSuccessAt = 0;
  const flights = new Map<string, Promise<boolean>>();

  const publish = (inFlight = workerRunning ? 1 : 0) => options.onStatus?.({
    queued: queue.length,
    inFlight,
    lastSuccessAt,
  });

  const runWorker = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      while (queue.length > 0) {
        const queued = queue.shift()!;
        publish(1);
        let flight = flights.get(queued.matchId);
        if (!flight) {
          flight = options.run(queued.matchId, queued.generation).finally(() => flights.delete(queued.matchId));
          flights.set(queued.matchId, flight);
        }
        const success = await flight;
        queued.resolvers.forEach(resolve => resolve(success));
        if (success) lastSuccessAt = now();
        publish(0);
        if (queue.length > 0) await delay(delayMs);
      }
    } finally {
      workerRunning = false;
      publish(0);
    }
  };

  return {
    enqueue(matchId: string, priority = 0, generation = 0): Promise<boolean> {
      const flight = flights.get(matchId);
      if (flight) return flight;
      return new Promise<boolean>(resolve => {
        const existing = queue.find(item => item.matchId === matchId);
        if (existing) {
          existing.priority = Math.max(existing.priority, priority);
          existing.resolvers.push(resolve);
        } else {
          queue.push({ matchId, priority, generation, order: sequence++, resolvers: [resolve] });
        }
        queue.sort((left, right) => right.priority - left.priority || left.order - right.order);
        const dropped = queue.splice(maxQueued);
        dropped.forEach(item => item.resolvers.forEach(droppedResolve => droppedResolve(false)));
        publish();
        void runWorker();
      });
    },
    clear() {
      const removed = queue;
      queue = [];
      removed.forEach(item => item.resolvers.forEach(resolve => resolve(false)));
      publish();
    },
    getStatus(): OddsRefreshQueueStatus {
      return { queued: queue.length, inFlight: workerRunning ? 1 : 0, lastSuccessAt };
    },
  };
}

export function normalizeOddsFetchError(error: unknown): string {
  return error instanceof Error ? error.message : "抓取失败";
}

export function createOddsFetchCoordinator(dependencies: OddsFetchCoordinatorDependencies) {
  const latestRequest = new Map<string, number>();
  const persistedVersion = new Map<string, number>();
  let requestSequence = 0;
  let currentGeneration = 0;
  const now = dependencies.now ?? Date.now;
  const delay = dependencies.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const isCurrent = (matchId: string, requestVersion: number, generation: number) =>
    generation === currentGeneration && latestRequest.get(matchId) === requestVersion;

  async function fetchMatch(
    matchId: string,
    generation: number,
    context: OddsFetchContext,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (generation < currentGeneration) return false;
    currentGeneration = Math.max(currentGeneration, generation);
    const requestVersion = ++requestSequence;
    latestRequest.set(matchId, requestVersion);
    dependencies.onRequestStart?.(matchId, requestVersion, generation);
    if (signal?.aborted) return false;

    try {
      const result = await dependencies.fetchMatch(matchId, signal);
      if (signal?.aborted || !isCurrent(matchId, requestVersion, generation)) return false;

      await dependencies.onApplyMatch(result, requestVersion);
      if (signal?.aborted || !isCurrent(matchId, requestVersion, generation)) return false;
      const persistenceRequest: OddsPersistenceRequest = {
        matchId,
        matchDate: context.matchDate,
        companyIds: context.companyIds.join(","),
        oddsData: result.data,
        source: result.source,
        sourceObservedAt: result.sourceObservedAt,
        writeToken: `${generation}:${requestVersion}:${matchId}:${now()}`,
      };
      const persistence = await dependencies.persistMatch(persistenceRequest, signal);

      if (signal?.aborted || !isCurrent(matchId, requestVersion, generation)) return false;
      if (persistence.applied) {
        persistedVersion.set(matchId, requestVersion);
        dependencies.onPersistedMatch?.(matchId, requestVersion, persistence, persistenceRequest);
      }
      return true;
    } catch (error) {
      if (!signal?.aborted && isCurrent(matchId, requestVersion, generation)) {
        dependencies.onFailure?.(matchId, normalizeOddsFetchError(error));
      }
      return false;
    }
  }

  async function runBulk({
    matchIds,
    generation,
    signal,
    phase = "刷新最新赔率",
    delayMs = 100,
    contextFor,
    onProgress,
  }: RunOddsBulkOptions): Promise<void> {
    onProgress({ done: 0, total: matchIds.length, phase });
    let completed = 0;
    for (const matchId of matchIds) {
      if (signal?.aborted) break;
      await fetchMatch(matchId, generation, contextFor(matchId), signal);
      completed += 1;
      onProgress({ done: completed, total: matchIds.length, phase });
      if (!signal?.aborted && completed < matchIds.length) await delay(delayMs);
    }
  }

  return {
    fetchMatch,
    runBulk,
    setGeneration(generation: number) {
      currentGeneration = generation;
    },
    getPersistedVersion(matchId: string) {
      return persistedVersion.get(matchId);
    },
  };
}
