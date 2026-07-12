import { describe, expect, it } from "vitest";
import { parseTitanLiveResults, parseTitanSchedule } from "@/lib/titan-schedule";

function page(rows: string, title = "2026年07月10日完场比分、赛程赛果") {
  return Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><script>importantSclass=",41,";</script><table id="table_live">${rows}</table></body></html>`);
}

function row(attributes = "sId='123' name='41,0'", cells?: string[]) {
  const values = cells || [
    "<td bgcolor='#123456'>测试联赛</td>",
    "<td>10日12:00</td>",
    "<td>完</td>",
    "<td>主队[1]</td>",
    "<td>2 - 1</td>",
    "<td>客队[2]</td>",
    "<td>1-0</td>",
    "<td val='-0.5'></td>",
    "<td val='2.5'></td>",
  ];
  return `<tr ${attributes}>${values.join("")}</tr>`;
}

function liveRow(overrides: Record<number, string> = {}) {
  const fields = Array.from({ length: 63 }, () => "");
  Object.assign(fields, {
    0: "456",
    1: "#123456",
    2: "测试联赛",
    5: "主队",
    8: "客队",
    11: "12:00",
    12: "2026,6,11,12,0,0",
    13: "-1",
    14: "3",
    15: "2",
    16: "1",
    17: "1",
    22: "联赛1",
    23: "联赛2",
    45: "41",
    62: "1",
    ...overrides,
  });
  return `A[0]="${fields.join("^")}";`;
}

describe("Titan schedule parser", () => {
  it("parses rows regardless of attribute order and preserves real scores", () => {
    const result = parseTitanSchedule(page(row()), "text/html; charset=utf-8", "20260710");
    expect(result.status).toBe("ok");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      id: "123",
      state: "-1",
      homeScore: "2",
      awayScore: "1",
      halfHomeScore: "1",
      halfAwayScore: "0",
      handicapRaw: -0.5,
      totalLineRaw: 2.5,
      isHot: true,
    });
    expect(result.diagnostics).toMatchObject({ candidateRows: 1, parsedRows: 1, malformedRows: 0 });
  });

  it("rejects the generic 200 landing page as wrong content", () => {
    const body = Buffer.from("<html><title>球探比分</title><body>球探网首页 | 足球比分</body></html>");
    const result = parseTitanSchedule(body, "text/html; charset=utf-8", "20260711");
    expect(result.status).toBe("wrong_page");
    expect(result.diagnostics).toMatchObject({ dateMatched: false, scheduleContainer: false, candidateRows: 0 });
  });

  it("accepts zero matches only with an explicit marker inside the schedule table", () => {
    const result = parseTitanSchedule(page("<tr><td>暂无赛事</td></tr>"), "text/html; charset=utf-8", "20260710");
    expect(result.status).toBe("valid_empty");
    expect(result.diagnostics.explicitEmptyMarker).toBe(true);
  });

  it("rejects a header-only table as layout drift", () => {
    const result = parseTitanSchedule(page("<tr><td>联赛</td><td>时间</td></tr>"), "text/html; charset=utf-8", "20260710");
    expect(result.status).toBe("layout_drift");
    expect(result.diagnostics.explicitEmptyMarker).toBe(false);
  });

  it("reports malformed candidate rows instead of silently returning empty", () => {
    const result = parseTitanSchedule(page(row("name='41,0' sId='bad'")), "text/html; charset=utf-8", "20260710");
    expect(result.status).toBe("layout_drift");
    expect(result.diagnostics).toMatchObject({
      candidateRows: 1,
      parsedRows: 0,
      malformedRows: 1,
      malformedReasons: { invalid_match_id: 1 },
    });
  });

  it("does not turn special score text or missing lines into zero", () => {
    const cells = [
      "<td>测试联赛</td>", "<td>10日12:00</td>", "<td>取消</td>", "<td>主队</td>",
      "<td>取消</td>", "<td>客队</td>", "<td></td>", "<td></td>", "<td></td>",
    ];
    const result = parseTitanSchedule(page(row("name='41,0' sId='123'", cells)), "text/html; charset=utf-8", "20260710");
    expect(result.matches[0]).toMatchObject({
      state: "取消",
      homeScore: "",
      awayScore: "",
      handicapRaw: null,
      totalLineRaw: null,
    });
  });
});

describe("Titan live result fallback parser", () => {
  it("filters by the embedded match date and extracts documented score fields", () => {
    const result = parseTitanLiveResults(`${liveRow()}\n${liveRow({ 0: "789", 12: "2026,6,12,12,0,0" })}`, "20260711");
    expect(result.status).toBe("ok");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      id: "456",
      state: "-1",
      homeScore: "3",
      awayScore: "2",
      halfHomeScore: "1",
      halfAwayScore: "1",
      matchDate: "20260711",
    });
  });

  it("rejects a finished row without two integer scores", () => {
    const result = parseTitanLiveResults(liveRow({ 15: "" }), "20260711");
    expect(result.status).toBe("layout_drift");
    expect(result.diagnostics.malformedReasons).toEqual({ invalid_finished_score: 1 });
  });
});
