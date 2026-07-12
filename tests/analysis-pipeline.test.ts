import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  verify: vi.fn(),
  learn: vi.fn(),
}));

vi.mock("@/app/api/analysis/route", () => ({ POST: routeMocks.analyze }));
vi.mock("@/app/api/analysis/verify/route", () => ({ GET: routeMocks.verify }));
vi.mock("@/app/api/analysis/learn/route", () => ({ POST: routeMocks.learn }));

import {
  analyzeMatch,
  learnBacktestPatterns,
  verifyBacktestPredictions,
} from "@/lib/services/analysis-pipeline";

describe("in-process analysis pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_API_SECRET = "test-secret";
    routeMocks.analyze.mockResolvedValue(Response.json({ success: true, data: { matchId: "1" } }));
    routeMocks.verify.mockResolvedValue(Response.json({ success: true, verified: 2 }));
    routeMocks.learn.mockImplementation(async () => Response.json({ success: true, patternsFound: 1 }));
  });

  it("calls analysis directly without an HTTP fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(analyzeMatch({ matchId: "1" })).resolves.toMatchObject({ success: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    const request = routeMocks.analyze.mock.calls[0][0] as Request;
    expect(request.headers.get("x-internal-api-secret")).toBe("test-secret");
    expect(await request.json()).toEqual({ matchId: "1" });
    fetchSpy.mockRestore();
  });

  it("keeps verification and learning on backtest-isolated sources", async () => {
    await verifyBacktestPredictions("20260101", "20260102");
    await learnBacktestPatterns("run-1", "20260101", "20260102");

    const verifyRequest = routeMocks.verify.mock.calls[0][0] as Request;
    expect(new URL(verifyRequest.url).searchParams.get("source")).toBe("backtest");
    expect(routeMocks.learn).toHaveBeenCalledTimes(2);
    const learnBodies = await Promise.all(routeMocks.learn.mock.calls.map(async ([request]) => (request as Request).json()));
    expect(learnBodies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        market: "handicap",
        source: "backtest",
        runId: "run-1",
        trainingWindowStart: "20260101",
        trainingWindowEnd: "20260102",
      }),
      expect.objectContaining({
        market: "total",
        source: "backtest",
        runId: "run-1",
        trainingWindowStart: "20260101",
        trainingWindowEnd: "20260102",
      }),
    ]));
  });

  it("turns non-success route responses into service errors", async () => {
    routeMocks.verify.mockResolvedValue(Response.json({ error: "failed" }, { status: 503 }));
    await expect(verifyBacktestPredictions("20260101", "20260102")).rejects.toThrow("failed");
  });
});
