export interface ScheduleMatch {
  id: string;
  league: string;
  leagueColor: string;
  time: string;
  state: string;
  homeTeam: string;
  awayTeam: string;
  homeRank: string;
  awayRank: string;
  homeScore: string;
  awayScore: string;
  halfHomeScore: string;
  halfAwayScore: string;
  handicap: string;
  handicapRaw: number | null;
  totalLine: string;
  totalLineRaw: number | null;
  sclassId: string;
  matchDate: string;
  orderIndex: number;
  isHot: boolean;
}

export interface ScheduleLeague {
  id: string;
  name: string;
  color: string;
  count: number;
  isHot: boolean;
}

export interface TitanMatchDetailScore {
  id: string;
  state: string;
  time: string;
  matchDate: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: string;
  awayScore: string;
  halfHomeScore: string;
  halfAwayScore: string;
  league: string;
}

export type ScheduleContentStatus = "ok" | "valid_empty" | "blocked" | "wrong_page" | "encoding_error" | "layout_drift";

export interface ScheduleParserDiagnostics {
  pageIdentity: boolean;
  dateMatched: boolean;
  scheduleContainer: boolean;
  explicitEmptyMarker: boolean;
  candidateRows: number;
  parsedRows: number;
  malformedRows: number;
  malformedReasons: Record<string, number>;
}

export interface TitanScheduleResult {
  status: ScheduleContentStatus;
  charset: string;
  matches: ScheduleMatch[];
  leagues: ScheduleLeague[];
  diagnostics: ScheduleParserDiagnostics;
}

const GOAL_CN2 = [
  "0", "0/0.5", "0.5", "0.5/1", "1", "1/1.5", "1.5", "1.5/2", "2", "2/2.5",
  "2.5", "2.5/3", "3", "3/3.5", "3.5", "3.5/4", "4", "4/4.5", "4.5",
  "4.5/5", "5", "5/5.5", "5.5", "5.5/6", "6", "6/6.5", "6.5", "6.5/7", "7",
  "7/7.5", "7.5", "7.5/8", "8", "8/8.5", "8.5", "8.5/9", "9", "9/9.5",
  "9.5", "9.5/10", "10",
];

function emptyDiagnostics(): ScheduleParserDiagnostics {
  return {
    pageIdentity: false,
    dateMatched: false,
    scheduleContainer: false,
    explicitEmptyMarker: false,
    candidateRows: 0,
    parsedRows: 0,
    malformedRows: 0,
    malformedReasons: {},
  };
}

function normalizeCharset(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/["']/g, "");
  if (!normalized) return null;
  if (["gb2312", "gbk", "x-gbk", "gb18030"].includes(normalized)) return "gb18030";
  if (["utf8", "utf-8"].includes(normalized)) return "utf-8";
  return normalized;
}

function declaredCharsets(body: Buffer, contentType?: string): string[] {
  const header = contentType?.match(/charset\s*=\s*([^;\s]+)/i)?.[1];
  const ascii = body.toString("latin1", 0, Math.min(body.length, 8192));
  const meta = ascii.match(/<meta[^>]+charset\s*=\s*["']?([^"'\s/>]+)/i)?.[1]
    || ascii.match(/<meta[^>]+content\s*=\s*["'][^"']*charset=([^"';\s]+)/i)?.[1];
  return [...new Set([normalizeCharset(header), normalizeCharset(meta), "gb18030", "utf-8"].filter((value): value is string => Boolean(value)))];
}

function requestedDateText(date: string): string {
  return `${date.slice(0, 4)}年${date.slice(4, 6)}月${date.slice(6, 8)}日`;
}

function decodeScheduleBody(body: Buffer, contentType: string | undefined, date: string): { html: string; charset: string } | null {
  let best: { html: string; charset: string; score: number } | null = null;
  for (const charset of declaredCharsets(body, contentType)) {
    try {
      const html = new TextDecoder(charset).decode(body);
      const replacementCount = (html.match(/�/g) || []).length;
      const score = replacementCount * 100
        - (html.includes(requestedDateText(date)) ? 1000 : 0)
        - (/id\s*=\s*["']?table_live/i.test(html) ? 500 : 0)
        - (/<html\b/i.test(html) ? 100 : 0);
      if (!best || score < best.score) best = { html, charset, score };
    } catch {
      continue;
    }
  }
  return best && best.score < 10_000 ? best : null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const regex = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(tag)) !== null) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function parseCells(rowHtml: string): Array<{ attrs: Record<string, string>; text: string }> {
  const cells: Array<{ attrs: Record<string, string>; text: string }> = [];
  const regex = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rowHtml)) !== null) {
    cells.push({ attrs: parseAttributes(`<td ${match[1]}>`), text: stripHtml(match[2]) });
  }
  return cells;
}

