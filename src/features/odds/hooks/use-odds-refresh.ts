"use client";

import { useCallback, useEffect, useMemo } from "react";

export interface PollingTimers {
  setInterval(handler: () => void, delay: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const browserPollingTimers: PollingTimers = {
  setInterval: (handler, delay) => setInterval(handler, delay),
  clearInterval: (handle) => clearInterval(handle),
};

export function startPolling(
  callback: () => void,
  intervalMs: number,
  timers: PollingTimers = browserPollingTimers,
): () => void {
  const handle = timers.setInterval(callback, intervalMs);
  return () => timers.clearInterval(handle);
}

export interface LatestRequestGate {
  begin(): number;
  accept(request: number): boolean;
  dispose(): void;
}

export function createLatestRequestGate(): LatestRequestGate {
  let latestRequest = 0;
  let active = true;
  return {
    begin() {
      latestRequest += 1;
      return latestRequest;
    },
    accept(request) {
      return active && request === latestRequest;
    },
    dispose() {
      active = false;
      latestRequest += 1;
    },
  };
}

export interface LatestAsyncRunner {
  run(): Promise<void>;
  dispose(): void;
}

type LatestAsyncRunnerOptions<T> = {
  load: () => Promise<T>;
  onData: (data: T) => void;
  onError?: (error: unknown) => void;
  onStart?: () => void;
  onSettled?: () => void;
};

export function createLatestAsyncRunner<T>({
  load,
  onData,
  onError,
  onStart,
  onSettled,
}: LatestAsyncRunnerOptions<T>): LatestAsyncRunner {
  const gate = createLatestRequestGate();
  return {
    async run() {
      const request = gate.begin();
      onStart?.();
      try {
        const data = await load();
        if (gate.accept(request)) onData(data);
      } catch (error) {
        if (gate.accept(request)) onError?.(error);
      } finally {
        if (gate.accept(request)) onSettled?.();
      }
    },
    dispose() {
      gate.dispose();
    },
  };
}

type UseOddsRefreshOptions<T> = {
  load: () => Promise<T>;
  onData: (data: T) => void;
  onError?: (error: unknown) => void;
  onStart?: () => void;
  onSettled?: () => void;
  intervalMs: number;
  enabled?: boolean;
  timers?: PollingTimers;
};

export function useOddsRefresh<T>({
  load,
  onData,
  onError,
  onStart,
  onSettled,
  intervalMs,
  enabled = true,
  timers = browserPollingTimers,
}: UseOddsRefreshOptions<T>) {
  const runner = useMemo(
    () => createLatestAsyncRunner({ load, onData, onError, onStart, onSettled }),
    [load, onData, onError, onStart, onSettled],
  );

  const refresh = useCallback(async () => {
    await runner.run();
  }, [runner]);

  useEffect(() => {
    if (!enabled) return () => runner.dispose();
    void runner.run();
    const stop = startPolling(() => void runner.run(), intervalMs, timers);
    return () => {
      stop();
      runner.dispose();
    };
  }, [enabled, intervalMs, runner, timers]);

  return { refresh };
}
