import { afterEach, describe, expect, it, vi } from "vitest";
import { automationHandlers } from "@/lib/automation/handlers";
import type { StepExecutionContext } from "@/lib/automation/types";

function context(matches: Array<{ id: string; state: string }>): StepExecutionContext {
  return {
    task: { id: "task-1", dateKey: "20260711" },
    step: {},
    outputs: { "discover-matches": { matches } },
    baseUrl: "http://localhost:5000",
  } as unknown as StepExecutionContext;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("automation odds persistence", () => {
  it("passes source freshness metadata through the guarded odds POST", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "Test_Internal_Secret_0123456789AB");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/api/data/odds-db?")) {
        return jsonResponse({ data: { oddsMap: {} } });
      }
      if (url.includes("/api/data/match/match-1")) {
        return jsonResponse({
          success: true,
          source: "titan-analysis-odds",
          sourceObservedAt: "2026-07-11T10:00:00.000Z",
          data: { matchId: "match-1", companies: [{ companyId: "3" }] },
        });
      }
      return jsonResponse({ success: true, applied: true });
    }));

    await automationHandlers["odds-fetch"]["fetch-odds"](context([
      { id: "match-1", state: "0" },
    ]));

    const post = requests.find(request => request.init?.method === "POST");
    expect(post?.url).toBe("http://localhost:5000/api/data/odds-db");
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      matchId: "match-1",
      source: "titan-analysis-odds",
      sourceObservedAt: "2026-07-11T10:00:00.000Z",
      writeToken: "automation:task-1:match-1:2026-07-11T10:00:00.000Z",
    });
  });

  it("does not PATCH a Crown snapshot before base odds exist", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: { oddsMap: {}, crown12OddsMap: {} },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await automationHandlers["crown-snapshot"]["snapshot-crown"](context([
      { id: "match-1", state: "0" },
    ])) as { missingBase: number; saved: number };

    expect(result).toMatchObject({ missingBase: 1, saved: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("saves a Crown snapshot when only total odds are available", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "Test_Internal_Secret_0123456789AB");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/api/data/odds-db?")) {
        return jsonResponse({
          data: {
            oddsMap: { "match-1": { companies: [{ companyId: "3" }] } },
            crown12OddsMap: {},
          },
        });
      }
      if (url.includes("/opentimes?")) {
        return jsonResponse({
          success: true,
          crownOpen: { totalOver: "0.91", totalLine: "2.5", totalUnder: "0.95" },
          crownTerminal: { totalOver: "0.89", totalLine: "2.5", totalUnder: "0.97" },
          crownStatus: { handicap: "unavailable", total: "available" },
        });
      }
      return jsonResponse({ success: true, applied: true });
    }));

    const result = await automationHandlers["crown-snapshot"]["snapshot-crown"](context([
      { id: "match-1", state: "0" },
    ])) as { saved: number; partial: number; unavailable: number };

    expect(result).toMatchObject({ saved: 1, partial: 1, unavailable: 0 });
    const patch = requests.find(request => request.init?.method === "PATCH");
    expect(JSON.parse(String(patch?.init?.body))).toMatchObject({
      crown12Odds: { totalLine: "2.5" },
      crownLiveOdds: { totalLine: "2.5" },
    });
  });

  it("skips a Crown snapshot when both markets are explicitly unavailable", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/data/odds-db?")) {
        return jsonResponse({
          data: {
            oddsMap: { "match-1": { companies: [{ companyId: "3" }] } },
            crown12OddsMap: {},
          },
        });
      }
      return jsonResponse({
        success: true,
        crownStatus: { handicap: "unavailable", total: "unavailable" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await automationHandlers["crown-snapshot"]["snapshot-crown"](context([
      { id: "match-1", state: "0" },
    ])) as { saved: number; unavailable: number };

    expect(result).toMatchObject({ saved: 0, unavailable: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty Crown snapshot without explicit market status", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/data/odds-db?")) {
        return jsonResponse({
          data: {
            oddsMap: { "match-1": { companies: [{ companyId: "3" }] } },
            crown12OddsMap: {},
          },
        });
      }
      return jsonResponse({ success: true });
    }));

    await expect(automationHandlers["crown-snapshot"]["snapshot-crown"](context([
      { id: "match-1", state: "0" },
    ]))).rejects.toThrow("皇冠快照响应不完整");
  });
});
