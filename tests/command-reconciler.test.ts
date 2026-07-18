import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  transition: vi.fn(),
  succeed: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/storage/database/supabase-client", () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({ in: () => ({ order: () => ({ limit: async () => ({ data: mocks.rows, error: null }) }) }) }),
    }),
  }),
}));
vi.mock("@/features/management/command-repository", () => ({
  createSupabaseCommandRepository: () => ({ transition: mocks.transition, succeed: mocks.succeed }),
}));
vi.mock("@/lib/audit-log", () => ({ writeAuditLog: mocks.audit }));

import { reconcilePendingCommandAudits } from "@/features/management/command-reconciler";

describe("management command receipt recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transition.mockResolvedValue(undefined);
    mocks.succeed.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(true);
  });

  it("recovers settings, strategy, automation, backtest and deployment effects without replaying providers", async () => {
    const targets = ["setting.llm_model", "strategy.publish", "automation.daily-compensation", "backtest.start", "deployment.deploy"];
    mocks.rows = targets.map((targetId, index) => ({
      action: `command.${index}`,
      idempotency_key: `key-${index}`,
      status: "effect_started",
      result_reference: { providerCalls: 0, targetId },
      actor_id: "admin-1",
      request_id: `request-${index}`,
      audit_context: { targetId, reason: "recover", effectSucceeded: true },
    }));
    expect(await reconcilePendingCommandAudits()).toEqual({ scanned: 5, completed: 5 });
    expect(mocks.transition).toHaveBeenCalledTimes(10);
    expect(mocks.audit).toHaveBeenCalledTimes(5);
    expect(mocks.succeed).toHaveBeenCalledTimes(5);
    expect(mocks.audit.mock.calls.map(([entry]) => entry.objectId)).toEqual(targets);
    expect(mocks.audit.mock.calls.map(([entry]) => entry.objectType)).toEqual(["settings", "strategy", "automation", "backtest", "deployment"]);
  });
});
