import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import JSZip from "jszip";

const match = {
  id: "excel-match-1",
  league: "中超 & 青年<组>",
  leagueColor: "#123456",
  time: "20:00",
  homeTeam: "=SUM(1,1)中文主队",
  awayTeam: "客队<&>",
  homeRank: "1",
  awayRank: "2",
  state: "0",
  handicap: "半球",
  handicapRaw: 0.5,
  homeOdds: "0.90",
  awayOdds: "0.96",
  totalLine: "2.5",
  totalLineRaw: 2.5,
  overOdds: "0.88",
  underOdds: "0.98",
  initialHandicap: "半球",
  initialTotalLine: "2.5",
  sclassId: "1",
  matchDate: "20260719",
  orderIndex: 1,
  isHot: false,
};

const company = (companyId: string, companyName: string, openTime: string) => ({
  companyId, companyName, openTime,
  euroHome: "2.00", euroDraw: "3.20", euroAway: "3.50",
  euroHomeLive: "2.05", euroDrawLive: "3.10", euroAwayLive: "3.45",
  ftHandicapHome: "0.90", ftHandicapLine: "半球", ftHandicapAway: "0.96",
  euroAsianHome: "0.91", euroAsianLine: "半球", euroAsianAway: "0.95",
  ftTotalOver: "0.88", ftTotalLine: "2.5", ftTotalUnder: "0.98",
  ftHandicapHomeLive: "0.86", ftHandicapLineLive: "半球/一球", ftHandicapAwayLive: "1.00",
  ftTotalOverLive: "0.90", ftTotalLineLive: "2.75", ftTotalUnderLive: "0.94",
});

async function findExcelJsChunk(): Promise<string> {
  const chunksDirectory = join(process.cwd(), ".next", "static", "chunks");
  const entries = await readdir(chunksDirectory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const path = join(entry.parentPath, entry.name);
    const source = await readFile(path, "utf8");
    if (source.includes("ExcelJS")) return basename(path);
  }
  throw new Error("ExcelJS async chunk not found in production build");
}

