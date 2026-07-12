import { describe, expect, it } from "vitest";
import { formatMatchScore, getMatchStatus, getMatchRowClass } from "../src/app/odds/_components/match-status";

describe("match status presentation mapping", () => {
  it.each([
    ["0", "scheduled", "未赛"],
    ["1", "live", "进行"],
    ["2", "halftime", "中场"],
    ["-1", "finished", "完场"],
    ["3", "unknown", "未知"],
    ["", "unknown", "未知"],
    [undefined, "unknown", "未知"],
    ["unexpected", "unknown", "未知"],
  ])("maps raw state %s without changing business semantics", (raw, kind, label) => {
    expect(getMatchStatus(raw)).toMatchObject({ kind, label, rawState: raw ?? "" });
  });

  it("returns stable semantic row classes", () => {
    expect(getMatchRowClass("0")).toBe("match-row--scheduled");
    expect(getMatchRowClass("1")).toBe("match-row--live");
    expect(getMatchRowClass("2")).toBe("match-row--halftime");
    expect(getMatchRowClass("-1")).toBe("match-row--finished");
    expect(getMatchRowClass("3")).toBe("match-row--unknown");
  });
});

describe("match score formatting", () => {
  it("formats only complete score pairs", () => {
    expect(formatMatchScore("2", "1")).toBe("2–1");
    expect(formatMatchScore("0", "0")).toBe("0–0");
    expect(formatMatchScore(" 3 ", " 2 ")).toBe("3–2");
  });

  it("does not infer partial or missing scores", () => {
    expect(formatMatchScore("2", "")).toBeNull();
    expect(formatMatchScore("", "1")).toBeNull();
    expect(formatMatchScore(undefined, undefined)).toBeNull();
  });
});
