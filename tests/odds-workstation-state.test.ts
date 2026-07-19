import { describe, expect, it } from "vitest";
import {
  loadStoredValue,
  saveStoredValue,
} from "@/features/odds/workstation-storage";
import {
  automationStatusText,
  isAutomationCompensationAvailable,
  previousBeijingDateKey,
} from "@/features/odds/automation-view-model";
import type { AutomationTaskStatusData } from "@/features/odds/contracts";

function createStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function task(
  overrides: Partial<AutomationTaskStatusData> = {},
): AutomationTaskStatusData {
  return {
    id: "task-1",
    taskType: "analysis",
    status: "completed",
    currentStep: null,
    lastError: null,
    updatedAt: "2026-07-14T04:00:00.000Z",
    ...overrides,
  };
}

describe("workstation storage", () => {
  it("returns the fallback when a key is absent or contains invalid JSON", () => {
    const storage = createStorage({ broken: "{" });

    expect(loadStoredValue(storage, "missing", ["fallback"])).toEqual(["fallback"]);
    expect(loadStoredValue(storage, "broken", { enabled: false })).toEqual({ enabled: false });
  });

  it("round-trips JSON values and reports successful persistence", () => {
    const storage = createStorage();

    expect(saveStoredValue(storage, "notes", { match: "观察" })).toBe(true);
    expect(loadStoredValue(storage, "notes", {})).toEqual({ match: "观察" });
  });

  it("reports persistence failure without throwing", () => {
    const storage = createStorage();
    storage.setItem = () => {
      throw new Error("quota exceeded");
    };

    expect(saveStoredValue(storage, "notes", { match: "观察" })).toBe(false);
  });
});

describe("automation view model", () => {
  it("opens compensation at 12:02 Beijing time", () => {
    expect(isAutomationCompensationAvailable(new Date("2026-07-14T04:01:59.000Z"))).toBe(false);
    expect(isAutomationCompensationAvailable(new Date("2026-07-14T04:02:00.000Z"))).toBe(true);
  });

  it("calculates the previous Beijing date across a year boundary", () => {
    expect(previousBeijingDateKey(new Date("2025-12-31T16:30:00.000Z"))).toBe("20251231");
  });

  it("summarizes completed, running, and failed tasks", () => {
    expect(automationStatusText([task()])).toContain("1/1");
    expect(automationStatusText([task({ status: "running" })])).toContain("1");
    expect(automationStatusText([
      task({
        status: "failed",
        lastError: "provider unavailable",
      }),
    ])).toContain("provider unavailable");
  });
});
