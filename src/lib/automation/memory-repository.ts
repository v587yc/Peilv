import { randomUUID } from "node:crypto";
import { stepIdempotencyKey, taskIdempotencyKey } from "./definitions";
import type {
  AutomationRepository,
  AutomationTaskDefinition,
  AutomationTaskStep,
  AutomationTaskType,
  CreateTaskInput,
  TaskWithSteps,
} from "./types";

const ANALYSIS_TASK_TYPES = new Set<AutomationTaskType>(["analysis", "match-t30-analysis"]);

export class MemoryAutomationRepository implements AutomationRepository {
  private tasks = new Map<string, TaskWithSteps>();
  private nextStepId = 1;

  async createIdempotent(input: CreateTaskInput, definition: AutomationTaskDefinition): Promise<TaskWithSteps> {
    const source = input.source || "production";
    const key = taskIdempotencyKey(input.taskType, input.dateKey, source, input.matchId);
    const existing = [...this.tasks.values()].find((task) => task.idempotencyKey === key);
    if (existing) {
      if (existing.status === "failed" && input.payload?.trigger === "manual-compensation") {
        const now = new Date().toISOString();
        existing.status = "pending";
        existing.currentStep = null;
        existing.attemptCount = 0;
        existing.lastError = null;
        existing.completedAt = null;
        existing.scheduledAt = input.scheduledAt || now;
        existing.updatedAt = now;
        for (const step of existing.steps.filter((candidate) => candidate.status !== "completed")) {
          step.status = "pending";
          step.attemptCount = 0;
          step.lastError = null;
          step.startedAt = null;
          step.completedAt = null;
          step.updatedAt = now;
        }
      }
      return structuredClone(existing);
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const steps: AutomationTaskStep[] = definition.steps.map((step, ordinal) => ({
      id: this.nextStepId++,
      taskId: id,
      stepKey: step.key,
      ordinal,
      idempotencyKey: stepIdempotencyKey(key, step.key),
      status: "pending",
      attemptCount: 0,
      maxAttempts: step.maxAttempts || 3,
      input: {},
      output: null,
      lastError: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    }));
    const task: TaskWithSteps = {
      id,
      taskType: input.taskType,
      dateKey: input.dateKey,
      matchId: input.matchId || null,
      source,
      idempotencyKey: key,
      status: "pending",
      currentStep: null,
      attemptCount: 0,
      maxAttempts: input.maxAttempts || 3,
      lockOwner: null,
      lockExpiresAt: null,
      payload: input.payload || {},
      result: null,
      lastError: null,
      scheduledAt: input.scheduledAt || now,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      steps,
    };
    this.tasks.set(id, task);
    return structuredClone(task);
  }

  async createOrReschedule(input: CreateTaskInput, definition: AutomationTaskDefinition): Promise<TaskWithSteps> {
    const task = await this.createIdempotent(input, definition);
    const stored = this.required(task.id);
    if (stored.status === "pending") {
      const now = new Date().toISOString();
      stored.dateKey = input.dateKey;
      stored.matchId = input.matchId || null;
      stored.payload = input.payload || {};
      stored.scheduledAt = input.scheduledAt || stored.scheduledAt;
      stored.updatedAt = now;
    }
    return structuredClone(stored);
  }

  async list(filters: { dateKey?: string; taskTypes?: AutomationTaskType[]; limit?: number }): Promise<TaskWithSteps[]> {
    return [...this.tasks.values()]
      .filter((task) => !filters.dateKey || task.dateKey === filters.dateKey)
      .filter((task) => !filters.taskTypes?.length || filters.taskTypes.includes(task.taskType))
      .slice(0, filters.limit || 50)
      .map((task) => structuredClone(task));
  }

  async claimNext(owner: string, now: Date, leaseMs: number): Promise<TaskWithSteps | null> {
    const candidates = [...this.tasks.values()].filter((task) => {
      const scheduled = !task.scheduledAt || new Date(task.scheduledAt) <= now;
      const ready = (task.status === "pending" || task.status === "retrying") && scheduled;
      const expired = task.status === "running" && !!task.lockExpiresAt && new Date(task.lockExpiresAt) < now;
      return ready || expired;
    });
    for (const candidate of candidates) {
      if (ANALYSIS_TASK_TYPES.has(candidate.taskType) && candidate.status !== "running") {
        const analysisRunning = [...this.tasks.values()].some((task) => (
          task.id !== candidate.id
          && task.status === "running"
          && ANALYSIS_TASK_TYPES.has(task.taskType)
        ));
        if (analysisRunning) continue;
      }
      candidate.status = "running";
      candidate.attemptCount++;
      candidate.lockOwner = owner;
      candidate.lockExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      candidate.startedAt ||= now.toISOString();
      candidate.updatedAt = now.toISOString();
      return structuredClone(candidate);
    }
    return null;
  }

  async markStepRunning(taskId: string, stepKey: string, now: Date): Promise<void> {
    const task = this.required(taskId);
    const step = this.requiredStep(task, stepKey);
    step.status = "running";
    step.attemptCount++;
    step.startedAt ||= now.toISOString();
    step.lastError = null;
    step.updatedAt = now.toISOString();
    task.currentStep = stepKey;
  }

  async markStepCompleted(taskId: string, stepKey: string, output: unknown, now: Date): Promise<void> {
    const step = this.requiredStep(this.required(taskId), stepKey);
    step.status = "completed";
    step.output = output;
    step.lastError = null;
    step.completedAt = now.toISOString();
    step.updatedAt = now.toISOString();
  }

  async markStepFailed(taskId: string, stepKey: string, error: string, retryable: boolean, now: Date): Promise<void> {
    const step = this.requiredStep(this.required(taskId), stepKey);
    step.status = retryable ? "retrying" : "failed";
    step.lastError = error;
    step.updatedAt = now.toISOString();
  }

  async markTaskCompleted(taskId: string, result: unknown, now: Date): Promise<void> {
    const task = this.required(taskId);
    task.status = "completed";
    task.currentStep = null;
    task.result = result;
    task.lastError = null;
    task.lockOwner = null;
    task.lockExpiresAt = null;
    task.completedAt = now.toISOString();
    task.updatedAt = now.toISOString();
  }

  async markTaskFailed(taskId: string, error: string, retryable: boolean, retryAt: Date | null, now: Date): Promise<void> {
    const task = this.required(taskId);
    task.status = retryable ? "retrying" : "failed";
    task.currentStep = null;
    task.lastError = error;
    task.lockOwner = null;
    task.lockExpiresAt = null;
    if (retryable && retryAt) task.scheduledAt = retryAt.toISOString();
    if (!retryable) task.completedAt = now.toISOString();
    task.updatedAt = now.toISOString();
  }

  private required(taskId: string): TaskWithSteps {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    return task;
  }

  private requiredStep(task: TaskWithSteps, stepKey: string): AutomationTaskStep {
    const step = task.steps.find((candidate) => candidate.stepKey === stepKey);
    if (!step) throw new Error(`Unknown step ${stepKey}`);
    return step;
  }
}
