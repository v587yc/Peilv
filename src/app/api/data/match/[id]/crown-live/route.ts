import { NextRequest, NextResponse } from "next/server";
import { parseThreeInOneLatestOdds } from "@/lib/titan-3in1-odds";
import { fetchTitanUrlBuffer } from "@/lib/titan-vip-fetch";

const FETCH_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer": "https://zq.titan007.com/",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

async function fetchUrlBuffer(url: string, retries = 2): Promise<Buffer> {
  return fetchTitanUrlBuffer(url, FETCH_HEADERS, retries);
}

interface CrownLatestOdds {
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
 * Parse the "开盘" row from changeDetail page.
 * The "开盘" data is the LAST row with status "即" (just before "早" rows begin).
 * Rows are ordered newest→oldest, so "即" rows come first, then "早" rows.
 * We need the last "即" row (the one right before the first "早" row).
 * For full-time rows: time field (td[0]) is empty.
 */
function parseHandicapOpen(html: string): {

  home: string;
  line: string;
  away: string;
} | null {
  const spanMatch = html.match(/<span id="odds2">([\s\S]*?)<\/span>/);
  if (!spanMatch) return null;

  const table = spanMatch[1];
  const trs = table.match(/<TR[^>]*>[\s\S]*?<\/TR>/gi);
  if (!trs || trs.length < 2) return null;

  // Find the first "早" row, then the last full-time "即" row before it
  for (let i = 1; i < trs.length; i++) {
    // Check if this row has "早" status
    const rowText = trs[i].replace(/<[^>]+>/g, "");
    if (rowText.includes("早")) {
      // Search backwards for the last full-time "即" row
      for (let j = i - 1; j >= 1; j--) {
        const tds = trs[j].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
        if (!tds || tds.length < 7) continue;
        const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
        // Full-time row: time field (td[0]) is empty, status (td[6]) is "即"
        if (values[0] === "" && values[6] === "即") {
          return {
            home: values[2],
            line: values[3],
            away: values[4],
          };
        }
      }
      // No full-time "即" row found, try the first "早" full-time row instead
      for (let j = i; j < trs.length; j++) {
        const tds = trs[j].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
        if (!tds || tds.length < 7) continue;
        const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
        if (values[0] === "" && values[6] === "早") {
          return {
            home: values[2],
            line: values[3],
            away: values[4],
          };
        }
      }
      break;
    }
  }

  // No "早" rows at all — use the last full-time "即" row
  for (let i = 1; i < trs.length; i++) {
    const tds = trs[i].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
    if (!tds || tds.length < 7) continue;
    const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
    if (values[0] === "" && (values[6] === "即" || values[6] === "滚")) {
      return {
        home: values[2],
        line: values[3],
        away: values[4],
      };
    }
  }

  return null;
}

/**
 * Parse the TERMINAL (终盘) odds from changeDetail page.
 * 终盘 = the FIRST full-time row with status "即" (the newest 即 row = closest to match start).
 * This represents the odds right before the match started.
 * For full-time rows: time field (td[0]) is empty.
 */
function parseHandicapTerminal(html: string): {
  home: string;
  line: string;
  away: string;
} | null {
  const spanMatch = html.match(/<span id="odds2">([\s\S]*?)<\/span>/);
  if (!spanMatch) return null;

  const table = spanMatch[1];
  const trs = table.match(/<TR[^>]*>[\s\S]*?<\/TR>/gi);
  if (!trs || trs.length < 2) return null;

  // Find the FIRST full-time "即" row (newest = closest to match start)
  // Rows are ordered newest→oldest, so the first matching row is the terminal odds
  for (let i = 1; i < trs.length; i++) {
    const tds = trs[i].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
    if (!tds || tds.length < 7) continue;
    const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
    // Full-time row: time field (td[0]) is empty, status (td[6]) is "即"
    if (values[0] === "" && values[6] === "即") {
      return {
        home: values[2],
        line: values[3],
        away: values[4],
      };
    }
  }

  return null;
}

/**
 * Parse the "开盘" row from overunder page (same logic as handicap).
 */
function parseOverunderOpen(html: string): {
  over: string;
  line: string;
  under: string;
} | null {
  const spanMatch = html.match(/<span id="odds2">([\s\S]*?)<\/span>/);
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
          return {
            over: values[2],
            line: values[3],
            under: values[4],
          };
        }
      }
      // Fallback: first full-time "早" row
      for (let j = i; j < trs.length; j++) {
        const tds = trs[j].match(/<TD[^>]*>([\s\S]*?)<\/TD>/gi);
        if (!tds || tds.length < 7) continue;
        const values = tds.map((td: string) => td.replace(/<[^>]+>/g, "").trim());
        if (values[0] === "" && values[6] === "早") {
          return {
            over: values[2],
            line: values[3],
            under: values[4],
          };
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
      return {
        over: values[2],
        line: values[3],
        under: values[4],
      };
    }
  }

  return null;
}

