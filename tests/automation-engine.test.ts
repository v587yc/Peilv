import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_DEFINITIONS,
  matchKickoffAt,
  matchT30ScheduledAt,
  taskIdempotencyKey,
} from "@/lib/automation/definitions";
import { AutomationEngine } from "@/lib/automation/engine";
import { buildMatchT30TaskInput, upsertMatchT30Task } from "@/lib/automation/match-t30-task";
import { MemoryAutomationRepository } from "@/lib/automation/memory-repository";
import type { AutomationHandlers } from "@/lib/automation/types";

function handlers(overrides: Partial<AutomationHandlers["odds-fetch"]> = {}): AutomationHandlers {
  const pass = async () => ({ ok: true });
  return {
    "odds-fetch": {
      "discover-matches": pass,
      "fetch-odds": pass,
      ...overrides,
    },
    "crown-snapshot": { "discover-matches": pass, "snapshot-crown": pass },
    analysis: { "discover-candidates": pass, "analyze-matches": pass },
    "match-t30-analysis": { "load-match": pass, "reanalyze-match": pass },
    "verify-learn-report": { verify: pass, learn: pass, report: pass },
  };
}

function engineAt(repository: MemoryAutomationRepository, nowRef: { value: Date }, taskHandlers = handlers(), alert = vi.fn()) {
  return new AutomationEngine({
    repository,
    handlers: taskHandlers,
    baseUrl: "https://app.invalid",
    retryDelayMs: 1_000,
    leaseMs: 10_000,
    now: () => nowRef.value,
    failureAlert: alert,
  });
}

