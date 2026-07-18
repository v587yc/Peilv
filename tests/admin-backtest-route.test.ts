import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const calls = vi.hoisted(() => ({ runtimePost: [] as unknown[][] }));
const services = vi.hoisted(() => ({
  analyzeMatch: vi.fn(),
  verifyBacktestPredictions: vi.fn(),
  learnBacktestPatterns: vi.fn(),
}));

vi.mock("@/lib/auth/admin-capabilities", () => ({
  requireAdminCapability: () => ({
    ok: true,
    principal: { actorId: "admin-1", actorType: "admin", capabilities: ["admin:execute"] },
  }),
}));
vi.mock("@/adapters/backtest-analysis", () => ({ backtestAnalysisServices: services }));
vi.mock("@/features/backtest/runtime", () => ({
  DELETE: vi.fn(),
  POST: vi.fn(async (...args: unknown[]) => {
    calls.runtimePost.push(args);
    return NextResponse.json({ success: true, jobId: "job-1" });
  }),
}));
vi.mock("@/features/management/route-command", () => ({
  CommandRateLimitError: class extends Error {},
  runRouteCommand: async (request: Request, _principal: unknown, _action: string, execute: (payload: Record<string, unknown>, targetId: string) => Promise<unknown>) => {
    const command = await request.json() as { payload: Record<string, unknown>; targetId: string };
    const result = await execute(command.payload, command.targetId);
    return NextResponse.json({ success: true, result });
  },
}));
vi.mock("@/features/management/commands", () => ({ CommandConflictError: class extends Error {} }));

import { POST } from "@/app/api/admin/backtests/route";

describe("admin backtest route adapter", () => {
  it("calls the stable backtest service with injected analysis services", async () => {
    calls.runtimePost.length = 0;
    const response = await POST(new NextRequest("http://local/api/admin/backtests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetId: "backtest.start",
        payload: { startDate: "20260101", endDate: "20260101", maxMatches: 1 },
      }),
    }));

    expect(response.status).toBe(200);
    expect(calls.runtimePost).toHaveLength(1);
    expect(calls.runtimePost[0]?.[0]).toBeInstanceOf(NextRequest);
    expect(calls.runtimePost[0]?.[1]).toBe(services);
  });
});
