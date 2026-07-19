import type { CompanyOddsItem, MatchData } from "./contracts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ReportTrendPoint = Record<string, unknown> & { date?: string };
export type ReportData = { date: string; rows: unknown[]; summary: object; [key: string]: unknown };
export type OddsExportMatch = Pick<MatchData, "id" | "matchDate" | "league" | "time" | "state" | "homeTeam" | "awayTeam"> & Partial<Pick<MatchData, "homeScore" | "awayScore" | "halfHomeScore" | "halfAwayScore">>;
export type CrownExportOdds = {
  handicapHome?: string | null;
  handicapLine?: string | null;
  handicapAway?: string | null;
  totalOver?: string | null;
  totalLine?: string | null;
  totalUnder?: string | null;
};
export type ExportRow = Record<string, string | number>;

async function readJson(fetcher: FetchLike, url: string, fallback: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = init ? await fetcher(url, init) : await fetcher(url);
  const json = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !json || json.success !== true) throw new Error(typeof json?.error === "string" ? json.error : fallback);
  return json;
}

export async function fetchReportDates(fetcher: FetchLike): Promise<string[]> {
  const json = await readJson(fetcher, "/api/report", "加载报表日期失败");
  if (!Array.isArray(json.dates)) throw new Error("加载报表日期失败");
  return json.dates.flatMap(item => item && typeof item === "object" && typeof (item as { report_date?: unknown }).report_date === "string" ? [(item as { report_date: string }).report_date] : []);
}

export async function fetchReportTrend(fetcher: FetchLike): Promise<ReportTrendPoint[]> {
  const json = await readJson(fetcher, "/api/report?trend=14", "加载报表趋势失败");
  if (!Array.isArray(json.trend)) throw new Error("加载报表趋势失败");
  return json.trend.filter((item): item is ReportTrendPoint => Boolean(item && typeof item === "object"));
}

export function parseStoredReport(content: unknown): ReportData {
  let value: unknown = content;
  try {
    if (typeof value === "string") value = JSON.parse(value);
  } catch {
    throw new Error("加载AI报表失败");
  }
  if (!value || typeof value !== "object") throw new Error("加载AI报表失败");
  const report = value as Partial<ReportData>;
  if (typeof report.date !== "string" || !Array.isArray(report.rows) || !report.summary || typeof report.summary !== "object") throw new Error("加载AI报表失败");
  return report as ReportData;
}

export async function fetchReport(fetcher: FetchLike, date: string): Promise<ReportData> {
  const json = await readJson(fetcher, `/api/report?date=${date}`, "加载AI报表失败");
  const data = json.data as { report_content?: unknown } | undefined;
  return parseStoredReport(data?.report_content);
}

export async function generateReport(fetcher: FetchLike, predictionDate: string): Promise<ReportData & { latestAnalysisAt?: unknown }> {
  const json = await readJson(fetcher, `/api/report?predDate=${predictionDate}&mode=ai`, "生成AI报表失败", { method: "POST" });
  const report = json.report;
  if (!report || typeof report !== "object") throw new Error("生成AI报表失败");
  const candidate = report as Partial<ReportData>;
  if (typeof candidate.date !== "string" || !Array.isArray(candidate.rows)) throw new Error("生成AI报表失败");
  return { ...candidate, summary: candidate.summary && typeof candidate.summary === "object" ? candidate.summary : {} } as ReportData & { latestAnalysisAt?: unknown };
}

export async function runReportCommand<T extends ReportData>(options: {
  generate(): Promise<T>;
  apply(report: T): void;
  refreshDates(): Promise<void>;
  refreshTrend(): Promise<void>;
  start(): void;
  success(report: T): void;
  error(error: unknown): void;
  settle(): void;
}): Promise<T | null> {
  options.start();
  try {
    const report = await options.generate();
    options.apply(report);
    options.success(report);
    await options.refreshDates();
    await options.refreshTrend();
    return report;
  } catch (error) {
    options.error(error);
    return null;
  } finally {
    options.settle();
  }
}

export function filterReportByLeagues<T extends { rows: unknown[] }>(report: T | null, leagues: ReadonlySet<string>): T | null {
  if (!report || leagues.size === 0) return report;
  return { ...report, rows: report.rows.filter(row => Boolean(row && typeof row === "object" && leagues.has(String((row as { league?: unknown }).league ?? "")))) };
}

function statusLabel(state: string): string {
  return state === "0" ? "未开赛" : state === "1" ? "进行中" : state === "-1" ? "完场" : state;
}

function appendMatch(row: ExportRow, match: OddsExportMatch, history: boolean) {
  row["日期"] = match.matchDate || "";
  row["联赛"] = match.league;
  row["时间"] = match.time;
  row["状态"] = statusLabel(match.state);
  if (history) {
    row["比分"] = match.homeScore && match.awayScore ? `${match.homeScore}-${match.awayScore}` : "";
    row["半场"] = match.halfHomeScore && match.halfAwayScore ? `${match.halfHomeScore}-${match.halfAwayScore}` : "";
  }
  row["主队"] = match.homeTeam;
  row["客队"] = match.awayTeam;
}

