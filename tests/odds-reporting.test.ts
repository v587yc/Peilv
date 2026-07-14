import { describe, expect, it, vi } from "vitest";
import {
  buildOddsExportRows,
  exportOddsWorkbook,
  fetchReport,
  fetchReportDates,
  fetchReportTrend,
  parseStoredReport,
  type OddsExportMatch,
} from "@/features/odds/reporting";

const match: OddsExportMatch = {
  id: "m1",
  matchDate: "20260714",
  league: "英超",
  time: "20:00",
  state: "-1",
  homeTeam: "主队",
  awayTeam: "客队",
  homeScore: "2",
  awayScore: "1",
  halfHomeScore: "1",
  halfAwayScore: "0",
};

describe("odds reporting boundary", () => {
  it("decodes report dates, trend, and stored report through same-origin clients", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("trend")) return new Response(JSON.stringify({ success: true, trend: [{ date: "20260714", accuracy: 80 }] }));
      if (url.includes("date=")) return new Response(JSON.stringify({ success: true, data: { report_content: JSON.stringify({ date: "20260714", rows: [], summary: {} }) } }));
      return new Response(JSON.stringify({ success: true, dates: [{ report_date: "20260714" }] }));
    });

    await expect(fetchReportDates(fetcher)).resolves.toEqual(["20260714"]);
    await expect(fetchReportTrend(fetcher)).resolves.toEqual([{ date: "20260714", accuracy: 80 }]);
    await expect(fetchReport(fetcher, "20260714")).resolves.toMatchObject({ date: "20260714", rows: [] });
    expect(fetcher).toHaveBeenCalledWith("/api/report");
    expect(fetcher).toHaveBeenCalledWith("/api/report?trend=14");
    expect(fetcher).toHaveBeenCalledWith("/api/report?date=20260714");
  });

  it("rejects malformed and partial stored report payloads", () => {
    expect(() => parseStoredReport("not-json")).toThrow("加载AI报表失败");
    expect(() => parseStoredReport(JSON.stringify({ date: "20260714" }))).toThrow("加载AI报表失败");
  });

  it("preserves chronological company ordering and exact workbook column insertion order", () => {
    const rows = buildOddsExportRows({
      matches: [match],
      selectedLeagues: new Set(["英超"]),
      scheduleMode: "history",
      companyIds: new Set(["3", "4"]),
      companyOdds: new Map([["m1", [{
        companyId: "4", companyName: "威廉希尔", openTime: "10-1 09:00",
        euroHome: "2.10", euroDraw: "3.10", euroAway: "3.40",
        euroHomeLive: "2.15", euroDrawLive: "3.00", euroAwayLive: "3.35",
        ftHandicapHome: "0.91", ftHandicapLine: "平半", ftHandicapAway: "0.95",
        euroAsianHome: "0.92", euroAsianLine: "平半", euroAsianAway: "0.94",
        ftTotalOver: "0.89", ftTotalLine: "2.25", ftTotalUnder: "0.97",
        ftHandicapHomeLive: "", ftHandicapLineLive: "", ftHandicapAwayLive: "",
        ftTotalOverLive: "", ftTotalLineLive: "", ftTotalUnderLive: "",
      }, {
        companyId: "3", companyName: "皇冠", openTime: "9-30 10:00",
        euroHome: "2.00", euroDraw: "3.20", euroAway: "3.50",
        euroHomeLive: "2.05", euroDrawLive: "3.10", euroAwayLive: "3.45",
        ftHandicapHome: "0.90", ftHandicapLine: "半球", ftHandicapAway: "0.96",
        euroAsianHome: "0.91", euroAsianLine: "半球", euroAsianAway: "0.95",
        ftTotalOver: "0.88", ftTotalLine: "2.5", ftTotalUnder: "0.98",
        ftHandicapHomeLive: "0.86", ftHandicapLineLive: "半一", ftHandicapAwayLive: "1.00",
        ftTotalOverLive: "0.90", ftTotalLineLive: "2.75", ftTotalUnderLive: "0.94",
      }]]]),
      crownOpenOdds: new Map([["m1", { handicapHome: "0.89", handicapLine: "半球", handicapAway: "0.97", totalOver: "0.87", totalLine: "2.5", totalUnder: "0.99" }]]),
    });

    const expectedKeys = [
      "日期", "联赛", "时间", "状态", "比分", "半场", "主队", "客队",
      "终盘-亚盘主水", "终盘-亚盘盘口", "终盘-亚盘客水", "终盘-进球大水", "终盘-进球盘口", "终盘-进球小水",
      "新数据-亚盘主水", "新数据-亚盘盘口", "新数据-亚盘客水", "新数据-进球大水", "新数据-进球盘口", "新数据-进球小水",
      "开盘时间", "公司", "亚盘(初)主水", "亚盘(初)盘口", "亚盘(初)客水", "欧转亚盘(初)主水", "欧转亚盘(初)盘口", "欧转亚盘(初)客水",
      "进球数(初)大水", "进球数(初)盘口", "进球数(初)小水",
    ];
    expect(rows.map(row => Object.keys(row))).toEqual([expectedKeys, expectedKeys]);
    expect(rows).toEqual([
      {
        日期: "20260714", 联赛: "英超", 时间: "20:00", 状态: "完场", 比分: "2-1", 半场: "1-0", 主队: "主队", 客队: "客队",
        "终盘-亚盘主水": "0.86", "终盘-亚盘盘口": "半一", "终盘-亚盘客水": "1.00", "终盘-进球大水": "0.90", "终盘-进球盘口": "2.75", "终盘-进球小水": "0.94",
        "新数据-亚盘主水": "0.89", "新数据-亚盘盘口": "半球", "新数据-亚盘客水": "0.97", "新数据-进球大水": "0.87", "新数据-进球盘口": "2.5", "新数据-进球小水": "0.99",
        开盘时间: "9-30 10:00", 公司: "皇冠", "亚盘(初)主水": "0.90", "亚盘(初)盘口": "半球", "亚盘(初)客水": "0.96", "欧转亚盘(初)主水": "0.91", "欧转亚盘(初)盘口": "半球", "欧转亚盘(初)客水": "0.95",
        "进球数(初)大水": "0.88", "进球数(初)盘口": "2.5", "进球数(初)小水": "0.98",
      },
      {
        日期: "20260714", 联赛: "英超", 时间: "20:00", 状态: "完场", 比分: "2-1", 半场: "1-0", 主队: "主队", 客队: "客队",
        "终盘-亚盘主水": "0.86", "终盘-亚盘盘口": "半一", "终盘-亚盘客水": "1.00", "终盘-进球大水": "0.90", "终盘-进球盘口": "2.75", "终盘-进球小水": "0.94",
        "新数据-亚盘主水": "0.89", "新数据-亚盘盘口": "半球", "新数据-亚盘客水": "0.97", "新数据-进球大水": "0.87", "新数据-进球盘口": "2.5", "新数据-进球小水": "0.99",
        开盘时间: "10-1 09:00", 公司: "威廉希尔", "亚盘(初)主水": "0.91", "亚盘(初)盘口": "平半", "亚盘(初)客水": "0.95", "欧转亚盘(初)主水": "0.92", "欧转亚盘(初)盘口": "平半", "欧转亚盘(初)客水": "0.94",
        "进球数(初)大水": "0.89", "进球数(初)盘口": "2.25", "进球数(初)小水": "0.97",
      },
    ]);
  });

  it("orchestrates the same worksheet name and filename through an injected writer", () => {
    const write = vi.fn();
    exportOddsWorkbook([{ 联赛: "英超" }], "20260714", {
      write,
    });
    expect(write).toHaveBeenCalledWith({ rows: [{ 联赛: "英超" }], sheetName: "赔率数据", filename: "赔率数据_20260714.xlsx" });
  });
});
