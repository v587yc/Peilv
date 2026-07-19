import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  ensureDueTasks: vi.fn(),
  runAvailable: vi.fn(),
  reconcileMatchT30Tasks: vi.fn(),
  createAutomationService: vi.fn(),
  reconcilePendingCommandAudits: vi.fn(),
  reconcileExpiredBacktestLeases: vi.fn(),
}));

vi.mock("@/lib/automation/service", () => ({
  createAutomationService: mocks.createAutomationService,
}));

vi.mock("@/features/management/command-reconciler", () => ({
  reconcilePendingCommandAudits: mocks.reconcilePendingCommandAudits,
}));

vi.mock("@/features/backtest/runtime", () => ({
  reconcileExpiredBacktestLeases: mocks.reconcileExpiredBacktestLeases,
}));

import { POST as dispatch } from "@/app/api/automation/dispatch/route";
import { POST as reconcile } from "@/app/api/automation/reconcile/route";

const originalSecret = process.env.INTERNAL_API_SECRET;

function request(path: string, secret = "Test_Internal_Secret_0123456789AB", body?: Record<string, unknown>) {
  return new NextRequest(`https://app.invalid${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-api-secret": secret,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  process.env.INTERNAL_API_SECRET = "Test_Internal_Secret_0123456789AB";
  mocks.ensureDueTasks.mockReset().mockResolvedValue([{ id: "daily-task" }]);
  mocks.runAvailable.mockReset().mockResolvedValue([{ id: "processed-task" }]);
  mocks.reconcileMatchT30Tasks.mockReset().mockResolvedValue([
    { id: "t30-task-1" },
    { id: "t30-task-2" },
  ]);
  mocks.reconcilePendingCommandAudits.mockReset().mockResolvedValue(3);
  mocks.reconcileExpiredBacktestLeases.mockReset().mockResolvedValue(4);
  mocks.createAutomationService.mockReset().mockReturnValue({
    engine: {
      ensureDueTasks: mocks.ensureDueTasks,
      runAvailable: mocks.runAvailable,
      reconcileMatchT30Tasks: mocks.reconcileMatchT30Tasks,
    },
  });
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.INTERNAL_API_SECRET;
  else process.env.INTERNAL_API_SECRET = originalSecret;
});

describe("automation dispatch route", () => {
  it("rejects an invalid internal secret before creating the service", async () => {
    const response = await dispatch(request("/api/automation/dispatch", "wrong-secret", { maxTasks: 5 }));

    expect(response.status).toBe(403);
    expect(mocks.createAutomationService).not.toHaveBeenCalled();
  });

  it("rejects a valid secret replayed for the wrong route before side effects", async () => {
    const forged = request("/api/automation/reconcile", undefined, { maxTasks: 5 });
    const response = await dispatch(forged);
    expect(response.status).toBe(403);
    expect(mocks.createAutomationService).not.toHaveBeenCalled();
  });

  it("ensures fixed tasks and drains due work without running reconciliation", async () => {
    const response = await dispatch(request("/api/automation/dispatch", undefined, { maxTasks: 50 }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.createAutomationService).toHaveBeenCalledWith("http://127.0.0.1:3000");
    expect(mocks.ensureDueTasks).toHaveBeenCalledOnce();
    expect(mocks.runAvailable).toHaveBeenCalledWith(20);
    expect(mocks.reconcileMatchT30Tasks).not.toHaveBeenCalled();
    expect(payload).toEqual({
      success: true,
      ensured: ["daily-task"],
      processed: ["processed-task"],
    });
    expect(payload).not.toHaveProperty("reconciled");
  });

  it("ignores an attacker-controlled request origin", async () => {
    await dispatch(request("/api/automation/dispatch", undefined, { maxTasks: 1 }));
    expect(mocks.createAutomationService).not.toHaveBeenCalledWith("https://app.invalid");
    expect(mocks.createAutomationService).toHaveBeenCalledWith("http://127.0.0.1:3000");
  });

  it("returns a server error when dispatching fails", async () => {
    mocks.runAvailable.mockRejectedValueOnce(new Error("queue unavailable"));

    const response = await dispatch(request("/api/automation/dispatch"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: "自动化调度失败" });
  });
});

describe("automation reconcile route", () => {
  it("rejects an invalid internal secret before creating the service", async () => {
    const response = await reconcile(request("/api/automation/reconcile", "wrong-secret"));

    expect(response.status).toBe(403);
    expect(mocks.createAutomationService).not.toHaveBeenCalled();
  });

  it("rejects a valid secret replayed for another purpose before side effects", async () => {
    const response = await reconcile(request("/api/automation/dispatch"));
    expect(response.status).toBe(403);
    expect(mocks.createAutomationService).not.toHaveBeenCalled();
  });

  it("runs T-30, command audit, and expired backtest reconciliation", async () => {
    const response = await reconcile(request("/api/automation/reconcile"));

    expect(response.status).toBe(200);
    expect(mocks.createAutomationService).toHaveBeenCalledWith("http://127.0.0.1:3000");
    expect(mocks.reconcileMatchT30Tasks).toHaveBeenCalledOnce();
    expect(mocks.reconcilePendingCommandAudits).toHaveBeenCalledWith(25);
    expect(mocks.reconcileExpiredBacktestLeases).toHaveBeenCalledWith(25);
    expect(mocks.ensureDueTasks).not.toHaveBeenCalled();
    expect(mocks.runAvailable).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      success: true,
      count: 2,
      reconciled: ["t30-task-1", "t30-task-2"],
      commandAudits: 3,
      expiredBacktests: 4,
    });
  });

  it("returns a server error when reconciliation fails", async () => {
    mocks.reconcileMatchT30Tasks.mockRejectedValueOnce(new Error("schedule source unavailable"));

    const response = await reconcile(request("/api/automation/reconcile"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: "赛前任务对账失败" });
    expect(mocks.ensureDueTasks).not.toHaveBeenCalled();
    expect(mocks.runAvailable).not.toHaveBeenCalled();
  });
});
