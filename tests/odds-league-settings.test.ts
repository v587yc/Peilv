import { describe, expect, it, vi } from "vitest";
import {
  createDebouncedLeagueSelectionSaver,
  fetchFocusedLeagues,
  loadLeagueSelections,
  saveFocusedLeagues,
  shouldFetchIncrementalLeagues,
} from "@/features/odds/league-settings";

const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

describe("league settings boundary", () => {
  it("loads focused leagues and falls back to caller defaults", async () => {
    const defaults = ["英超", "西甲"];
    await expect(fetchFocusedLeagues(vi.fn(async () => response({ success: true, leagues: ["德甲"] })), defaults)).resolves.toEqual(["德甲"]);
    await expect(fetchFocusedLeagues(vi.fn(async () => response({ success: false })), defaults)).resolves.toEqual(defaults);
    await expect(fetchFocusedLeagues(vi.fn(async () => { throw new Error("offline"); }), defaults)).resolves.toEqual(defaults);
  });

  it("sorts focused leagues before saving", async () => {
    const fetcher = vi.fn(async () => response({ success: true }));
    await expect(saveFocusedLeagues(fetcher, new Set(["西甲", "英超"]))).resolves.toEqual(["英超", "西甲"]);
    expect(fetcher).toHaveBeenCalledWith("/api/user-focused-leagues", expect.objectContaining({ body: JSON.stringify({ leagues: ["英超", "西甲"] }) }));
  });

  it("loads date selection then DEFAULT fallback while preserving empty show-all", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ success: true, leagues: [] }))
      .mockResolvedValueOnce(response({ success: true, leagues: ["英超"] }));
    await expect(loadLeagueSelections(fetcher, "20260714", "today")).resolves.toEqual(new Set(["英超"]));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/league-selections?date=DEFAULT&mode=default");

    const empty = vi.fn(async () => response({ success: true, leagues: [] }));
    await expect(loadLeagueSelections(empty, "20260714", "today")).resolves.toEqual(new Set());
  });

  it("debounces saves for 800ms and suppresses empty/sentinel selections", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => response({ success: true }));
    const saver = createDebouncedLeagueSelectionSaver(fetcher, { delayMs: 800 });
    saver.schedule(new Set(["英超"]), "20260714", "today");
    saver.schedule(new Set(["西甲"]), "20260714", "today");
    await vi.advanceTimersByTimeAsync(799);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/league-selections", expect.objectContaining({ body: JSON.stringify({ dateKey: "20260714", mode: "today", leagues: ["西甲"] }) }));
    expect(saver.schedule(new Set(), "20260714", "today")).toBe(false);
    expect(saver.schedule(new Set(["__NONE__"]), "20260714", "today")).toBe(false);
    saver.dispose();
    vi.useRealTimers();
  });

  it("only requests incremental fetches for newly selected leagues", () => {
    expect(shouldFetchIncrementalLeagues(new Set(["英超"]), new Set(["英超", "西甲"]))).toEqual(new Set(["西甲"]));
    expect(shouldFetchIncrementalLeagues(new Set(["英超"]), new Set(["英超"]))).toEqual(new Set());
  });
});