describe("automation task engine", () => {
  it("defines all required workflows and their ordered steps", () => {
    expect(Object.keys(AUTOMATION_DEFINITIONS).sort()).toEqual([
      "analysis",
      "crown-snapshot",
      "match-t30-analysis",
      "odds-fetch",
      "verify-learn-report",
    ]);
    expect(AUTOMATION_DEFINITIONS["verify-learn-report"].steps.map((step) => step.key)).toEqual([
      "verify",
      "learn",
      "report",
    ]);
  });

  it("uses one idempotency key for repeated task creation", async () => {
    const repository = new MemoryAutomationRepository();
    const nowRef = { value: new Date("2026-07-10T04:03:00.000Z") };
    const engine = engineAt(repository, nowRef);

    const first = await engine.enqueue({ taskType: "odds-fetch", dateKey: "20260710" });
    const second = await engine.enqueue({ taskType: "odds-fetch", dateKey: "20260710" });

    expect(second.id).toBe(first.id);
    expect((await repository.list({}))).toHaveLength(1);
    expect(first.steps.map((step) => step.idempotencyKey)).toEqual([
      `${first.idempotencyKey}:discover-matches`,
      `${first.idempotencyKey}:fetch-odds`,
    ]);
  });

  it("keeps daily keys stable and scopes T-30 keys by match", () => {
    expect(taskIdempotencyKey("analysis", "20260711")).toBe("automation:production:analysis:20260711");
    expect(taskIdempotencyKey("match-t30-analysis", "20260711", "production", "match-1"))
      .toBe("automation:production:match-t30-analysis:match-1");
    expect(taskIdempotencyKey("match-t30-analysis", "20260712", "production", "match-2"))
      .not.toBe(taskIdempotencyKey("match-t30-analysis", "20260711", "production", "match-1"));
  });

  it("parses Beijing kickoff times and schedules cross-midnight T-30", () => {
    expect(matchKickoffAt("20260712", "12日00:15")?.toISOString()).toBe("2026-07-11T16:15:00.000Z");
    expect(matchKickoffAt("20260712", "7-12 00:15")?.toISOString()).toBe("2026-07-11T16:15:00.000Z");
    expect(matchT30ScheduledAt("20260712", "00:15")?.toISOString()).toBe("2026-07-11T15:45:00.000Z");
    expect(matchKickoffAt("20260712", "7-11 00:15")).toBeNull();
    expect(matchKickoffAt("20260712", "11日00:15")).toBeNull();
    expect(matchKickoffAt("20260230", "12:00")).toBeNull();
  });

  it("builds and idempotently upserts event-driven T-30 tasks", async () => {
    const repository = new MemoryAutomationRepository();
    const metadata = {
      matchId: "event-match",
      matchDate: "20260712",
      matchTime: "7-12 10:30",
      homeTeam: "主队",
      awayTeam: "客队",
      league: "测试联赛",
      scheduleMode: "today",
    };
    const now = new Date("2026-07-12T01:00:00.000Z");
    const input = buildMatchT30TaskInput(metadata, now);

    expect(input).toMatchObject({
      taskType: "match-t30-analysis",
      source: "production",
      dateKey: "20260712",
      matchId: "event-match",
      scheduledAt: "2026-07-12T02:00:00.000Z",
      payload: expect.objectContaining({ kickoffAt: "2026-07-12T02:30:00.000Z" }),
    });
    const first = await upsertMatchT30Task(repository, metadata, now);
    const second = await upsertMatchT30Task(repository, metadata, now);
    expect(second?.id).toBe(first?.id);
    expect(await repository.list({ taskTypes: ["match-t30-analysis"] })).toHaveLength(1);
    expect(buildMatchT30TaskInput(metadata, new Date("2026-07-12T02:31:00.000Z"))).toBeNull();
  });

  it("reconciles only analyzed matches and reschedules only while pending", async () => {
    const repository = new MemoryAutomationRepository();
    const nowRef = { value: new Date("2026-07-11T04:00:00.000Z") };
    const engine = engineAt(repository, nowRef);
    let matchTime = "11日13:00";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const date = new URL(url).searchParams.get("date");
      if (url.includes("/api/analysis")) {
        return new Response(JSON.stringify({ predictions: date === "20260711" ? { "match-1": {} } : {} }));
      }
      return new Response(JSON.stringify({
        success: true,
        data: {
          matches: date === "20260711" ? [
            { id: "match-1", league: "测试联赛", time: matchTime, state: "0", homeTeam: "主队", awayTeam: "客队", matchDate: date },
            { id: "match-2", league: "测试联赛", time: matchTime, state: "0", homeTeam: "主队2", awayTeam: "客队2", matchDate: date },
          ] : [],
        },
      }));
    }));

    try {
      const first = await engine.reconcileMatchT30Tasks();
      const repeated = await engine.reconcileMatchT30Tasks();
      expect(first).toHaveLength(1);
      expect(repeated[0].id).toBe(first[0].id);
      expect((await repository.list({}))).toHaveLength(1);
      expect(first[0].scheduledAt).toBe("2026-07-11T04:30:00.000Z");

      matchTime = "11日14:00";
      const [rescheduled] = await engine.reconcileMatchT30Tasks();
      expect(rescheduled.id).toBe(first[0].id);
      expect(rescheduled.scheduledAt).toBe("2026-07-11T05:30:00.000Z");

      nowRef.value = new Date("2026-07-11T05:31:00.000Z");
      await engine.runAvailable(1);
      matchTime = "11日15:00";
      const [completed] = await engine.reconcileMatchT30Tasks();
      expect(completed.status).toBe("completed");
      expect(completed.scheduledAt).toBe("2026-07-11T05:30:00.000Z");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not claim two analysis-family tasks concurrently", async () => {
    const repository = new MemoryAutomationRepository();
    const now = new Date("2026-07-11T04:00:00.000Z");
    await repository.createIdempotent(
      { taskType: "analysis", dateKey: "20260711", scheduledAt: now.toISOString() },
      AUTOMATION_DEFINITIONS.analysis,
    );
    await repository.createIdempotent(
      { taskType: "match-t30-analysis", dateKey: "20260711", matchId: "match-1", scheduledAt: now.toISOString() },
      AUTOMATION_DEFINITIONS["match-t30-analysis"],
    );

    const first = await repository.claimNext("worker-a", now, 10_000);
    const blocked = await repository.claimNext("worker-b", now, 10_000);
    expect(first?.taskType).toBe("analysis");
    expect(blocked).toBeNull();

    await repository.markTaskCompleted(first!.id, {}, now);
    const second = await repository.claimNext("worker-b", now, 10_000);
    expect(second?.taskType).toBe("match-t30-analysis");
  });

  it("allows only one owner to claim a task until its lease expires", async () => {
    const repository = new MemoryAutomationRepository();
    const now = new Date("2026-07-10T04:03:00.000Z");
    await repository.createIdempotent(
      { taskType: "odds-fetch", dateKey: "20260710", scheduledAt: now.toISOString() },
      AUTOMATION_DEFINITIONS["odds-fetch"],
    );

    const [first, second] = await Promise.all([
      repository.claimNext("worker-a", now, 10_000),
      repository.claimNext("worker-b", now, 10_000),
    ]);
    expect(first?.lockOwner).toBe("worker-a");
    expect(second).toBeNull();

    const reclaimed = await repository.claimNext("worker-b", new Date(now.getTime() + 10_001), 10_000);
    expect(reclaimed?.id).toBe(first?.id);
    expect(reclaimed?.lockOwner).toBe("worker-b");
  });

  it("records completed step state and final task result", async () => {
    const repository = new MemoryAutomationRepository();
    const nowRef = { value: new Date("2026-07-10T04:03:00.000Z") };
    const engine = engineAt(repository, nowRef);
    await engine.enqueue({ taskType: "odds-fetch", dateKey: "20260710", scheduledAt: nowRef.value.toISOString() });

    await engine.runAvailable(1);
    const [task] = await repository.list({ dateKey: "20260710" });

    expect(task.status).toBe("completed");
    expect(task.currentStep).toBeNull();
    expect(task.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
    expect(task.steps.map((step) => step.attemptCount)).toEqual([1, 1]);
  });

  it("retries from the failed step without repeating completed steps", async () => {
    const repository = new MemoryAutomationRepository();
    const nowRef = { value: new Date("2026-07-10T04:03:00.000Z") };
    let oddsAttempts = 0;
    const engine = engineAt(repository, nowRef, handlers({
      "fetch-odds": async () => {
        oddsAttempts++;
        if (oddsAttempts === 1) throw new Error("temporary upstream failure");
        return { saved: 2 };
      },
    }));
    await engine.enqueue({ taskType: "odds-fetch", dateKey: "20260710", scheduledAt: nowRef.value.toISOString() });

    await engine.runAvailable(1);
    let [task] = await repository.list({ dateKey: "20260710" });
    expect(task.status).toBe("retrying");
    expect(task.steps.map((step) => step.status)).toEqual(["completed", "retrying"]);

    nowRef.value = new Date(nowRef.value.getTime() + 1_001);
    await engine.runAvailable(1);
    [task] = await repository.list({ dateKey: "20260710" });
    expect(task.status).toBe("completed");
    expect(task.steps.map((step) => step.attemptCount)).toEqual([1, 2]);
  });

  it("T-10 resumes a persisted retry after the engine process is recreated", async () => {
    const repository = new MemoryAutomationRepository();
    const nowRef = { value: new Date("2026-07-10T04:03:00.000Z") };
    let attempts = 0;
    const taskHandlers = handlers({
      "fetch-odds": async () => {
        attempts++;
        if (attempts === 1) throw new Error("network unavailable");
        return { saved: 1 };
      },
    });
    const firstProcess = engineAt(repository, nowRef, taskHandlers);
    await firstProcess.enqueue({ taskType: "odds-fetch", dateKey: "20260710", scheduledAt: nowRef.value.toISOString() });
    await firstProcess.runAvailable(1);

    let [task] = await repository.list({ dateKey: "20260710" });
    expect(task.status).toBe("retrying");
    expect(task.steps.map(step => step.status)).toEqual(["completed", "retrying"]);

    nowRef.value = new Date(nowRef.value.getTime() + 1_001);
    const restartedProcess = engineAt(repository, nowRef, taskHandlers);
    await restartedProcess.runAvailable(1);

    [task] = await repository.list({ dateKey: "20260710" });
    expect(task.status).toBe("completed");
    expect(task.steps.map(step => step.attemptCount)).toEqual([1, 2]);
    expect(attempts).toBe(2);
  });

  it("marks exhausted retries failed and sends one failure alert", async () => {
    const repository = new MemoryAutomationRepository();
    const nowRef = { value: new Date("2026-07-10T04:03:00.000Z") };
    const alert = vi.fn(async () => true);
    const engine = engineAt(repository, nowRef, handlers({
      "fetch-odds": async () => { throw new Error("permanent failure"); },
    }), alert);
    await engine.enqueue({ taskType: "odds-fetch", dateKey: "20260710", scheduledAt: nowRef.value.toISOString() });

    for (let attempt = 0; attempt < 3; attempt++) {
      await engine.runAvailable(1);
      nowRef.value = new Date(nowRef.value.getTime() + 1_001);
    }
    const [task] = await repository.list({ dateKey: "20260710" });
    expect(task.status).toBe("failed");
    expect(task.steps[1].status).toBe("failed");
    expect(task.lastError).toContain("permanent failure");
    expect(alert).toHaveBeenCalledTimes(1);

    const [rearmed] = await engine.compensate(nowRef.value, ["odds-fetch"]);
    expect(rearmed.id).toBe(task.id);
    expect(rearmed.status).toBe("pending");
    expect(rearmed.attemptCount).toBe(0);
    expect(rearmed.steps.map((step) => step.status)).toEqual(["completed", "pending"]);
  });

  it("permits idempotent manual compensation only after 12:02 Beijing time", async () => {
    const repository = new MemoryAutomationRepository();
    const nowRef = { value: new Date("2026-07-10T04:01:00.000Z") };
    const engine = engineAt(repository, nowRef);
    await expect(engine.compensate()).rejects.toThrow("12:02");

    nowRef.value = new Date("2026-07-10T04:02:00.000Z");
    const first = await engine.compensate();
    const second = await engine.compensate();
    expect(first.map((task) => task.id)).toEqual(second.map((task) => task.id));
    expect(new Set(first.map((task) => task.taskType))).toEqual(new Set(["odds-fetch", "crown-snapshot", "analysis"]));
    expect(await repository.list({ dateKey: "20260710" })).toHaveLength(3);
  });
});
