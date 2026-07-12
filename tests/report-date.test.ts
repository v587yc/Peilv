import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inValues: vi.fn(),
}));

vi.mock("@/storage/database/supabase-client", () => ({
  getSupabaseClient: () => {
    const query: Record<string, unknown> = {};
    query.select = vi.fn(() => query);
    query.in = vi.fn((column: string, values: unknown[]) => {
      mocks.inValues(column, values);
      return query;
    });
    query.order = vi.fn(() => query);
    query.limit = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    return { from: vi.fn(() => query) };
  },
}));

import { GET } from "@/app/api/report/route";

describe("report date handling", () => {
  beforeEach(() => {
    mocks.inValues.mockClear();
  });

  it("queries compact and legacy date keys for a dashed date", async () => {
    const response = await GET(new Request("https://app.invalid/api/report?date=2026-07-10"));

    expect(response.status).toBe(200);
    expect(mocks.inValues).toHaveBeenCalledWith("report_date", ["20260710", "2026-07-10"]);
  });

  it("keeps compact dates stable", async () => {
    await GET(new Request("https://app.invalid/api/report?date=20260710"));

    expect(mocks.inValues).toHaveBeenCalledWith("report_date", ["20260710", "2026-07-10"]);
  });
});
