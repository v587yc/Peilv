import { NextRequest, NextResponse } from "next/server";
import { fetchTitanUrlBuffer } from "@/lib/titan-vip-fetch";

const FETCH_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer": "https://zq.titan007.com/",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

async function fetchUrlBuffer(url: string, retries = 2): Promise<Buffer> {
  return fetchTitanUrlBuffer(url, FETCH_HEADERS, retries);
}

type CrownMarketStatus = "available" | "unavailable";

interface CrownStatus {
  handicap: CrownMarketStatus;
  total: CrownMarketStatus;
}

function assertRecognizableOddsPage(html: string, market: "handicap" | "total"): void {
  const spanMatch = html.match(/<span id="odds2">([\s\S]*?)<\/span>/i);
  if (!spanMatch) throw new Error(`${market} parse failed: odds2 missing`);

  const rows = spanMatch[1].match(/<TR[^>]*>[\s\S]*?<\/TR>/gi);
  if (!rows?.length) return;

  const dataRows = rows.slice(1);
  if (dataRows.length && !dataRows.some((row) => (row.match(/<TD[^>]*>[\s\S]*?<\/TD>/gi)?.length || 0) >= 7)) {
    throw new Error(`${market} parse failed: odds columns invalid`);
  }
}

/**
 * Parse the "开盘" row from changeDetail handicap page.
 * Returns the last full-time "即" row (just before "早" rows begin).
 */
function parseHandicapOpen(html: string): {
  home: string;
  line: string;
  away: string;
} | null {
  const spanMatch = html.match(/<span id="odds2">([\s\S]*?)<\/span>/i);
  if (!spanMatch) return null;

  const table = spanMatch[1];
  const trs = table.match(/<TR[^>]*>[\s\S]*?<\/TR>/gi);
  if (!trs || trs.length < 2) return null;

  // Find the first "早" row, then the last full-time "即" row before it
  for (let i = 1; i < trs.length; i++) {
    const rowText = trs[i].replace(/<[^>]+>/g, "");
    if (rowText.includes("早")) {
      for (let j = i - 1; j >= 1; j--) {
        const tds = trs[j].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
        if (!tds || tds.length < 7) continue;
        const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
        if (values[0] === "" && values[6] === "即") {
          return { home: values[2], line: values[3], away: values[4] };
        }
      }
      // Fallback: first full-time "早" row
      for (let j = i; j < trs.length; j++) {
        const tds = trs[j].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
        if (!tds || tds.length < 7) continue;
        const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
        if (values[0] === "" && values[6] === "早") {
          return { home: values[2], line: values[3], away: values[4] };
        }
      }
      break;
    }
  }

  // No "早" rows — use the last full-time "即" row
  for (let i = 1; i < trs.length; i++) {
    const tds = trs[i].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
    if (!tds || tds.length < 7) continue;
    const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
    if (values[0] === "" && (values[6] === "即" || values[6] === "滚")) {
      return { home: values[2], line: values[3], away: values[4] };
    }
  }

  return null;
}

/**
 * Parse the "开盘" row from overunder page (same logic).
 */
function parseOverunderOpen(html: string): {
  over: string;
  line: string;
  under: string;
} | null {
  const spanMatch = html.match(/<span id="odds2">([\s\S]*?)<\/span>/i);
  if (!spanMatch) return null;

  const table = spanMatch[1];
  const trs = table.match(/<TR[^>]*>[\s\S]*?<\/TR>/gi);
  if (!trs || trs.length < 2) return null;

  for (let i = 1; i < trs.length; i++) {
    const rowText = trs[i].replace(/<[^>]+>/g, "");
    if (rowText.includes("早")) {
      for (let j = i - 1; j >= 1; j--) {
        const tds = trs[j].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
        if (!tds || tds.length < 7) continue;
        const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
        if (values[0] === "" && values[6] === "即") {
          return { over: values[2], line: values[3], under: values[4] };
        }
      }
      for (let j = i; j < trs.length; j++) {
        const tds = trs[j].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
        if (!tds || tds.length < 7) continue;
        const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
        if (values[0] === "" && values[6] === "早") {
          return { over: values[2], line: values[3], under: values[4] };
        }
      }
      break;
    }
  }

  for (let i = 1; i < trs.length; i++) {
    const tds = trs[i].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
    if (!tds || tds.length < 7) continue;
    const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
    if (values[0] === "" && (values[6] === "即" || values[6] === "滚")) {
      return { over: values[2], line: values[3], under: values[4] };
    }
  }

  return null;
}

interface CrownOpenOdds {
  handicapHome: string;
  handicapLine: string;
  handicapAway: string;
  totalOver: string;
  totalLine: string;
  totalUnder: string;
}

interface CrownTerminalOdds {
  handicapHome: string;
  handicapLine: string;
  handicapAway: string;
  totalOver: string;
  totalLine: string;
  totalUnder: string;
  euroHome?: string;
  euroDraw?: string;
  euroAway?: string;
  handicapObservedAt?: string;
  totalObservedAt?: string;
  euroObservedAt?: string;
}

/**
 * Parse the TERMINAL (终盘) odds from changeDetail page.
 * 终盘 = the FIRST full-time row with status "即" (the newest 即 row = closest to match start).
 * This represents the final closing odds right before the match started.
 * 
 * Fallback: if no "即" row exists, use the FIRST "早" row (newest 早 row).
 * "早" rows are ordered newest→oldest, so the first 早 row is closest to match start.
 */
