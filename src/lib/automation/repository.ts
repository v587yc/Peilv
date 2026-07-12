import { randomUUID } from "node:crypto";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { stepIdempotencyKey, taskIdempotencyKey } from "./definitions";
import type {
  AutomationRepository,
  AutomationTask,
  AutomationTaskDefinition,
  AutomationTaskStep,
  AutomationTaskType,
  CreateTaskInput,
  TaskWithSteps,
} from "./types";

type DbRecord = Record<string, unknown>;

const ANALYSIS_TASK_TYPES = new Set<AutomationTaskType>(["analysis", "match-t30-analysis"]);

function taskFromRow(row: DbRecord): AutomationTask {
  return {
    id: String(row.id),
    taskType: row.task_type as AutomationTask["taskType"],
    dateKey: String(row.date_key),
    matchId: row.match_id ? String(row.match_id) : null,
    source: String(row.source),
    idempotencyKey: String(row.idempotency_key),
    status: row.status as AutomationTask["status"],
    currentStep: row.current_step ? String(row.current_step) : null,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    lockOwner: row.lock_owner ? String(row.lock_owner) : null,
    lockExpiresAt: row.lock_expires_at ? String(row.lock_expires_at) : null,
    payload: (row.payload || {}) as Record<string, unknown>,
    result: row.result ?? null,
    lastError: row.last_error ? String(row.last_error) : null,
    scheduledAt: row.scheduled_at ? String(row.scheduled_at) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function stepFromRow(row: DbRecord): AutomationTaskStep {
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    stepKey: String(row.step_key),
    ordinal: Number(row.ordinal),
    idempotencyKey: String(row.idempotency_key),
    status: row.status as AutomationTaskStep["status"],
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    input: (row.input || {}) as Record<string, unknown>,
    output: row.output ?? null,
    lastError: row.last_error ? String(row.last_error) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SupabaseAutomationRepository implements AutomationRepository {
  private readonly client = getSupabaseClient();

  async createIdempotent(input: CreateTaskInput, definition: AutomationTaskDefinition): Promise<TaskWithSteps> {
    const source = input.source || "production";
    const key = taskIdempotencyKey(input.taskType, input.dateKey, source, input.matchId);
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      task_type: input.taskType,
      date_key: input.dateKey,
      match_id: input.matchId || null,
      source,
      idempotency_key: key,
      status: "pending",
      attempt_count: 0,
      max_attempts: input.maxAttempts || 3,
      payload: input.payload || {},
      scheduled_at: input.scheduledAt || now,
      updated_at: now,
    };

    const inserted = await this.client.from("automation_tasks").insert(row).select("*").maybeSingle();
    let taskRow = inserted.data as DbRecord | null;
    if (inserted.error) {
      if (inserted.error.code !== "23505") throw new Error(inserted.error.message);
      const existing = await this.client
        .from("automation_tasks")
        .select("*")
        .eq("idempotency_key", key)
        .maybeSingle();
      if (existing.error || !existing.data) throw new Error(existing.error?.message || "幂等任务查询失败");
      taskRow = existing.data as DbRecord;
    }
    if (!taskRow) throw new Error("任务创建失败");

    let task = taskFromRow(taskRow);
    if (task.status === "failed" && input.payload?.trigger === "manual-compensation") {
      const rearmed = await this.client.from("automation_tasks").update({
        status: "pending",
        current_step: null,
        attempt_count: 0,
        last_error: null,
        completed_at: null,
        scheduled_at: input.scheduledAt || now,
        updated_at: now,
      }).eq("id", task.id).eq("status", "failed").select("*").maybeSingle();
      if (rearmed.error) throw new Error(rearmed.error.message);
      if (rearmed.data) {
        const resetSteps = await this.client.from("automation_task_steps").update({
          status: "pending",
          attempt_count: 0,
          last_error: null,
          started_at: null,
          completed_at: null,
          updated_at: now,
        }).eq("task_id", task.id).in("status", ["failed", "retrying", "running"]);
        if (resetSteps.error) throw new Error(resetSteps.error.message);
        task = taskFromRow(rearmed.data as DbRecord);
      }
    }
    const stepRows = definition.steps.map((step, ordinal) => ({
      task_id: task.id,
      step_key: step.key,
      ordinal,
      idempotency_key: stepIdempotencyKey(key, step.key),
      status: "pending",
      max_attempts: step.maxAttempts || 3,
      input: {},
      updated_at: now,
    }));
    const ensured = await this.client.from("automation_task_steps").upsert(stepRows, {
      onConflict: "task_id,step_key",
      ignoreDuplicates: true,
    });
    if (ensured.error) throw new Error(ensured.error.message);
    return this.getWithSteps(task.id);
  }

  async createOrReschedule(input: CreateTaskInput, definition: AutomationTaskDefinition): Promise<TaskWithSteps> {
    const task = await this.createIdempotent(input, definition);
    const scheduledAt = input.scheduledAt || task.scheduledAt;
    const payload = input.payload || {};
    const changed = task.status === "pending" && (
      task.dateKey !== input.dateKey
      || task.matchId !== (input.matchId || null)
      || task.scheduledAt !== scheduledAt
      || JSON.stringify(task.payload) !== JSON.stringify(payload)
    );
    if (!changed) return task;

    const { data, error } = await this.client.from("automation_tasks").update({
      date_key: input.dateKey,
      match_id: input.matchId || null,
      payload,
      scheduled_at: scheduledAt,
      updated_at: new Date().toISOString(),
    }).eq("id", task.id).eq("status", "pending").select("*").maybeSingle();
    if (error) throw new Error(error.message);
    return data ? this.getWithSteps(String(data.id)) : this.getWithSteps(task.id);
  }

  async list(filters: { dateKey?: string; taskTypes?: AutomationTaskType[]; limit?: number }): Promise<TaskWithSteps[]> {
    let query = this.client.from("automation_tasks").select("*").order("created_at", { ascending: false });
    if (filters.dateKey) query = query.eq("date_key", filters.dateKey);
    if (filters.taskTypes?.length) query = query.in("task_type", filters.taskTypes);
    const { data, error } = await query.limit(Math.min(filters.limit || 50, 100));
    if (error) throw new Error(error.message);
    const tasks = (data || []).map((row) => taskFromRow(row as DbRecord));
    if (tasks.length === 0) return [];
    const stepsResult = await this.client
      .from("automation_task_steps")
      .select("*")
      .in("task_id", tasks.map((task) => task.id))
      .order("ordinal", { ascending: true });
    if (stepsResult.error) throw new Error(stepsResult.error.message);
    const byTask = new Map<string, AutomationTaskStep[]>();
    for (const row of stepsResult.data || []) {
      const step = stepFromRow(row as DbRecord);
      const current = byTask.get(step.taskId) || [];
      current.push(step);
      byTask.set(step.taskId, current);
    }
    return tasks.map((task) => ({ ...task, steps: byTask.get(task.id) || [] }));
  }

  async claimNext(owner: string, now: Date, leaseMs: number): Promise<TaskWithSteps | null> {
    const nowIso = now.toISOString();
    const ready = await this.client
      .from("automation_tasks")
      .select("*")
      .in("status", ["pending", "retrying"])
      .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`)
      .order("scheduled_at", { ascending: true })
      .limit(10);
    if (ready.error) throw new Error(ready.error.message);

    for (const candidateRow of ready.data || []) {
      const candidate = taskFromRow(candidateRow as DbRecord);
      const claimed = await this.claimCandidate(candidate, owner, now, leaseMs);
      if (claimed) return claimed;
    }

    const expired = await this.client
      .from("automation_tasks")
      .select("*")
      .eq("status", "running")
      .lt("lock_expires_at", nowIso)
      .order("lock_expires_at", { ascending: true })
      .limit(10);
    if (expired.error) throw new Error(expired.error.message);
    for (const candidateRow of expired.data || []) {
      const candidate = taskFromRow(candidateRow as DbRecord);
      const claimed = await this.claimCandidate(candidate, owner, now, leaseMs);
      if (claimed) return claimed;
    }
    return null;
  }

  async markStepRunning(taskId: string, stepKey: string, now: Date): Promise<void> {
    const existing = await this.getStep(taskId, stepKey);
    const [stepResult, taskResult] = await Promise.all([
      this.client.from("automation_task_steps").update({
        status: "running",
        attempt_count: existing.attemptCount + 1,
        started_at: existing.startedAt || now.toISOString(),
        last_error: null,
        updated_at: now.toISOString(),
      }).eq("task_id", taskId).eq("step_key", stepKey),
      this.client.from("automation_tasks").update({
        current_step: stepKey,
        updated_at: now.toISOString(),
      }).eq("id", taskId),
    ]);
    if (stepResult.error) throw new Error(stepResult.error.message);
    if (taskResult.error) throw new Error(taskResult.error.message);
  }

  async markStepCompleted(taskId: string, stepKey: string, output: unknown, now: Date): Promise<void> {
    const { error } = await this.client.from("automation_task_steps").update({
      status: "completed",
      output: output ?? null,
      last_error: null,
      completed_at: now.toISOString(),
      updated_at: now.toISOString(),
    }).eq("task_id", taskId).eq("step_key", stepKey);
    if (error) throw new Error(error.message);
  }

  async markStepFailed(taskId: string, stepKey: string, errorMessage: string, retryable: boolean, now: Date): Promise<void> {
    const { error } = await this.client.from("automation_task_steps").update({
      status: retryable ? "retrying" : "failed",
      last_error: errorMessage,
      updated_at: now.toISOString(),
    }).eq("task_id", taskId).eq("step_key", stepKey);
    if (error) throw new Error(error.message);
  }

  async markTaskCompleted(taskId: string, result: unknown, now: Date): Promise<void> {
    const { error } = await this.client.from("automation_tasks").update({
      status: "completed",
      current_step: null,
      result: result ?? null,
      last_error: null,
      lock_owner: null,
      lock_expires_at: null,
      completed_at: now.toISOString(),
      updated_at: now.toISOString(),
    }).eq("id", taskId);
    if (error) throw new Error(error.message);
  }

  async markTaskFailed(taskId: string, errorMessage: string, retryable: boolean, retryAt: Date | null, now: Date): Promise<void> {
    const { error } = await this.client.from("automation_tasks").update({
      status: retryable ? "retrying" : "failed",
      current_step: null,
      last_error: errorMessage,
      lock_owner: null,
      lock_expires_at: null,
      scheduled_at: retryable && retryAt ? retryAt.toISOString() : undefined,
      completed_at: retryable ? null : now.toISOString(),
      updated_at: now.toISOString(),
    }).eq("id", taskId);
    if (error) throw new Error(error.message);
  }

  private async claimCandidate(candidate: AutomationTask, owner: string, now: Date, leaseMs: number): Promise<TaskWithSteps | null> {
    let query = this.client.from("automation_tasks").update({
      status: "running",
      attempt_count: candidate.attemptCount + 1,
      lock_owner: owner,
      lock_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
      started_at: candidate.startedAt || now.toISOString(),
      updated_at: now.toISOString(),
    }).eq("id", candidate.id).eq("status", candidate.status);
    if (candidate.status === "running" && candidate.lockExpiresAt) {
      query = query.eq("lock_expires_at", candidate.lockExpiresAt);
    }
    const { data, error } = await query.select("*").maybeSingle();
    if (error) {
      if (error.code === "23505" && ANALYSIS_TASK_TYPES.has(candidate.taskType)) return null;
      throw new Error(error.message);
    }
    return data ? this.getWithSteps(String(data.id)) : null;
  }

  private async getWithSteps(taskId: string): Promise<TaskWithSteps> {
    const [taskResult, stepsResult] = await Promise.all([
      this.client.from("automation_tasks").select("*").eq("id", taskId).single(),
      this.client.from("automation_task_steps").select("*").eq("task_id", taskId).order("ordinal", { ascending: true }),
    ]);
    if (taskResult.error) throw new Error(taskResult.error.message);
    if (stepsResult.error) throw new Error(stepsResult.error.message);
    return {
      ...taskFromRow(taskResult.data as DbRecord),
      steps: (stepsResult.data || []).map((row) => stepFromRow(row as DbRecord)),
    };
  }

  private async getStep(taskId: string, stepKey: string): Promise<AutomationTaskStep> {
    const { data, error } = await this.client
      .from("automation_task_steps")
      .select("*")
      .eq("task_id", taskId)
      .eq("step_key", stepKey)
      .single();
    if (error) throw new Error(error.message);
    return stepFromRow(data as DbRecord);
  }
}
