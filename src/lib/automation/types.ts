export const AUTOMATION_TASK_TYPES = [
  "odds-fetch",
  "crown-snapshot",
  "analysis",
  "match-t30-analysis",
  "verify-learn-report",
] as const;

export type AutomationTaskType = (typeof AUTOMATION_TASK_TYPES)[number];
export type AutomationTaskStatus = "pending" | "running" | "retrying" | "completed" | "failed";
export type AutomationStepStatus = "pending" | "running" | "retrying" | "completed" | "failed";

export interface AutomationStepDefinition {
  key: string;
  maxAttempts?: number;
}

export interface AutomationTaskDefinition {
  type: AutomationTaskType;
  hour?: number;
  minute?: number;
  steps: AutomationStepDefinition[];
  resolveDateKey?(now: Date): string;
}

export interface AutomationTask {
  id: string;
  taskType: AutomationTaskType;
  dateKey: string;
  matchId: string | null;
  source: string;
  idempotencyKey: string;
  status: AutomationTaskStatus;
  currentStep: string | null;
  attemptCount: number;
  maxAttempts: number;
  lockOwner: string | null;
  lockExpiresAt: string | null;
  payload: Record<string, unknown>;
  result: unknown;
  lastError: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationTaskStep {
  id: number;
  taskId: string;
  stepKey: string;
  ordinal: number;
  idempotencyKey: string;
  status: AutomationStepStatus;
  attemptCount: number;
  maxAttempts: number;
  input: Record<string, unknown>;
  output: unknown;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  taskType: AutomationTaskType;
  dateKey: string;
  source?: string;
  matchId?: string | null;
  payload?: Record<string, unknown>;
  scheduledAt?: string | null;
  maxAttempts?: number;
}

export interface TaskWithSteps extends AutomationTask {
  steps: AutomationTaskStep[];
}

export interface AutomationRepository {
  createIdempotent(input: CreateTaskInput, definition: AutomationTaskDefinition): Promise<TaskWithSteps>;
  createOrReschedule(input: CreateTaskInput, definition: AutomationTaskDefinition): Promise<TaskWithSteps>;
  list(filters: { dateKey?: string; taskTypes?: AutomationTaskType[]; limit?: number }): Promise<TaskWithSteps[]>;
  claimNext(owner: string, now: Date, leaseMs: number): Promise<TaskWithSteps | null>;
  markStepRunning(taskId: string, stepKey: string, now: Date): Promise<void>;
  markStepCompleted(taskId: string, stepKey: string, output: unknown, now: Date): Promise<void>;
  markStepFailed(taskId: string, stepKey: string, error: string, retryable: boolean, now: Date): Promise<void>;
  markTaskCompleted(taskId: string, result: unknown, now: Date): Promise<void>;
  markTaskFailed(taskId: string, error: string, retryable: boolean, retryAt: Date | null, now: Date): Promise<void>;
}

export interface StepExecutionContext {
  task: AutomationTask;
  step: AutomationTaskStep;
  outputs: Record<string, unknown>;
  baseUrl: string;
}

export type AutomationStepHandler = (context: StepExecutionContext) => Promise<unknown>;
export type AutomationHandlers = Record<AutomationTaskType, Record<string, AutomationStepHandler>>;