function parseHandicapTerminal(html: string): {
  home: string;
  line: string;
  away: string;
} | null {
  const spanMatch = html.match(/<span id="odds2">([\s\S]*?)<\/span>/i);
  if (!spanMatch) return null;

  const table = spanMatch[1];
  const trs = table.match(/<TR[^>]*>[\s\S]*?<\/TR>/gi);
  if (!trs || trs.length < 2) return null;

  // Find the FIRST full-time "即" row (newest = closest to match start)
  for (let i = 1; i < trs.length; i++) {
    const tds = trs[i].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
    if (!tds || tds.length < 7) continue;
    const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
    if (values[0] === "" && values[6] === "即") {
      return { home: values[2], line: values[3], away: values[4] };
    }
  }

  // Fallback: no "即" row — use the FIRST "早" row (newest = closest to match start)
  for (let i = 1; i < trs.length; i++) {
    const tds = trs[i].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
    if (!tds || tds.length < 7) continue;
    const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
    if (values[0] === "" && values[6] === "早") {
      return { home: values[2], line: values[3], away: values[4] };
    }
  }

  return null;
}

function parseOverunderTerminal(html: string): {
  over: string;
  line: string;
  under: string;
} | null {
  const spanMatch = html.match(/<span id="odds2">([\s\S]*?)<\/span>/i);
  if (!spanMatch) return null;

  const table = spanMatch[1];
  const trs = table.match(/<TR[^>]*>[\s\S]*?<\/TR>/gi);
  if (!trs || trs.length < 2) return null;

  // Find the FIRST full-time "即" row (newest = closest to match start)
  for (let i = 1; i < trs.length; i++) {
    const tds = trs[i].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
    if (!tds || tds.length < 7) continue;
    const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
    if (values[0] === "" && values[6] === "即") {
      return { over: values[2], line: values[3], under: values[4] };
    }
  }

  // Fallback: no "即" row — use the FIRST "早" row (newest = closest to match start)
  for (let i = 1; i < trs.length; i++) {
    const tds = trs[i].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
    if (!tds || tds.length < 7) continue;
    const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
    if (values[0] === "" && values[6] === "早") {
      return { over: values[2], line: values[3], under: values[4] };
    }
  }

  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: matchId } = await params;
    const { searchParams } = new URL(request.url);
    const companyIds = (searchParams.get("companies") || "3,35,42,47")
      .split(",")
      .map((companyId) => companyId.trim())
      .filter(Boolean);
    const includeCrownOpen = searchParams.get("crownOpen") !== "false";
    const shouldFetchCrown = includeCrownOpen && companyIds.includes("3");
    const entries: { companyId: string; openTime: string }[] = [];
    let crownOpenData: CrownOpenOdds | null = null;
    let crownTerminalData: CrownTerminalOdds | null = null;
    const crownStatus: CrownStatus | undefined = shouldFetchCrown
      ? { handicap: "unavailable", total: "unavailable" }
      : undefined;

    for (const cid of companyIds) {
      try {
        const url = `https://vip.titan007.com/changeDetail/handicap.aspx?id=${matchId}&companyid=${cid}&l=0`;
        const buf = await fetchUrlBuffer(url);
        const html = new TextDecoder("gbk").decode(buf);
        const timeMatches = [...html.matchAll(/(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/g)];
        const openTime = timeMatches.length > 0 ? timeMatches[timeMatches.length - 1][1] : "";
        entries.push({ companyId: cid, openTime });

        if (shouldFetchCrown && cid === "3") {
          assertRecognizableOddsPage(html, "handicap");
          const parsed = parseHandicapOpen(html);
          const terminalParsed = parseHandicapTerminal(html);
          crownStatus!.handicap = parsed ? "available" : "unavailable";
          if (parsed) {
            crownOpenData = {
              handicapHome: parsed.home,
              handicapLine: parsed.line,
              handicapAway: parsed.away,
              totalOver: "",
              totalLine: "",
              totalUnder: "",
            };
          }
          if (terminalParsed) {
            crownTerminalData = {
              handicapHome: terminalParsed.home,
              handicapLine: terminalParsed.line,
              handicapAway: terminalParsed.away,
              totalOver: "",
              totalLine: "",
              totalUnder: "",
            };
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (shouldFetchCrown && cid === "3") {
          throw new Error(`皇冠亚盘抓取失败 ${matchId}: ${message}`);
        }
        console.error(`[OpenTimes] Failed for company ${cid}:`, message);
        entries.push({ companyId: cid, openTime: "" });
      }
    }

    if (shouldFetchCrown) {
      try {
        const url = `https://vip.titan007.com/changeDetail/overunder.aspx?id=${matchId}&companyid=3&l=0`;
        const buf = await fetchUrlBuffer(url);
        const html = new TextDecoder("gbk").decode(buf);
        assertRecognizableOddsPage(html, "total");
        const parsed = parseOverunderOpen(html);
        const terminalParsed = parseOverunderTerminal(html);
        crownStatus!.total = parsed ? "available" : "unavailable";

        if (parsed) {
          crownOpenData ??= {
            handicapHome: "",
            handicapLine: "",
            handicapAway: "",
            totalOver: "",
            totalLine: "",
            totalUnder: "",
          };
          crownOpenData.totalOver = parsed.over;
          crownOpenData.totalLine = parsed.line;
          crownOpenData.totalUnder = parsed.under;
        }
        if (terminalParsed) {
          crownTerminalData ??= {
            handicapHome: "",
            handicapLine: "",
            handicapAway: "",
            totalOver: "",
            totalLine: "",
            totalUnder: "",
          };
          crownTerminalData.totalOver = terminalParsed.over;
          crownTerminalData.totalLine = terminalParsed.line;
          crownTerminalData.totalUnder = terminalParsed.under;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`皇冠大小球抓取失败 ${matchId}: ${message}`);
      }
    }

    return NextResponse.json({
      success: true,
      data: entries,
      crownOpen: crownOpenData || undefined,
      crownTerminal: crownTerminalData || undefined,
      crownStatus,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "抓取失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
