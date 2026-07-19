import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automationHandlers } from "@/lib/automation/handlers";
import type { AutomationTask, AutomationTaskStep, StepExecutionContext } from "@/lib/automation/types";

const originalSecret = process.env.INTERNAL_API_SECRET;

function context(): StepExecutionContext {
  const task: AutomationTask = {
    id: "task-t30",
    taskType: "match-t30-analysis",
    dateKey: "20260711",
    matchId: "match-1",
    source: "production",
    idempotencyKey: "automation:production:match-t30-analysis:match-1",
    status: "running",
    currentStep: "reanalyze-match",
    attemptCount: 1,
    maxAttempts: 3,
    lockOwner: "worker",
    lockExpiresAt: null,
    payload: { scheduleMode: "future" },
    result: null,
    lastError: null,
    scheduledAt: "2026-07-11T04:30:00.000Z",
    startedAt: null,
    completedAt: null,
    createdAt: "2026-07-11T04:00:00.000Z",
    updatedAt: "2026-07-11T04:00:00.000Z",
  };
  const step: AutomationTaskStep = {
    id: 1,
    taskId: task.id,
    stepKey: "reanalyze-match",
    ordinal: 1,
    idempotencyKey: `${task.idempotencyKey}:reanalyze-match`,
    status: "running",
    attemptCount: 1,
    maxAttempts: 3,
    input: {},
    output: null,
    lastError: null,
    startedAt: null,
    completedAt: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
  return { task, step, outputs: {}, baseUrl: "https://app.invalid" };
}

beforeEach(() => {
  process.env.INTERNAL_API_SECRET = "Test_Internal_Secret_0123456789AB";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-11T04:31:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalSecret === undefined) delete process.env.INTERNAL_API_SECRET;
  else process.env.INTERNAL_API_SECRET = originalSecret;
});

describe("match T-30 analysis handler", () => {
  it("refreshes odds and overwrites the existing analysis request", async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url, method, body });

      if (url.includes("/api/schedule")) {
        return new Response(JSON.stringify({ success: true, data: { matches: [
          { id: "match-1", league: "测试联赛", time: "11日13:00", state: "0", homeTeam: "主队", awayTeam: "客队", matchDate: "20260711" },
        ] } }));
      }
      if (url.includes("/api/data/match/match-1")) {
        return new Response(JSON.stringify({
          success: true,
          source: "test-source",
          sourceObservedAt: "2026-07-11T04:31:00.000Z",
          data: { matchId: "match-1", companies: [{ companyId: "3", companyName: "Crown", ftHandicapLine: "0.5" }] },
        }));
      }
      if (url.includes("/api/data/odds-db") && method === "GET") {
        return new Response(JSON.stringify({ data: {
          oddsMap: { "match-1": { matchId: "match-1", companies: [{ companyId: "3", companyName: "Crown", ftHandicapLine: "0.5" }] } },
          crown12OddsMap: { "match-1": { handicapHome: "0.90", handicapLine: "0.5", handicapAway: "0.96" } },
        } }));
      }
      return new Response(JSON.stringify({ success: true }));
    }));

    const result = await automationHandlers["match-t30-analysis"]["reanalyze-match"](context());
    expect(result).toMatchObject({ analyzed: true, matchId: "match-1" });

    const analysisRequest = requests.find((request) => request.url.endsWith("/api/analysis") && request.method === "POST");
    expect(analysisRequest?.body).toMatchObject({
      matchId: "match-1",
      matchDate: "20260711",
      scheduleMode: "future",
      analysisTrigger: "match-t30",
    });
    expect(requests.some((request) => request.url.includes("/api/data/match/match-1"))).toBe(true);
  });

  it("skips after kickoff without refreshing odds or calling AI", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/schedule")) {
        return new Response(JSON.stringify({ success: true, data: { matches: [
          { id: "match-1", league: "测试联赛", time: "11日13:00", state: "1", homeTeam: "主队", awayTeam: "客队", matchDate: "20260711" },
        ] } }));
      }
      return new Response(JSON.stringify({ success: true }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await automationHandlers["match-t30-analysis"]["reanalyze-match"](context());
    expect(result).toMatchObject({ skipped: true, reason: "match-started-or-unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("verification report handler", () => {
  it("refreshes history before settling predictions", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/api/schedule")) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            ingestion: {
              status: "ok",
              source: { kind: "titan_history", fresh: true },
              parser: { parsedRows: 300 },
              persistence: { persistedResults: 280 },
            },
          },
        }));
      }
      return new Response(JSON.stringify({ success: true, verified: 10 }));
    }));

    const result = await automationHandlers["verify-learn-report"].verify(context());

    expect(requests).toEqual([
      "https://app.invalid/api/schedule?date=20260711&mode=history",
      "https://app.invalid/api/analysis/verify?startDate=20260711&endDate=20260711",
    ]);
    expect(result).toMatchObject({
      scheduleIngestion: {
        status: "ok",
        sourceKind: "titan_history",
        fresh: true,
        parsedMatches: 300,
        persistedResults: 280,
      },
      verification: { success: true, verified: 10 },
    });
  });

  it("allows labeled cached evidence only when finished results exist", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/api/schedule")) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            ingestion: {
              status: "fallback_cached_results",
              source: { kind: "persisted_match_results", fresh: false, coverage: "unknown" },
              cached: { finishedResultCount: 12 },
            },
          },
        }));
      }
      return new Response(JSON.stringify({ success: true, verified: 12 }));
    }));

    const result = await automationHandlers["verify-learn-report"].verify(context());
    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({
      scheduleIngestion: {
        status: "fallback_cached_results",
        sourceKind: "persisted_match_results",
        fresh: false,
        coverage: "unknown",
        cachedFinishedResults: 12,
      },
    });
  });

  it("stops before verification when ingestion status is missing or unusable", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(automationHandlers["verify-learn-report"].verify(context())).rejects.toThrow("missing-ingestion-status");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops when cached fallback has no finished results", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        ingestion: {
          status: "fallback_cached_results",
          source: { kind: "persisted_match_results", fresh: false },
          cached: { finishedResultCount: 0 },
        },
      },
    })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(automationHandlers["verify-learn-report"].verify(context())).rejects.toThrow("fallback_cached_results");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
