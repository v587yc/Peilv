import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  upserts: [] as Record<string, unknown>[],
  count: 0,
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
      return Promise.resolve({ error: null, count: db.count }).then(onfulfilled, onrejected);
    }
  }
  return { getSupabaseClient: () => ({
    from: () => new Query(),
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "persist_claimed_backtest_job") {
        db.upserts.push(args.p_job as Record<string, unknown>);
        return { data: true, error: null };
      }
      if (name === "heartbeat_backtest_job" || name === "fail_claimed_backtest_job") return { data: true, error: null };
      return db.count >= 2
        ? { data: { claimed: false, reason: "limit" }, error: null }
        : { data: { claimed: true }, error: null };
    }),
  }) };
});

import { DELETE, GET, POST } from "@/features/backtest/runtime";
import { backtestAnalysisServices } from "@/adapters/backtest-analysis";

const post = (request: NextRequest) => POST(request, backtestAnalysisServices);

describe("backtest job API", () => {
  beforeEach(() => {
    db.upserts = [];
    db.row = null;
    db.count = 0;
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
    const response = await post(new NextRequest("http://local/api/backtest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeJobId: "resume-job" }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ success: true, jobId: "resume-job", resumed: true, remainingDates: 2 });
    expect(db.upserts.some(row => row.id === "resume-job" && row.status === "running" && (row.log as string[]).includes("interrupted") && (row.result as {config?:unknown}).config)).toBe(true);
  });
  it("returns 409 when continuing the same running job",async()=>{db.row={id:"running-job",status:"running",current_step:"analyzing",start_date:"20260101",end_date:"20260101",current_date:"20260101",log:["existing"],result:{config:{maxMatches:5}}};const response=await post(new NextRequest("http://local/api/backtest",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({resumeJobId:"running-job"})}));expect(response.status).toBe(409);expect(db.upserts).toHaveLength(0);});
  it("returns 429 when the database atomically refuses an active slot",async()=>{db.count=2;const response=await post(new NextRequest("http://local/api/backtest",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({startDate:"20260101",endDate:"20260101",maxMatches:1})}));expect(response.status).toBe(429);expect(db.upserts).toHaveLength(0);});
  it("keeps the job identity, existing log, and accumulated result when cancelling a persisted job",async()=>{db.row={id:"cancel-job",status:"running",current_step:"analyzing",start_date:"20260101",end_date:"20260103",current_date:"20260102",processed_dates:1,total_dates:3,log:["already processed 20260101"],result:{summary:{matches:4}},started_at:"2026-01-01"};const response=await DELETE(new NextRequest("http://local/api/backtest?id=cancel-job",{method:"DELETE"}));const payload=await response.json();expect(payload.job).toMatchObject({id:"cancel-job",status:"error",log:["already processed 20260101",expect.stringContaining("无法取消")],result:{summary:{matches:4}}});expect(db.upserts.at(-1)).toMatchObject({id:"cancel-job",result:{summary:{matches:4}}});});

  it("rejects invalid input before creating a persisted job", async () => {
    const response = await post(new NextRequest("http://local/api/backtest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startDate: "20260230", endDate: "20260301", maxMatches: 1 }),
    }));
    expect(response.status).toBe(400);
    expect(db.upserts).toHaveLength(0);
  });
});