function parseScore(value: string): [string, string] | null {
  const match = value.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  return match ? [match[1], match[2]] : null;
}

function formatHandicap(goal: number): string {
  if (goal === 0) return "0";
  const idx = Math.round(Math.abs(goal) * 4);
  if (idx >= 0 && idx < GOAL_CN2.length) return goal < 0 ? `受${GOAL_CN2[idx]}` : GOAL_CN2[idx];
  return String(goal);
}

function parseNullableNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapState(state: string): string {
  if (state === "完") return "-1";
  if (state === "未" || state === "") return "0";
  if (state === "中") return "1";
  return state;
}

function buildLeagues(matches: ScheduleMatch[]): ScheduleLeague[] {
  const leagues = new Map<string, ScheduleLeague>();
  for (const match of matches) {
    if (!match.league) continue;
    const existing = leagues.get(match.league);
    if (existing) existing.count++;
    else leagues.set(match.league, {
      id: match.sclassId,
      name: match.league,
      color: match.leagueColor,
      count: 1,
      isHot: match.isHot,
    });
  }
  return [...leagues.values()].sort((a, b) => b.count - a.count);
}

function addMalformed(diagnostics: ScheduleParserDiagnostics, reason: string): void {
  diagnostics.malformedRows++;
  diagnostics.malformedReasons[reason] = (diagnostics.malformedReasons[reason] || 0) + 1;
}

