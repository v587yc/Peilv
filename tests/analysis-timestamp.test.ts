import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  selected: "",
  row: {
    match_id: "match-1",
    match_date: "20260711",
    home_team: "Home",
    away_team: "Away",
    league: "英超",
    match_time: "12:00",
    analyzed_at: "2026-07-11T04:30:00.000Z",
  } as Record<string, unknown>,
}));

vi.mock("@/storage/database/supabase-client", () => {
  class Query implements PromiseLike<{ data: Record<string, unknown>[]; error: null }> {
    select(columns: string) { mocks.selected = columns; return this; }
    eq() { return this; }
    async single() { return { data: mocks.row, error: null }; }
    then<TResult1 = { data: Record<string, unknown>[]; error: null }, TResult2 = never>(
      onfulfilled?: ((value: { data: Record<string, unknown>[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve({ data: [mocks.row], error: null }).then(onfulfilled, onrejected);
    }
  }

  return { getSupabaseClient: () => ({ from: () => new Query() }) };
});

import { GET } from "@/app/api/analysis/route";

describe("analysis timestamps", () => {
  beforeEach(() => {
    mocks.selected = "";
  });

  it("returns analyzedAt in the date list", async () => {
    const response = await GET(new NextRequest("http://local/api/analysis?date=20260711"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.selected).toContain("analyzed_at");
    expect(payload.predictions["match-1"].analyzedAt).toBe("2026-07-11T04:30:00.000Z");
  });

  it("returns analyzedAt in match details", async () => {
    const response = await GET(new NextRequest("http://local/api/analysis?date=20260711&detail=1&matchId=match-1"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.selected).toContain("analyzed_at");
    expect(payload.prediction.analyzedAt).toBe("2026-07-11T04:30:00.000Z");
  });
});