function formatExportHandicap(line: string): string {
  const numeric = Number(line);
  if (!Number.isFinite(numeric)) return line;
  const sign = numeric < 0 ? "受" : "";
  const value = Math.abs(numeric);
  const labels: Record<number, string> = { 0: "平手", 0.25: "平手/半球", 0.5: "半球", 0.75: "半球/一球", 1: "一球", 1.25: "一球/球半", 1.5: "球半", 1.75: "球半/两球", 2: "两球", 2.25: "两球/两球半", 2.5: "两球半", 2.75: "两球半/三球", 3: "三球" };
  return labels[value] ? `${sign}${labels[value]}` : line;
}

function appendCrown(row: ExportRow, prefix: "终盘" | "新数据", odds: CrownExportOdds) {
  row[`${prefix}-亚盘主水`] = odds.handicapHome || "";
  row[`${prefix}-亚盘盘口`] = prefix === "终盘" ? formatExportHandicap(odds.handicapLine || "") : odds.handicapLine || "";
  row[`${prefix}-亚盘客水`] = odds.handicapAway || "";
  row[`${prefix}-进球大水`] = odds.totalOver || "";
  row[`${prefix}-进球盘口`] = odds.totalLine || "";
  row[`${prefix}-进球小水`] = odds.totalUnder || "";
}

function appendCompany(row: ExportRow, company: CompanyOddsItem) {
  row["开盘时间"] = company.openTime || "";
  row["公司"] = company.companyName;
  row["亚盘(初)主水"] = company.ftHandicapHome || "";
  row["亚盘(初)盘口"] = company.ftHandicapLine || "";
  row["亚盘(初)客水"] = company.ftHandicapAway || "";
  row["欧转亚盘(初)主水"] = company.euroAsianHome || "";
  row["欧转亚盘(初)盘口"] = company.euroAsianLine || "";
  row["欧转亚盘(初)客水"] = company.euroAsianAway || "";
  row["进球数(初)大水"] = company.ftTotalOver || "";
  row["进球数(初)盘口"] = company.ftTotalLine || "";
  row["进球数(初)小水"] = company.ftTotalUnder || "";
}

function normalizeOpenTime(time: string): string {
  if (!time) return "zzz";
  const match = time.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return time;
  return `${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")} ${match[3].padStart(2, "0")}:${match[4]}`;
}

export function buildOddsExportRows(input: {
  matches: readonly OddsExportMatch[];
  selectedLeagues: ReadonlySet<string>;
  scheduleMode: string;
  companyIds: ReadonlySet<string>;
  companyOdds: ReadonlyMap<string, readonly CompanyOddsItem[]>;
  crownOpenOdds: ReadonlyMap<string, CrownExportOdds>;
  crownFinalOdds?: ReadonlyMap<string, CrownExportOdds>;
}): ExportRow[] {
  const history = input.scheduleMode === "history";
  const rows: ExportRow[] = [];
  for (const match of input.matches) {
    if (input.selectedLeagues.size > 0 && !input.selectedLeagues.has(match.league)) continue;
    const allCompanies = input.companyOdds.get(match.id) ?? [];
    const companies = allCompanies.filter(company => input.companyIds.has(company.companyId)).sort((a, b) => normalizeOpenTime(a.openTime).localeCompare(normalizeOpenTime(b.openTime)));
    const crown = allCompanies.find(company => company.companyId === "3");
    const live = crown && (crown.ftHandicapLineLive || crown.ftTotalLineLive) ? {
      handicapHome: crown.ftHandicapHomeLive, handicapLine: crown.ftHandicapLineLive, handicapAway: crown.ftHandicapAwayLive,
      totalOver: crown.ftTotalOverLive, totalLine: crown.ftTotalLineLive, totalUnder: crown.ftTotalUnderLive,
    } : input.crownFinalOdds?.get(match.id);
    const open = input.crownOpenOdds.get(match.id);
    if (companies.length === 0) {
      const row: ExportRow = {};
      appendMatch(row, match, history);
      if (history && live) appendCrown(row, "终盘", live);
      if (history && open) appendCrown(row, "新数据", open);
      rows.push(row);
      continue;
    }
    for (const company of companies) {
      const row: ExportRow = {};
      appendMatch(row, match, history);
      if (history && live) appendCrown(row, "终盘", live);
      if (open) appendCrown(row, "新数据", open);
      appendCompany(row, company);
      rows.push(row);
    }
  }
  return rows;
}

export function countOddsExportRows(input: Pick<Parameters<typeof buildOddsExportRows>[0], "matches" | "selectedLeagues" | "companyIds" | "companyOdds">): number {
  let count = 0;
  for (const match of input.matches) {
    if (input.selectedLeagues.size > 0 && !input.selectedLeagues.has(match.league)) continue;
    const companies = (input.companyOdds.get(match.id) ?? []).filter(company => input.companyIds.has(company.companyId));
    count += Math.max(1, companies.length);
  }
  return count;
}
