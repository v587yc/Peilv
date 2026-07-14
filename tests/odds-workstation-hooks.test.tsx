// @vitest-environment happy-dom

import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLatestAsyncRunner,
  type PollingTimers,
  startPolling,
  useOddsRefresh,
} from "@/features/odds/hooks/use-odds-refresh";
import { useWorkstationSettings } from "@/features/odds/hooks/use-workstation-settings";
import { runBusyOperation } from "@/features/odds/hooks/use-automation-status";
import { createOddsWorkstationActions } from "@/features/odds/hooks/use-odds-workstation";
import {
  LS_ALERT_CONFIGS_KEY,
  LS_NOTES_KEY,
  LS_PINNED_IDS_KEY,
  LS_PINNED_INFO_KEY,
  LS_REFRESH_INTERVAL_KEY,
  LS_SOUND_ENABLED_KEY,
} from "@/features/odds/constants";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createPollingTimers() {
  let nextHandle = 1;
  const scheduled = new Map<number, () => void>();
  const setInterval = vi.fn((handler: () => void) => {
    const handle = nextHandle++;
    scheduled.set(handle, handler);
    return handle as unknown as ReturnType<typeof globalThis.setInterval>;
  });
  const clearInterval = vi.fn((handle: ReturnType<typeof globalThis.setInterval>) => {
    scheduled.delete(handle as unknown as number);
  });
  return {
    timers: { setInterval, clearInterval } satisfies PollingTimers,
    scheduled,
    setInterval,
    clearInterval,
  };
}

type RefreshHarnessProps = {
  load: () => Promise<string>;
  onData: (value: string) => void;
  intervalMs: number;
  timers: PollingTimers;
};

function RefreshHarness(props: RefreshHarnessProps) {
  useOddsRefresh(props);
  return null;
}

let roots: Root[] = [];

function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return root;
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.replaceChildren();
});

