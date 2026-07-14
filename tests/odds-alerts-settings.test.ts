import { describe, expect, it, vi } from "vitest";
import {
  createOddsAlerts,
  shouldPlayThresholdAlert,
  type AlertConfig,
  type OddsSnapshot,
} from "@/features/odds/alerts";
import { loadBrowserPreference, saveBrowserPreference } from "@/features/odds/browser-preferences";

const config: AlertConfig = {
  matchId: "m1",
  handicapUp: "0.25", handicapDown: "0.25",
  totalLineUp: "0.5", totalLineDown: "0.5",
  homeOddsUp: "0.10", homeOddsDown: "0.10",
  awayOddsUp: "0.10", awayOddsDown: "0.10",
  overOddsUp: "0.10", overOddsDown: "0.10",
  underOddsUp: "0.10", underOddsDown: "0.10",
};
const snapshot: OddsSnapshot = { handicapRaw: 0, totalLineRaw: 2.5, homeOdds: "0.90", awayOdds: "0.90", overOdds: "0.90", underOdds: "0.90" };

describe("odds alerts and browser preferences", () => {
  it("creates stable threshold alerts and deduplicates an unchanged observation", () => {
    const seen = new Set<string>();
    const input = {
      configs: new Map([["m1", config]]), snapshots: new Map([["m1", snapshot]]),
      matches: [{ id: "m1", homeTeam: "主队", awayTeam: "客队", handicapRaw: 0.25, totalLineRaw: 2.5, homeOdds: "1.00", awayOdds: "0.90", overOdds: "0.90", underOdds: "0.90" }],
      now: 1234, seen,
    };
    const first = createOddsAlerts(input);
    const second = createOddsAlerts(input);
    expect(first.map(item => item.message)).toEqual(["主队 vs 客队 让球 升了 0.25", "主队 vs 客队 主队赔率 升了 0.10"]);
    expect(first[0]?.id).toBe("m1-让球-up-1234");
    expect(second).toEqual([]);
  });

  it("keeps threshold crossing semantics monotonic", () => {
    expect(shouldPlayThresholdAlert(1.1, 1, 0.9)).toBe(true);
    expect(shouldPlayThresholdAlert(1.1, 1, 1.1)).toBe(false);
    expect(shouldPlayThresholdAlert(0.8, 1, 1.1)).toBe(false);
  });

  it("falls back on malformed reads and reports storage write failures", () => {
    const storage = {
      getItem: vi.fn(() => "bad-json"),
      setItem: vi.fn(() => { throw new Error("quota"); }),
    } as unknown as Storage;
    expect(loadBrowserPreference(storage, "sound", true)).toBe(true);
    expect(saveBrowserPreference(storage, "sound", false)).toEqual({ success: false, error: "quota" });
  });
});