function emptyMarkerInsideSchedule(html: string): boolean {
  const table = html.match(/<table\b[^>]*id\s*=\s*["']?table_live["']?[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  return Boolean(table && /(暂无(?:赛事|比赛)|没有(?:赛事|比赛)|无(?:赛事|比赛)|no\s+(?:matches|fixtures))/i.test(stripHtml(table)));
}

function blockedContent(html: string): boolean {
  return /(captcha|验证码|安全验证|人机验证|访问被拒绝|access denied|too many requests|rate limit|verify you are human)/i.test(html);
}

export function parseTitanSchedule(body: Buffer, contentType: string | undefined, date: string): TitanScheduleResult {
  const decoded = decodeScheduleBody(body, contentType, date);
  const diagnostics = emptyDiagnostics();
  if (!decoded) return { status: "encoding_error", charset: "unknown", matches: [], leagues: [], diagnostics };
  const { html, charset } = decoded;
  if (blockedContent(html)) return { status: "blocked", charset, matches: [], leagues: [], diagnostics };

  diagnostics.dateMatched = html.includes(requestedDateText(date)) || html.includes(date);
  diagnostics.scheduleContainer = /id\s*=\s*["']?table_live/i.test(html);
  diagnostics.pageIdentity = diagnostics.dateMatched && diagnostics.scheduleContainer && /(?:完场比分|赛程赛果|足球赛程表|足球直播)/i.test(html);
  diagnostics.explicitEmptyMarker = emptyMarkerInsideSchedule(html);

  if (!diagnostics.pageIdentity) {
    return { status: "wrong_page", charset, matches: [], leagues: [], diagnostics };
  }

  const importantSclass = html.match(/importantSclass\s*=\s*["']([^"']+)["']/i)?.[1] || "";
  const hotLeagueIds = new Set(importantSclass.split(",").map(value => value.trim()).filter(Boolean));
  const matches: ScheduleMatch[] = [];
  const seen = new Map<string, ScheduleMatch>();
  const rowRegex = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const attrs = parseAttributes(`<tr ${rowMatch[1]}>`);
    if (!attrs.name && !attrs.sid) continue;
    diagnostics.candidateRows++;
    const name = attrs.name?.match(/^([^,]+),(.+)$/);
    if (!name) {
      addMalformed(diagnostics, "invalid_league_order");
      continue;
    }
    if (!/^\d+$/.test(attrs.sid || "")) {
      addMalformed(diagnostics, "invalid_match_id");
      continue;
    }
    const cells = parseCells(rowMatch[2]);
    if (cells.length < 7) {
      addMalformed(diagnostics, "insufficient_cells");
      continue;
    }
    const league = cells[0].text;
    const time = cells[1].text;
    const rawState = cells[2].text;
    const homeRank = cells[3].text.match(/\[([^\]]+)\]/)?.[1] || "";
    const awayRank = cells[5].text.match(/\[([^\]]+)\]/)?.[1] || "";
    const homeTeam = cells[3].text.replace(/\[.*?\]/g, "").trim();
    const awayTeam = cells[5].text.replace(/\[.*?\]/g, "").trim();
    if (!league || !time || !homeTeam || !awayTeam) {
      addMalformed(diagnostics, "missing_required_text");
      continue;
    }
    const score = parseScore(cells[4].text);
    const halfScore = parseScore(cells[6].text);
    const handicapRaw = parseNullableNumber(cells[7]?.attrs.val);
    const totalLineRaw = parseNullableNumber(cells[8]?.attrs.val);
    const match: ScheduleMatch = {
      id: attrs.sid,
      league,
      leagueColor: cells[0].attrs.bgcolor || "#333",
      time,
      state: mapState(rawState),
      homeTeam,
      awayTeam,
      homeRank,
      awayRank,
      homeScore: score?.[0] || "",
      awayScore: score?.[1] || "",
      halfHomeScore: halfScore?.[0] || "",
      halfAwayScore: halfScore?.[1] || "",
      handicap: handicapRaw === null ? cells[7]?.text || "" : formatHandicap(handicapRaw),
      handicapRaw,
      totalLine: totalLineRaw === null ? cells[8]?.text || "" : String(totalLineRaw),
      totalLineRaw,
      sclassId: name[1],
      matchDate: date,
      orderIndex: matches.length,
      isHot: hotLeagueIds.has(name[1]),
    };
    const duplicate = seen.get(match.id);
    if (duplicate && (duplicate.homeTeam !== match.homeTeam || duplicate.awayTeam !== match.awayTeam || duplicate.homeScore !== match.homeScore || duplicate.awayScore !== match.awayScore)) {
      addMalformed(diagnostics, "conflicting_duplicate");
      continue;
    }
    if (!duplicate) {
      matches.push(match);
      seen.set(match.id, match);
      diagnostics.parsedRows++;
    }
  }

  if (diagnostics.candidateRows === 0) {
    const status = diagnostics.explicitEmptyMarker ? "valid_empty" : "layout_drift";
    return { status, charset, matches: [], leagues: [], diagnostics };
  }
  if (diagnostics.parsedRows === 0 || diagnostics.parsedRows / diagnostics.candidateRows < 0.9 || diagnostics.malformedReasons.conflicting_duplicate) {
    return { status: "layout_drift", charset, matches: [], leagues: [], diagnostics };
  }
  return { status: "ok", charset, matches, leagues: buildLeagues(matches), diagnostics };
}