/**
 * Parse the TERMINAL (终盘) overunder odds from changeDetail page.
 * 终盘 = the FIRST full-time row with status "即" (the newest 即 row = closest to match start).
 */
function parseOverunderTerminal(html: string): {
  over: string;
  line: string;
  under: string;
} | null {
  const spanMatch = html.match(/<span id="odds2">([\s\S]*?)<\/span>/);
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
      return {
        over: values[2],
        line: values[3],
        under: values[4],
      };
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

    try {
      const threeInOneBuf = await fetchUrlBuffer(
        `https://vip.titan007.com/changeDetail/3in1Odds.aspx?id=${matchId}&companyid=3&l=0`
      );
      const html = new TextDecoder("gbk").decode(threeInOneBuf);
      const latest = parseThreeInOneLatestOdds(html);
      if (latest && (latest.handicapLine || latest.totalLine)) {
        const latestResult: CrownLatestOdds = {
          handicapHome: latest.handicapHome,
          handicapLine: latest.handicapLine,
          handicapAway: latest.handicapAway,
          totalOver: latest.totalOver,
          totalLine: latest.totalLine,
          totalUnder: latest.totalUnder,
          euroHome: latest.euroHome,
          euroDraw: latest.euroDraw,
          euroAway: latest.euroAway,
          handicapObservedAt: latest.handicapObservedAt,
          totalObservedAt: latest.totalObservedAt,
          euroObservedAt: latest.euroObservedAt,
        };
        return NextResponse.json({
          success: true,
          source: "3in1",
          data: latestResult,
          terminal: latestResult,
        });
      }
    } catch {
      // Fall back to the legacy individual market pages below.
    }

    const result: CrownLatestOdds = {
      handicapHome: "",
      handicapLine: "",
      handicapAway: "",
      totalOver: "",
      totalLine: "",
      totalUnder: "",
    };

    const terminalResult: CrownTerminalOdds = {
      handicapHome: "",
      handicapLine: "",
      handicapAway: "",
      totalOver: "",
      totalLine: "",
      totalUnder: "",
    };

    // Fetch handicap first, then overunder (sequential to avoid server throttling)
    try {
      const handicapBuf = await fetchUrlBuffer(
        `https://vip.titan007.com/changeDetail/handicap.aspx?id=${matchId}&companyid=3&l=0`
      );
      const html = new TextDecoder("gbk").decode(handicapBuf);
      const parsed = parseHandicapOpen(html);
      if (parsed) {
        result.handicapHome = parsed.home;
        result.handicapLine = parsed.line;
        result.handicapAway = parsed.away;
      }
      // Also parse terminal (终盘) odds
      const terminalParsed = parseHandicapTerminal(html);
      if (terminalParsed) {
        terminalResult.handicapHome = terminalParsed.home;
        terminalResult.handicapLine = terminalParsed.line;
        terminalResult.handicapAway = terminalParsed.away;
      }
    } catch {
      // Handicap fetch failed, continue to overunder
    }

    try {
      const overunderBuf = await fetchUrlBuffer(
        `https://vip.titan007.com/changeDetail/overunder.aspx?id=${matchId}&companyid=3&l=0`
      );
      const html = new TextDecoder("gbk").decode(overunderBuf);
      const parsed = parseOverunderOpen(html);
      if (parsed) {
        result.totalOver = parsed.over;
        result.totalLine = parsed.line;
        result.totalUnder = parsed.under;
      }
      // Also parse terminal (终盘) overunder odds
      const terminalParsed = parseOverunderTerminal(html);
      if (terminalParsed) {
        terminalResult.totalOver = terminalParsed.over;
        terminalResult.totalLine = terminalParsed.line;
        terminalResult.totalUnder = terminalParsed.under;
      }
    } catch {
      // Overunder fetch failed
    }

    const hasFallbackData = Boolean(result.handicapLine || result.totalLine);
    if (!hasFallbackData) {
      return NextResponse.json({ error: "未获取到皇冠最新赔率" }, { status: 502 });
    }

    return NextResponse.json({
      success: true,
      source: "legacy-fallback",
      data: result,
      terminal: terminalResult,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "抓取失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