test("固定数据导出真实OOXML并防止按钮双击", async ({ page }) => {
  const excelJsChunk = await findExcelJsChunk();
  const scriptRequests: string[] = [];
  const databaseRequests: Array<{ sequence: number; date: string | null; slim: string | null; generation: "initial" | "target" }> = [];
  let targetGenerationInstalled = false;
  let releaseTargetDatabaseResponse!: () => void;
  let observeTargetDatabaseRequest!: () => void;
  const targetDatabaseResponseGate = new Promise<void>(resolve => { releaseTargetDatabaseResponse = resolve; });
  const targetDatabaseRequestObserved = new Promise<void>(resolve => { observeTargetDatabaseRequest = resolve; });
  page.on("request", request => {
    if (request.resourceType() === "script") scriptRequests.push(new URL(request.url()).pathname);
  });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/odds") {
      await route.fulfill({ status: 200, json: { success: true, data: {
        matches: [match], leagues: [{ id: "1", name: match.league, color: "#123456", count: 1 }], hotMatchCount: 0, matchDate: "2026-07-19",
      } } });
      return;
    }
    if (url.pathname === "/api/data/odds-db") {
      const request = {
        sequence: databaseRequests.length + 1,
        date: url.searchParams.get("date"),
        slim: url.searchParams.get("slim"),
        generation: targetGenerationInstalled ? "target" as const : "initial" as const,
      };
      databaseRequests.push(request);
      if (request.date !== match.matchDate || request.slim !== "1" || request.generation !== "target") {
        await route.fulfill({ status: 200, json: { success: true, data: {
          matchIds: [], oddsMap: {}, oddsMetaMap: {}, crownLiveOddsMap: {}, crown12OddsMap: {},
        } } });
        return;
      }
      observeTargetDatabaseRequest();
      await targetDatabaseResponseGate;
      await route.fulfill({ status: 200, headers: { "x-e2e-generation": "target" }, json: { success: true, data: {
        matchIds: [match.id],
        oddsMap: { [match.id]: { matchId: match.id, openTime: "7-19 10:00", companies: [company("3", "皇冠", "7-19 10:00"), company("35", "盈禾", "7-19 11:00")] } },
        oddsMetaMap: { [match.id]: {
          source: "database",
          sourceObservedAt: "2099-07-19T03:00:00.000Z",
          writeToken: "excel-e2e-generation-1",
        } },
        crownLiveOddsMap: {}, crown12OddsMap: {},
      } } });
      return;
    }
    if (url.pathname === "/api/user-focused-leagues") {
      await route.fulfill({ status: 200, json: { success: true, leagues: [match.league] } });
      return;
    }
    if (url.pathname === "/api/schedule") {
      await route.fulfill({ status: 200, json: { success: true, data: {
        matches: [match],
        leagues: [{ id: "1", name: match.league, color: "#123456", count: 1 }],
      } } });
      return;
    }
    await route.fulfill({ status: 200, json: { success: true, leagues: [], data: [], dates: [], predictions: [] } });
  });

  const targetDatabaseResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/data/odds-db"
      && url.searchParams.get("date") === match.matchDate
      && url.searchParams.get("slim") === "1"
      && response.headers()["x-e2e-generation"] === "target";
  });
  await page.goto("/odds");
  await page.getByRole("tab", { name: "数据中心" }).click();
  await page.getByRole("button", { name: "未来赛程" }).click();
  targetGenerationInstalled = true;
  await page.locator('input[type="date"]').fill("2026-07-19");
  await expect(page.getByText("未来赛程 - 2026-07-19", { exact: false })).toBeVisible();
  await targetDatabaseRequestObserved;
  releaseTargetDatabaseResponse();
  await targetDatabaseResponse;
  await expect(page.getByRole("cell", { name: new RegExp(match.homeTeam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })).toBeVisible();
  await expect(page.getByRole("cell", { name: "皇冠", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "盈禾", exact: true })).toBeVisible();
  expect(databaseRequests.some(request => request.generation === "target" && request.date === match.matchDate && request.slim === "1")).toBe(true);
  expect(scriptRequests.some(path => path.endsWith(`/${excelJsChunk}`))).toBe(false);

  const exportButton = page.getByRole("button", { name: "导出Excel" });
  const downloads: string[] = [];
  page.on("download", download => downloads.push(download.suggestedFilename()));
  const downloadPromise = page.waitForEvent("download");
  await exportButton.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(page.getByRole("button", { name: "导出中…" })).toBeDisabled();
  const download = await downloadPromise;
  await expect.poll(() => scriptRequests.some(path => path.endsWith(`/${excelJsChunk}`))).toBe(true);
  expect(download.suggestedFilename()).toBe("赔率数据_20260719.xlsx");
  const path = await download.path();
  expect(path).not.toBeNull();

  const zip = await JSZip.loadAsync(await readFile(path!));
  const worksheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  const sharedStrings = await zip.file("xl/sharedStrings.xml")!.async("string");
  expect((worksheet.match(/<row\b/g) ?? [])).toHaveLength(3);
  expect(worksheet).not.toContain("<f>");
  for (const header of ["日期", "联赛", "时间", "状态", "主队", "客队", "开盘时间", "公司", "亚盘(初)盘口"]) {
    expect(sharedStrings).toContain(header);
  }
  expect(sharedStrings).toContain("皇冠");
  expect(sharedStrings).toContain("盈禾");
  expect(sharedStrings).toContain("中超 &amp; 青年&lt;组&gt;");
  expect(sharedStrings).toContain("=SUM(1,1)中文主队");
  expect(sharedStrings).toContain("客队&lt;&amp;&gt;");
  await expect.poll(() => downloads).toEqual(["赔率数据_20260719.xlsx"]);
  await expect(exportButton).toBeEnabled();
});