function liveMatchDate(value: string): string | null {
  const parts = value.split(",").slice(0, 3).map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isInteger(part))) return null;
  const [year, zeroBasedMonth, day] = parts;
  const date = new Date(Date.UTC(year, zeroBasedMonth, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== zeroBasedMonth || date.getUTCDate() !== day) return null;
  return `${year}${String(zeroBasedMonth + 1).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

function compactMatchDate(value: string): string {
  return /^\d{14}$/.test(value) ? value.slice(0, 8) : "";
}

function compactMatchTime(value: string): string {
  return /^\d{14}$/.test(value) ? `${value.slice(8, 10)}:${value.slice(10, 12)}` : "";
}

function fieldScore(value: string | undefined): string {
  return /^\d+$/.test(value || "") ? String(Number(value)) : "";
}

export function parseTitanAnalysisHeader(text: string): TitanMatchDetailScore | null {
  const fields = text.trim().split("^");
  if (fields.length < 12 || !/^\d+$/.test(fields[72] || "")) return null;
  const homeScore = fieldScore(fields[10]);
  const awayScore = fieldScore(fields[11]);
  return {
    id: fields[72],
    state: fields[4] || "",
    time: compactMatchTime(fields[5] || ""),
    matchDate: compactMatchDate(fields[5] || ""),
    homeTeam: fields[0] || "",
    awayTeam: fields[1] || "",
    homeScore,
    awayScore,
    halfHomeScore: fieldScore(fields[26]),
    halfAwayScore: fieldScore(fields[27]),
    league: fields[15] || "",
  };
}

function trailingRank(value: string): string {
  return value.match(/(\d+)$/)?.[1] || "";
}

export function parseTitanLiveResults(jsText: string, date: string): TitanScheduleResult {
  const diagnostics = emptyDiagnostics();
  diagnostics.pageIdentity = /A\[\d+\]="/.test(jsText);
  diagnostics.scheduleContainer = diagnostics.pageIdentity;
  diagnostics.dateMatched = jsText.includes(`${date.slice(0, 4)},${Number(date.slice(4, 6)) - 1},${Number(date.slice(6, 8))}`);
  if (!diagnostics.pageIdentity || blockedContent(jsText)) {
    return { status: blockedContent(jsText) ? "blocked" : "wrong_page", charset: "utf-8", matches: [], leagues: [], diagnostics };
  }

  const matches: ScheduleMatch[] = [];
  const rowRegex = /A\[\d+\]="([^"]+)"/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(jsText)) !== null) {
    const fields = rowMatch[1].split("^");
    if (liveMatchDate(fields[12] || "") !== date) continue;
    diagnostics.candidateRows++;
    if (fields.length < 46 || !/^\d+$/.test(fields[0] || "") || !fields[2] || !fields[5] || !fields[8]) {
      addMalformed(diagnostics, "invalid_live_row");
      continue;
    }
    const state = fields[13] || "";
    const score = /^\d+$/.test(fields[14] || "") && /^\d+$/.test(fields[15] || "")
      ? [fields[14], fields[15]] as [string, string]
      : null;
    if (state === "-1" && !score) {
      addMalformed(diagnostics, "invalid_finished_score");
      continue;
    }
    const halfScore = /^\d+$/.test(fields[16] || "") && /^\d+$/.test(fields[17] || "")
      ? [fields[16], fields[17]] as [string, string]
      : null;
    matches.push({
      id: fields[0],
      league: stripHtml(fields[2]),
      leagueColor: fields[1] || "#333",
      time: fields[11] || "",
      state,
      homeTeam: stripHtml(fields[5]).replace(/\([^)]*\)$/g, "").trim(),
      awayTeam: stripHtml(fields[8]).replace(/\([^)]*\)$/g, "").trim(),
      homeRank: trailingRank(fields[22] || ""),
      awayRank: trailingRank(fields[23] || ""),
      homeScore: score?.[0] || "",
      awayScore: score?.[1] || "",
      halfHomeScore: halfScore?.[0] || "",
      halfAwayScore: halfScore?.[1] || "",
      handicap: "",
      handicapRaw: null,
      totalLine: "",
      totalLineRaw: null,
      sclassId: fields[45] || "",
      matchDate: date,
      orderIndex: matches.length,
      isHot: fields[62] === "1",
    });
    diagnostics.parsedRows++;
  }

  if (diagnostics.candidateRows === 0) return { status: "wrong_page", charset: "utf-8", matches: [], leagues: [], diagnostics };
  if (diagnostics.parsedRows === 0 || diagnostics.parsedRows / diagnostics.candidateRows < 0.9) {
    return { status: "layout_drift", charset: "utf-8", matches: [], leagues: [], diagnostics };
  }
  return { status: "ok", charset: "utf-8", matches, leagues: buildLeagues(matches), diagnostics };
}
