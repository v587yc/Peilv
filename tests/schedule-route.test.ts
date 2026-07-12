import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTitanUrl: vi.fn(),
  persistScheduleResults: vi.fn(),
  loadPersistedFinishedResultSummary: vi.fn(),
  getSupabaseClient: vi.fn(() => ({})),
}));

vi.mock("@/lib/titan-vip-fetch", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/titan-vip-fetch")>()),
  fetchTitanUrl: mocks.fetchTitanUrl,
}));
vi.mock("@/storage/database/supabase-client", () => ({ getSupabaseClient: mocks.getSupabaseClient }));
vi.mock("@/lib/verification/match-results", () => ({
  persistScheduleResults: mocks.persistScheduleResults,
  loadPersistedFinishedResultSummary: mocks.loadPersistedFinishedResultSummary,
}));

import { GET } from "@/app/api/schedule/route";

function upstream(body: string, contentType = "text/html; charset=utf-8") {
  return {
    requestedUrl: "https://bf.titan007.com/requested",
    finalUrl: "https://bf.titan007.com/final",
    statusCode: 200,
    headers: { "content-type": contentType },
    body: Buffer.from(body),
    attemptCount: 1,
    redirectCount: 0,
  };
}

function schedulePage(date: string, state = "完", score = "2-1") {
  const title = `${date.slice(0, 4)}年${date.slice(4, 6)}月${date.slice(6, 8)}日完场比分、赛程赛果`;
  return `<html><title>${title}</title><table id='table_live'><tr sId='123' name='41,0'><td>测试联赛</td><td>12:00</td><td>${state}</td><td>主队</td><td>${score}</td><td>客队</td><td>1-0</td></tr></table></html>`;
}

function liveData(date = "20260711") {
  const fields = Array.from({ length: 63 }, () => "");
  Object.assign(fields, {
    0: "456", 1: "#123456", 2: "测试联赛", 5: "主队", 8: "客队", 11: "12:00",
    12: `${date.slice(0, 4)},${Number(date.slice(4, 6)) - 1},${Number(date.slice(6, 8))},12,0,0`,
    13: "-1", 14: "3", 15: "2", 16: "1", 17: "1", 45: "41",
  });
  return `A[0]="${fields.join("^")}";`;
}

async function call(query: string) {
  return GET(new Request(`http://localhost/api/schedule?${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.persistScheduleResults.mockResolvedValue(1);
  mocks.loadPersistedFinishedResultSummary.mockResolvedValue({
    finishedResultCount: 0,
    sourceCounts: {},
    oldestObservedAt: null,
    newestObservedAt: null,
  });
});

describe("schedule route", () => {
  it("rejects invalid dates and modes before fetching", async () => {
    expect((await call("date=20260230&mode=history")).status).toBe(400);
    expect((await call("date=20260711&mode=typo")).status).toBe(400);
    expect(mocks.fetchTitanUrl).not.toHaveBeenCalled();
  });

  it("persists a validated Over page as the primary history source", async () => {
    mocks.fetchTitanUrl.mockResolvedValueOnce(upstream(schedulePage("20260710")));
    const response = await call("date=20260710&mode=history");
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.ingestion).toMatchObject({
      status: "ok",
      source: { kind: "titan_history", fresh: true },
      parser: { parsedRows: 1 },
      persistence: { persistedResults: 1 },
    });
    expect(mocks.fetchTitanUrl.mock.calls[0][0]).toContain("/football/Over_20260710.htm");
    expect(mocks.persistScheduleResults).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.objectContaining({ id: "123", homeScore: "2", awayScore: "1" })]),
      { scoreSource: "titan_schedule_history" },
    );
  });

  it("uses strict live finished scores when a recent Over page is a generic landing page", async () => {
    mocks.fetchTitanUrl
      .mockResolvedValueOnce(upstream("<html><title>球探比分</title><body>球探网首页</body></html>"))
      .mockResolvedValueOnce(upstream(liveData(), "text/javascript; charset=utf-8"));
    const response = await call("date=20260711&mode=history");
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.matches[0]).toMatchObject({ id: "456", state: "-1", homeScore: "3", awayScore: "2" });
    expect(json.data.ingestion).toMatchObject({
      status: "fallback_live_results",
      source: { kind: "titan_live_bfdata", fresh: true },
      primaryFailure: { status: "wrong_page" },
    });
    expect(mocks.persistScheduleResults).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { scoreSource: "titan_live_bfdata", finishedOnly: true },
    );
  });

  it("uses existing finished results only as labeled cached evidence", async () => {
    mocks.fetchTitanUrl
      .mockResolvedValueOnce(upstream("<html><title>球探比分</title></html>"))
      .mockResolvedValueOnce(upstream(liveData("20260712"), "text/javascript; charset=utf-8"));
    mocks.loadPersistedFinishedResultSummary.mockResolvedValueOnce({
      finishedResultCount: 12,
      sourceCounts: { titan_schedule_history: 12 },
      oldestObservedAt: "2026-07-11T01:00:00.000Z",
      newestObservedAt: "2026-07-11T02:00:00.000Z",
    });
    const response = await call("date=20260711&mode=history");
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.matches).toEqual([]);
    expect(json.data.ingestion).toMatchObject({
      status: "fallback_cached_results",
      source: { kind: "persisted_match_results", fresh: false, coverage: "unknown" },
      cached: { finishedResultCount: 12 },
    });
    expect(mocks.persistScheduleResults).not.toHaveBeenCalled();
  });

  it("returns 502 when primary, live, and cached result evidence are unavailable", async () => {
    mocks.fetchTitanUrl
      .mockResolvedValueOnce(upstream("<html><title>球探比分</title></html>"))
      .mockResolvedValueOnce(upstream(liveData("20260712"), "text/javascript; charset=utf-8"));
    const response = await call("date=20260711&mode=history");
    const json = await response.json();
    expect(response.status).toBe(502);
    expect(json).toMatchObject({ success: false, code: "SCHEDULE_CONTENT_INVALID" });
    expect(mocks.persistScheduleResults).not.toHaveBeenCalled();
  });

  it("fetches Next pages without persisting future schedules", async () => {
    mocks.fetchTitanUrl.mockResolvedValueOnce(upstream(schedulePage("20260712", "未", "")));
    const response = await call("date=20260712&mode=future");
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.ingestion.source.kind).toBe("titan_future");
    expect(mocks.fetchTitanUrl.mock.calls[0][0]).toContain("/football/Next_20260712.htm");
    expect(mocks.persistScheduleResults).not.toHaveBeenCalled();
  });

  it("reports persistence failures separately", async () => {
    mocks.fetchTitanUrl.mockResolvedValueOnce(upstream(schedulePage("20260710")));
    mocks.persistScheduleResults.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await call("date=20260710&mode=history");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, code: "SCHEDULE_PERSISTENCE_FAILURE" });
  });
});
