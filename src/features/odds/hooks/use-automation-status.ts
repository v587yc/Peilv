"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAutomationStatus,
  requestAutomationCompensation,
  type FetchLike,
} from "../api-client";
import type { AutomationTaskStatusData } from "../contracts";
import { isAutomationCompensationAvailable } from "../automation-view-model";
import { useOddsRefresh, type PollingTimers } from "./use-odds-refresh";

export async function runBusyOperation<T>(
  setBusy: (busy: boolean) => void,
  operation: () => Promise<T>,
): Promise<T> {
  setBusy(true);
  try {
    return await operation();
  } finally {
    setBusy(false);
  }
}

type UseAutomationStatusOptions = {
  dateKey: string;
  fetcher?: FetchLike;
  intervalMs?: number;
  timers?: PollingTimers;
  now?: () => Date;
  onCompleted?: () => void | Promise<void>;
  onCompensated?: () => void | Promise<void>;
};

export function useAutomationStatus({
  dateKey,
  fetcher = fetch,
  intervalMs = 30_000,
  timers,
  now = () => new Date(),
  onCompleted,
  onCompensated,
}: UseAutomationStatusOptions) {
  const [tasks, setTasks] = useState<AutomationTaskStatusData[]>([]);
  const [compensating, setCompensating] = useState(false);
  const [message, setMessage] = useState("");
  const [compensationAvailable, setCompensationAvailable] = useState(() =>
    isAutomationCompensationAvailable(now()),
  );
  const previousStatuses = useRef(new Map<string, AutomationTaskStatusData["status"]>());

  const load = useCallback(
    () => fetchAutomationStatus(fetcher, dateKey),
    [dateKey, fetcher],
  );
  const applyTasks = useCallback((next: AutomationTaskStatusData[]) => {
    setTasks((previous) => {
      const unchanged = previous.length === next.length && previous.every((task, index) => (
        task.id === next[index]?.id
        && task.status === next[index]?.status
        && task.currentStep === next[index]?.currentStep
        && task.lastError === next[index]?.lastError
        && task.updatedAt === next[index]?.updatedAt
      ));
      return unchanged ? previous : next;
    });
  }, []);

  const { refresh } = useOddsRefresh({
    load,
    onData: applyTasks,
    intervalMs,
    enabled: Boolean(dateKey),
    timers,
  });

  useEffect(() => {
    const update = () => setCompensationAvailable(isAutomationCompensationAvailable(now()));
    update();
    const timer = setInterval(update, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, now]);

  useEffect(() => {
    const completedNow = tasks.some(
      (task) => task.status === "completed" && previousStatuses.current.get(task.id) !== "completed",
    );
    previousStatuses.current = new Map(tasks.map((task) => [task.id, task.status]));
    if (completedNow) void onCompleted?.();
  }, [onCompleted, tasks]);

  const compensate = useCallback(async () => {
    if (compensating) return;
    if (!compensationAvailable) {
      setMessage("北京时间12:02后才可执行当日补偿；未到时间前属于待执行，不是失败");
      return;
    }
    setMessage("");
    try {
      await runBusyOperation(setCompensating, async () => {
        const result = await requestAutomationCompensation(fetcher, { maxTasks: 1 });
        setMessage(`已提交 ${result.ensured.length} 个幂等补偿任务`);
        await refresh();
        await onCompensated?.();
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "补偿失败");
    }
  }, [compensating, compensationAvailable, fetcher, onCompensated, refresh]);

  return {
    tasks,
    compensating,
    message,
    compensationAvailable,
    refresh,
    compensate,
  };
}
