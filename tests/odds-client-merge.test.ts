import { describe, expect, it } from "vitest";
import { canApplyDatabaseOdds, mergeAiCompanyOdds } from "@/lib/odds-client-merge";

describe("canApplyDatabaseOdds", () => {
  it("rejects a database row when the match refreshed after the request began", () => {
    expect(canApplyDatabaseOdds(4, 5)).toBe(false);
  });

  it("rejects database rows while the refreshed odds are not persisted", () => {
    expect(canApplyDatabaseOdds(5, 5)).toBe(false);
  });

  it("rejects a request that began before persistence completed", () => {
    expect(canApplyDatabaseOdds(5, 4, 6)).toBe(false);
  });

  it("accepts requests begun after persistence and matches with no local refresh", () => {
    expect(canApplyDatabaseOdds(7, 4, 6)).toBe(true);
    expect(canApplyDatabaseOdds(5)).toBe(true);
  });
});

describe("mergeAiCompanyOdds", () => {
  it("keeps current live odds and supplements missing database fields", () => {
    const result = mergeAiCompanyOdds([
      {
        companyId: "3",
        companyName: "皇冠",
        openTime: "",
        ftHandicapHomeLive: "0.88",
        ftHandicapLineLive: "半球",
        ftHandicapAwayLive: "1.00",
        ftTotalOver: "0.91",
        ftTotalLine: "2.5",
        ftTotalUnder: "0.95",
        euroHome: "",
      },
    ], [
      {
        companyId: "3",
        companyName: "皇冠旧数据",
        openTime: "07-11 01:20",
        ftHandicapHomeLive: "0.84",
        ftHandicapLineLive: "平/半",
        ftHandicapAwayLive: "1.04",
        ftTotalOver: "0.80",
        ftTotalLine: "2/2.5",
        ftTotalUnder: "1.08",
        euroHome: "1.90",
        euroDraw: "3.20",
        euroAway: "4.10",
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      companyName: "皇冠",
      openTime: "07-11 01:20",
      asianHomeLive: "0.88",
      asianLineLive: "半球",
      asianAwayLive: "1.00",
      totalOverInit: "0.91",
      totalLineInit: "2.5",
      totalUnderInit: "0.95",
      euroHomeInit: "1.90",
      euroDrawInit: "3.20",
      euroAwayInit: "4.10",
    });
  });

  it("retains database-only companies after memory companies", () => {
    const result = mergeAiCompanyOdds(
      [{ companyId: "3", companyName: "皇冠", ftHandicapLineLive: "半球" }],
      [
        { companyId: "3", companyName: "皇冠旧数据", ftHandicapLineLive: "平/半" },
        { companyId: "35", companyName: "威廉", ftHandicapLine: "平手" },
      ],
    );

    expect(result.map(company => company.companyId)).toEqual(["3", "35"]);
    expect(result[0].asianLineLive).toBe("半球");
    expect(result[1].asianLineInit).toBe("平手");
  });

  it("uses database values when the memory field is blank", () => {
    const [result] = mergeAiCompanyOdds(
      [{ companyId: "3", companyName: "皇冠", openTime: "   ", ftHandicapHomeLive: "" }],
      [{ companyId: "3", companyName: "皇冠", openTime: "07-11 02:00", ftHandicapHomeLive: "0" }],
    );

    expect(result.openTime).toBe("07-11 02:00");
    expect(result.asianHomeLive).toBe("0");
  });
});
