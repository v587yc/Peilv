import { randomUUID } from "node:crypto";
import { sendFeishuText } from "@/lib/integrations/feishu/notifier";
import {
  AUTOMATION_DEFINITIONS,
  beijingParts,
  isDue,
  isFixedScheduleDefinition,
  scheduledAt,
  shiftDateKey,
} from "./definitions";
import { upsertMatchT30Task } from "./match-t30-task";
import type {
  AutomationHandlers,
  AutomationRepository,
  AutomationTaskType,
  CreateTaskInput,
  TaskWithSteps,
} from "./types";

const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 60 * 1000;

interface ScheduleMatch {
  id: string;
  league: string;
  time: string;
  state: string;
  homeTeam: string;
  awayTeam: string;
  matchDate: string;
}

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({})) as T & { success?: boolean; error?: string };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

export interface AutomationEngineOptions {
  repository: AutomationRepository;
  handlers: AutomationHandlers;
  baseUrl: string;
  leaseMs?: number;
  retryDelayMs?: number;
  failureAlert?: (task: TaskWithSteps, error: string) => Promise<unknown>;
  now?: () => Date;
}

export class AutomationEngine {
  private readonly repository: AutomationRepository;
  private readonly handlers: AutomationHandlers;
  private readonly baseUrl: string;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private readonly failureAlert: (task: TaskWithSteps, error: string) => Promise<unknown>;
  private readonly now: () => Date;

  constructor(options: AutomationEngineOptions) {
    this.repository = options.repository;
    this.handlers = options.handlers;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.leaseMs = options.leaseMs || DEFAULT_LEASE_MS;
    this.retryDelayMs = options.retryDelayMs || DEFAULT_RETRY_DELAY_MS;
    this.now = options.now || (() => new Date());
    this.failureAlert = options.failureAlert || ((task, error) => sendFeishuText(
      `[自动化任务失败]\n类型: ${task.taskType}\n日期: ${task.dateKey}\n任务: ${task.id}\n错误: ${error}`,
    ));
  }

  async enqueue(input: CreateTaskInput): Promise<TaskWithSteps> {
    return this.repository.createIdempotent(input, AUTOMATION_DEFINITIONS[input.taskType]);
  }

  async ensureDueTasks(now = this.now()): Promise<TaskWithSteps[]> {
    const tasks: TaskWithSteps[] = [];
    for (const definition of Object.values(AUTOMATION_DEFINITIONS)) {
      if (!isFixedScheduleDefinition(definition) || !isDue(definition, now)) continue;
      tasks.push(await this.enqueue({
        taskType: definition.type,
        dateKey: definition.resolveDateKey(now),
        scheduledAt: scheduledAt(definition, now),
        payload: { trigger: "schedule" },
      }));
    }
    return tasks;
  }

  async reconcileMatchT30Tasks(now = this.now()): Promise<TaskWithSteps[]> {
    const dateKey = beijingParts(now).dateKey;
    const dates = [dateKey, shiftDateKey(dateKey, 1)];
    const reconciled: TaskWithSteps[] = [];

    for (const date of dates) {
      try {
        const [predictionResult, scheduleResult] = await Promise.all([
          requestJson<{ predictions?: Record<string, unknown> }>(`${this.baseUrl}/api/analysis?date=${date}`),
          requestJson<{ data?: { matches?: ScheduleMatch[] } }>(`${this.baseUrl}/api/schedule?date=${date}&mode=future`),
        ]);
        const predictions = predictionResult.predictions || {};
        const matches = Array.isArray(scheduleResult.data?.matches) ? scheduleResult.data.matches : [];

        for (const match of matches) {
          if (!match.id || match.state !== "0" || !predictions[match.id]) continue;
          try {
            const task = await upsertMatchT30Task(this.repository, {
              matchId: match.id,
              matchDate: date,
              matchTime: match.time,
              homeTeam: match.homeTeam,
              awayTeam: match.awayTeam,
              league: match.league,
              scheduleMode: "future",
            }, now);
            if (task) reconciled.push(task);
          } catch (error) {
            console.error(`[Automation] T-30 task repair failed for ${match.id}:`, error);
          }
        }
      } catch (error) {
        console.error(`[Automation] T-30 reconciliation failed for ${date}:`, error);
      }
    }
    return reconciled;
  }

  async compensate(now = this.now(), types?: AutomationTaskType[]): Promise<TaskWithSteps[]> {
    const parts = beijingParts(now);
    if (parts.hour < 12 || (parts.hour === 12 && parts.minute < 2)) {
      throw new Error("北京时间12:02后才可执行当日补偿");
    }
    const selected = types?.length ? types : (["odds-fetch", "crown-snapshot", "analysis"] as AutomationTaskType[]);
    const tasks: TaskWithSteps[] = [];
    for (const type of selected) {
      const definition = AUTOMATION_DEFINITIONS[type];
      if (!isFixedScheduleDefinition(definition)) throw new Error(`动态任务不支持手工日补偿: ${type}`);
      tasks.push(await this.enqueue({
        taskType: type,
        dateKey: definition.resolveDateKey(now),
        scheduledAt: now.toISOString(),
        payload: { trigger: "manual-compensation" },
      }));
    }
    return tasks;
  }

  async runAvailable(maxTasks = 1): Promise<TaskWithSteps[]> {
    const owner = `automation-${randomUUID()}`;
    const processed: TaskWithSteps[] = [];
    for (let index = 0; index < Math.max(1, Math.min(maxTasks, 20)); index++) {
      const task = await this.repository.claimNext(owner, this.now(), this.leaseMs);
      if (!task) break;
      await this.execute(task);
      processed.push(task);
    }
    return processed;
  }

  private async execute(task: TaskWithSteps): Promise<void> {
    const outputs: Record<string, unknown> = {};
    for (const completed of task.steps.filter((step) => step.status === "completed")) {
      outputs[completed.stepKey] = completed.output;
    }

    for (const step of task.steps.filter((candidate) => candidate.status !== "completed")) {
      const handler = this.handlers[task.taskType]?.[step.stepKey];
      if (!handler) {
        await this.fail(task, step, `未注册步骤处理器: ${task.taskType}/${step.stepKey}`, false);
        return;
      }

      await this.repository.markStepRunning(task.id, step.stepKey, this.now());
      try {
        const output = await handler({ task, step, outputs, baseUrl: this.baseUrl });
        outputs[step.stepKey] = output;
        await this.repository.markStepCompleted(task.id, step.stepKey, output, this.now());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = step.attemptCount + 1 < step.maxAttempts && task.attemptCount < task.maxAttempts;
        await this.fail(task, step, message, retryable);
        return;
      }
    }

    await this.repository.markTaskCompleted(task.id, outputs, this.now());
  }

  private async fail(task: TaskWithSteps, step: TaskWithSteps["steps"][number], error: string, retryable: boolean): Promise<void> {
    const now = this.now();
    await this.repository.markStepFailed(task.id, step.stepKey, error, retryable, now);
    await this.repository.markTaskFailed(
      task.id,
      error,
      retryable,
      retryable ? new Date(now.getTime() + this.retryDelayMs) : null,
      now,
    );
    if (!retryable) {
      await this.failureAlert(task, error).catch(() => undefined);
    }
  }
}