describe("odds workstation hook lifecycles", () => {
  it("only applies the newest deferred response when an older request resolves last", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const load = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const applyState = vi.fn();
    const runner = createLatestAsyncRunner({ load, onData: applyState });

    const firstRun = runner.run();
    const secondRun = runner.run();
    second.resolve("newer snapshot");
    await secondRun;
    first.resolve("older snapshot");
    await firstRun;

    expect(applyState).toHaveBeenCalledTimes(1);
    expect(applyState).toHaveBeenCalledWith("newer snapshot");
  });

  it("cleans up polling when its mounted owner unmounts", () => {
    const polling = createPollingTimers();
    const root = mount(<RefreshHarness
      load={() => Promise.resolve("snapshot")}
      onData={vi.fn()}
      intervalMs={30_000}
      timers={polling.timers}
    />);

    expect(polling.setInterval).toHaveBeenCalledTimes(1);
    const handle = polling.setInterval.mock.results[0].value;

    act(() => root.unmount());
    roots = roots.filter((candidate) => candidate !== root);

    expect(polling.clearInterval).toHaveBeenCalledWith(handle);
    expect(polling.scheduled).toHaveLength(0);
  });

  it("disposes replaced dependencies and rejects their late responses after rerender and unmount", async () => {
    const polling = createPollingTimers();
    const oldRequest = deferred<string>();
    const newRequest = deferred<string>();
    const oldOnData = vi.fn();
    const newOnData = vi.fn();
    const root = mount(<RefreshHarness
      load={() => oldRequest.promise}
      onData={oldOnData}
      intervalMs={30_000}
      timers={polling.timers}
    />);
    const oldHandle = polling.setInterval.mock.results[0].value;

    act(() => root.render(<RefreshHarness
      load={() => newRequest.promise}
      onData={newOnData}
      intervalMs={30_000}
      timers={polling.timers}
    />));

    expect(polling.clearInterval).toHaveBeenCalledWith(oldHandle);
    expect(polling.setInterval).toHaveBeenCalledTimes(2);

    await act(async () => oldRequest.resolve("stale"));
    expect(oldOnData).not.toHaveBeenCalled();
    expect(newOnData).not.toHaveBeenCalled();

    act(() => root.unmount());
    roots = roots.filter((candidate) => candidate !== root);
    await act(async () => newRequest.resolve("after unmount"));
    expect(newOnData).not.toHaveBeenCalled();
  });

  it("replaces the polling interval when intervalMs changes", () => {
    const polling = createPollingTimers();
    const load = vi.fn(() => Promise.resolve("snapshot"));
    const onData = vi.fn();
    const root = mount(<RefreshHarness load={load} onData={onData} intervalMs={10_000} timers={polling.timers} />);
    const firstHandle = polling.setInterval.mock.results[0].value;

    act(() => root.render(<RefreshHarness load={load} onData={onData} intervalMs={60_000} timers={polling.timers} />));

    expect(polling.clearInterval).toHaveBeenCalledWith(firstHandle);
    expect(polling.setInterval).toHaveBeenNthCalledWith(2, expect.any(Function), 60_000);
    expect(polling.scheduled.size).toBe(1);
  });

  it("hydrates injected storage before writing and persists only subsequent changes", () => {
    const values = new Map<string, string>([
      [LS_PINNED_IDS_KEY, JSON.stringify(["stored-match"])],
      [LS_PINNED_INFO_KEY, JSON.stringify([["stored-match", { home: "A" }]])],
      [LS_NOTES_KEY, JSON.stringify([["stored-match", "stored note"]])],
      [LS_ALERT_CONFIGS_KEY, JSON.stringify([["stored-match", { threshold: 3 }]])],
      [LS_SOUND_ENABLED_KEY, JSON.stringify(false)],
      [LS_REFRESH_INTERVAL_KEY, JSON.stringify(30)],
    ]);
    const operations: string[] = [];
    const storage = {
      get length() { return values.size; },
      clear: vi.fn(),
      key: vi.fn(),
      getItem: vi.fn((key: string) => {
        operations.push(`get:${key}`);
        return values.get(key) ?? null;
      }),
      setItem: vi.fn((key: string, value: string) => {
        operations.push(`set:${key}`);
        values.set(key, value);
      }),
      removeItem: vi.fn(),
    } satisfies Storage;

    type Controls = { pin(matchId: string): void };
    let controls: Controls | undefined;
    function SettingsHarness() {
      const [pinnedMatches, setPinnedMatches] = useState(new Set(["render-default"]));
      const [pinnedMatchInfo, setPinnedMatchInfo] = useState(new Map<string, { home: string }>());
      const [notes, setNotes] = useState(new Map<string, string>());
      const [alertConfigs, setAlertConfigs] = useState(new Map<string, { threshold: number }>());
      const [soundEnabled, setSoundEnabled] = useState(true);
      const [refreshInterval, setRefreshInterval] = useState(10);
      useWorkstationSettings({
        storage,
        pinnedMatches,
        pinnedMatchInfo,
        notes,
        setPinnedMatches,
        setPinnedMatchInfo,
        setNotes,
        alertConfigs,
        setAlertConfigs,
        soundEnabled,
        setSoundEnabled,
        refreshInterval,
        setRefreshInterval,
      });
      useEffect(() => {
        controls = { pin: (matchId) => setPinnedMatches((current) => new Set([...current, matchId])) };
      }, []);
      return null;
    }

    mount(<SettingsHarness />);

    const firstSet = operations.findIndex((operation) => operation.startsWith("set:"));
    const lastGet = operations.reduce((index, operation, current) => operation.startsWith("get:") ? current : index, -1);
    expect(firstSet).toBeGreaterThan(lastGet);
    expect(JSON.parse(values.get(LS_PINNED_IDS_KEY)!)).toEqual(["stored-match"]);
    expect(values.get(LS_SOUND_ENABLED_KEY)).toBe(JSON.stringify(false));
    expect(values.get(LS_REFRESH_INTERVAL_KEY)).toBe(JSON.stringify(30));

    act(() => controls!.pin("new-match"));
    expect(JSON.parse(values.get(LS_PINNED_IDS_KEY)!)).toEqual(["stored-match", "new-match"]);
  });

  it("cleans up a standalone polling owner", () => {
    const callback = vi.fn();
    let scheduled: (() => void) | undefined;
    const clear = vi.fn();
    const stop = startPolling(callback, 30_000, {
      setInterval(handler) {
        scheduled = handler;
        return 42 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: clear,
    });

    scheduled?.();
    expect(callback).toHaveBeenCalledTimes(1);

    stop();
    expect(clear).toHaveBeenCalledWith(42);
  });

  it("restores non-busy state after a compensation command fails", async () => {
    const busyStates: boolean[] = [];

    await expect(runBusyOperation(
      (busy) => busyStates.push(busy),
      async () => {
        throw new Error("补偿失败");
      },
    )).rejects.toThrow("补偿失败");

    expect(busyStates).toEqual([true, false]);
  });

  it("composes bound workstation actions instead of exposing hook functions", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: "[]" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const actions = createOddsWorkstationActions(fetcher);

    await expect(actions.fetchPredictions("20260714")).resolves.toBe("[]");
    expect(fetcher).toHaveBeenCalledWith("/api/prediction?date=20260714");
    expect(actions).not.toHaveProperty("useOddsRefresh");
  });
});
