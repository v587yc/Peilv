import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  upserts: [] as Record<string, unknown>[],
}));

vi.mock("@/app/api/backtest/_analysis-pipeline", () => ({
  analyzeMatch: vi.fn(),
  verifyBacktestPredictions: vi.fn(),
  learnBacktestPatterns: vi.fn(),
}));

vi.mock("@/storage/database/supabase-client", () => {
  class Query implements PromiseLike<{ data?: unknown; error: null; count?: number }> {
    select() { return this; }
    eq() { return this; }
    in() { return this; }
    upsert(value: Record<string, unknown>) {
      db.upserts.push(value);
      return this;
    }
    async maybeSingle() { return { data: db.row, error: null }; }
    then<TResult1 = { data?: unknown; error: null; count?: number }, TResult2 = never>(
      onfulfilled?: ((value: { data?: unknown; error: null; count?: number }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve({ error: null, count: 0 }).then(onfulfilled, onrejected);
    }
  }
  return { getSupabaseClient: () => ({ from: () => new Query() }) };
});

import { GET, POST } from "@/app/api/backtest/route";

describe("backtest job API", () => {
  beforeEach(() => {
    db.upserts = [];
    db.row = null;
  });

  it("explicitly marks a persisted running job failed after process restart", async () => {
    db.row = {
      id: "old-job",
      status: "running",
      current_step: "analyzing",
      start_date: "20260101",
      end_date: "20260101",
      current_date: "20260101",
      log: [],
      started_at: "2026-01-01T00:00:00.000Z",
    };
    const response = await GET(new NextRequest("http://local/api/backtest?id=old-job"));
    const payload = await response.json();

    expect(payload.job.status).toBe("error");
    expect(payload.job.currentStep).toBe("interrupted");
    expect(payload.job.lastError).toContain("未在后台继续执行");
    expect(db.upserts.at(-1)).toMatchObject({ status: "error", current_step: "interrupted" });
  });

  it("resumes an interrupted persisted job from the next unfinished date", async () => {
    db.row = {
      id: "resume-job",
      status: "error",
      current_step: "interrupted",
      start_date: "20260101",
      end_date: "20260103",
      current_date: "20260101",
      total_dates: 3,
      processed_dates: 1,
      total_matches: 2,
      analyzed_matches: 1,
      verified_matches: 0,
      correct_matches: 0,
      accuracy: "0%",
      log: ["interrupted"],
      result: { config: { maxMatches: 5, timeoutMs: 120000 } },
      started_at: "2026-01-01T00:00:00.000Z",
      ended_at: "2026-01-01T00:01:00.000Z",
    };
    const response = await POST(new NextRequest("http://local/api/backtest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeJobId: "resume-job" }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ success: true, jobId: "resume-job", resumed: true, remainingDates: 2 });
    expect(db.upserts.some(row => row.id === "resume-job" && row.status === "running")).toBe(true);
  });

  it("rejects invalid input before creating a persisted job", async () => {
    const response = await POST(new NextRequest("http://local/api/backtest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startDate: "20260230", endDate: "20260301", maxMatches: 1 }),
    }));
    expect(response.status).toBe(400);
    expect(db.upserts).toHaveLength(0);
  });
});
