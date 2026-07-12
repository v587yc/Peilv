import { NextRequest, NextResponse } from "next/server";
import { fetchTitanUrlBuffer } from "@/lib/titan-vip-fetch";
import { parseTitanAnalysisHeader } from "@/lib/titan-schedule";
import { persistScheduleResults } from "@/lib/verification/match-results";
import { getSupabaseClient } from "@/storage/database/supabase-client";

// Abbreviated name → full name mapping (from website data like "Crow*" → "皇冠")
const ABBR_TO_FULL: Record<string, string> = {
  "澳": "澳门", "Crow": "皇冠", "盈": "盈禾", "18": "18博",
  "易": "易胜博", "平": "平博", "36": "36bet", "明": "明升",
  "伟": "伟德", "利": "利记", "12": "12BET", "1x": "1xbet",
  "金宝": "金宝博", "10B": "10BET", "必发": "必发", "Bet365": "Bet365",
  "沙巴": "沙巴", "立博": "立博", "5D": "5Dimes", "必赢": "必赢",
};

function resolveCompanyName(abbrName: string): string {
  // Strip trailing * and try to match prefix
  const clean = abbrName.replace(/\*+$/, "");
  for (const [prefix, fullName] of Object.entries(ABBR_TO_FULL)) {
    if (clean.startsWith(prefix) || clean === prefix) return fullName;
  }
  return clean; // fallback: return cleaned name without *
}

const FETCH_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://zq.titan007.com/",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

async function fetchUrl(url: string, retries = 1): Promise<string> {
  const buffer = await fetchTitanUrlBuffer(url, FETCH_HEADERS, retries, 15_000);
  return new TextDecoder("utf-8").decode(buffer);
}

function analysisHeaderPath(matchId: string, locale: "cn" | "big" = "cn"): string {
  return `/phone/txt/analysisheader/${locale}/${matchId.slice(0, 1)}/${matchId.slice(1, 3)}/${matchId}.txt`;
}

async function fetchMatchDetailScore(matchId: string) {
  if (!/^\d+$/.test(matchId)) return null;
  const observedAt = new Date().toISOString();
  const headers = { ...FETCH_HEADERS, Referer: `https://live.titan007.com/detail/${matchId}.htm`, Accept: "*/*" };
  const urls = [
    `https://livestatic.titan007.com${analysisHeaderPath(matchId, "cn")}`,
    `https://live.titan007.com${analysisHeaderPath(matchId, "cn")}`,
  ];
  for (const url of urls) {
    try {
      const buffer = await fetchTitanUrlBuffer(url, headers, 1, 10_000);
      const score = parseTitanAnalysisHeader(new TextDecoder("utf-8").decode(buffer));
      if (score?.id === matchId) return { ...score, source: "titan_analysis_header", observedAt };
    } catch {
      continue;
    }
  }
  return null;
}

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

function jsonNoStore(body: unknown, init?: { status?: number }) {
  return NextResponse.json(body, { ...init, headers: NO_STORE_HEADERS });
}

// Parse allCompOdds from /analysis/odds/{id}.htm
// The page contains: <input type='hidden' value='DATA'>
// Format: companyId;companyName;initOdds;liveOdds;runOdds;flags^companyId;...
// Each odds string: euroHome,euroDraw,euroAway,euroAsianHome,euroAsianLine,euroAsianAway,skip,asianHome,asianLine,asianAway,skip,totalOver,totalLine,totalUnder
interface ParsedCompanyOdds {
  companyId: string;
  companyName: string;
  // Initial odds
  euroHomeInit: string; euroDrawInit: string; euroAwayInit: string;
  euroAsianHomeInit: string; euroAsianLineInit: string; euroAsianAwayInit: string;
  asianHomeInit: string; asianLineInit: string; asianAwayInit: string;
  totalOverInit: string; totalLineInit: string; totalUnderInit: string;
  // Live odds
  euroHomeLive: string; euroDrawLive: string; euroAwayLive: string;
  euroAsianHomeLive: string; euroAsianLineLive: string; euroAsianAwayLive: string;
  asianHomeLive: string; asianLineLive: string; asianAwayLive: string;
  totalOverLive: string; totalLineLive: string; totalUnderLive: string;
}

function parseOddsString(s: string): {
  euroHome: string; euroDraw: string; euroAway: string;
  euroAsianHome: string; euroAsianLine: string; euroAsianAway: string;
  asianHome: string; asianLine: string; asianAway: string;
  totalOver: string; totalLine: string; totalUnder: string;
} {
  const parts = s.split(",");
  if (parts.length < 14) {
    return { euroHome: "", euroDraw: "", euroAway: "", euroAsianHome: "", euroAsianLine: "", euroAsianAway: "", asianHome: "", asianLine: "", asianAway: "", totalOver: "", totalLine: "", totalUnder: "" };
  }
  return {
    euroHome: parts[0] || "", euroDraw: parts[1] || "", euroAway: parts[2] || "",
    euroAsianHome: parts[3] || "", euroAsianLine: parts[4] || "", euroAsianAway: parts[5] || "",
    asianHome: parts[7] || "", asianLine: parts[8] || "", asianAway: parts[9] || "",
    totalOver: parts[11] || "", totalLine: parts[12] || "", totalUnder: parts[13] || "",
  };
}

function parseAllCompOdds(html: string): ParsedCompanyOdds[] {
  // Find the first <input type='hidden' value='...'> which contains allCompOdds
  const match = html.match(/<input\s+type=['"]hidden['"]\s+value=['"]([^"']+)['"]/);
  if (!match) {
    const altMatch = html.match(/value=['"]([^"']+)['"]/);
    if (!altMatch) return [];
    return parseCompOddsData(altMatch[1]);
  }
  return parseCompOddsData(match[1]);
}

function parseCompOddsData(data: string): ParsedCompanyOdds[] {
  const result: ParsedCompanyOdds[] = [];
  const companies = data.split("^");
  for (const comp of companies) {
    const parts = comp.split(";");
    if (parts.length < 3) continue;
    const companyId = parts[0];
    const companyName = parts[1];
    const initStr = parts[2];
    const liveStr = parts.length > 3 ? parts[3] : "";

    const init = parseOddsString(initStr);
    const live = parseOddsString(liveStr);

    // CRITICAL FIX: /analysis/odds/ endpoint's Asian handicap line field does NOT
    // distinguish "让" (home gives) vs "受" (home receives). The line value like
    // "半球" could mean either 主让0.5 or 主受0.5. We must use European odds
    // to determine direction: euroHome > euroAway → away is favorite → 主受(受让)
    // Apply this fix to init AND live line values for: asianLine, euroAsianLine, totalLine

    const fixedInit = fixHandicapDirection(init);
    const fixedLive = fixHandicapDirection(live);

    result.push({
      companyId, companyName,
      euroHomeInit: fixedInit.euroHome, euroDrawInit: fixedInit.euroDraw, euroAwayInit: fixedInit.euroAway,
      euroAsianHomeInit: fixedInit.euroAsianHome, euroAsianLineInit: fixedInit.euroAsianLine, euroAsianAwayInit: fixedInit.euroAsianAway,
      asianHomeInit: fixedInit.asianHome, asianLineInit: fixedInit.asianLine, asianAwayInit: fixedInit.asianAway,
      totalOverInit: fixedInit.totalOver, totalLineInit: fixedInit.totalLine, totalUnderInit: fixedInit.totalUnder,
      euroHomeLive: fixedLive.euroHome, euroDrawLive: fixedLive.euroDraw, euroAwayLive: fixedLive.euroAway,
      euroAsianHomeLive: fixedLive.euroAsianHome, euroAsianLineLive: fixedLive.euroAsianLine, euroAsianAwayLive: fixedLive.euroAsianAway,
      asianHomeLive: fixedLive.asianHome, asianLineLive: fixedLive.asianLine, asianAwayLive: fixedLive.asianAway,
      totalOverLive: fixedLive.totalOver, totalLineLive: fixedLive.totalLine, totalUnderLive: fixedLive.totalUnder,
    });
  }
  return result;
}

/**
 * Fix handicap direction based on European odds.
 * /analysis/odds/ endpoint's line values (e.g., "半球") don't indicate 让/受 direction.
 * If euroHome > euroAway → away team is favorite → line should have "受" prefix (主受).
 * If euroHome < euroAway → home team is favorite → line is 主让 (no prefix needed).
 * If euroHome ≈ euroAway → 平手, no change needed.
 * 
 * This applies to: asianLine, euroAsianLine (handicap lines)
 * Total lines (大小球) are always positive, no direction fix needed.
 */
function fixHandicapDirection(odds: {
  euroHome: string; euroDraw: string; euroAway: string;
  euroAsianHome: string; euroAsianLine: string; euroAsianAway: string;
  asianHome: string; asianLine: string; asianAway: string;
  totalOver: string; totalLine: string; totalUnder: string;
}): typeof odds {
  const euroHome = parseFloat(odds.euroHome);
  const euroAway = parseFloat(odds.euroAway);
  
  // If we can't determine direction from euro odds, return as-is
  if (isNaN(euroHome) || isNaN(euroAway)) return odds;
  
  const isAwayFavorite = euroHome > euroAway;
  
  // Only fix lines that don't already have "受" or "受让" prefix
  // and are not "平手" (which has no direction)
  const fixLine = (line: string): string => {
    if (!line || line === "平手") return line;
    // Strip * prefix first (初盘标记)
    const cleanLine = line.replace(/^\*/, "");
    const hasStar = line.startsWith("*");
    const prefix = hasStar ? "*" : "";
    
    // Already has direction marker - no fix needed
    if (cleanLine.startsWith("受") || cleanLine.startsWith("受让")) return line;
    
    // If away is favorite, this line means 主受(away gives)
    if (isAwayFavorite) {
      return prefix + "受" + cleanLine;
    }
    // Home is favorite, line is correct (主让)
    return line;
  };

  return {
    ...odds,
    asianLine: fixLine(odds.asianLine),
    euroAsianLine: fixLine(odds.euroAsianLine),
    // Total lines don't need direction fix (always positive)
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: matchId } = await params;
    const { searchParams } = new URL(request.url);
    const companyIds = searchParams.get("companies") || "";
    const detailScore = await fetchMatchDetailScore(matchId);
    if (detailScore?.matchDate) {
      persistScheduleResults(
        getSupabaseClient(),
        [detailScore as unknown as Record<string, unknown>],
        { scoreSource: detailScore.source, observedAt: detailScore.observedAt, finishedOnly: true },
      ).catch(error => console.error("[MatchAPI] Score persistence error:", error instanceof Error ? error.message : error));
    }

    // Fetch the odds iframe page which contains allCompOdds with euro-asian data
    const html = await fetchUrl(`https://zq.titan007.com/analysis/odds/${matchId}.htm`);
    if (!html || html.length < 100) {
      return jsonNoStore({ success: false, error: "无法获取赔率数据", score: detailScore }, { status: 404 });
    }

    const allOdds = parseAllCompOdds(html);
    if (allOdds.length === 0) {
      return jsonNoStore({ success: false, error: "无赔率数据", score: detailScore }, { status: 404 });
    }
    const sourceObservedAt = new Date().toISOString();

    const requestedIds = companyIds ? companyIds.split(",") : null;

    const companies = allOdds
      .filter(c => !requestedIds || requestedIds.includes(c.companyId))
      .map(c => ({
        companyId: c.companyId,
        companyName: resolveCompanyName(c.companyName),
        openTime: "",
        // Full-time Asian handicap initial (from website's 实际最新亚盘)
        ftHandicapHome: c.asianHomeInit,
        ftHandicapLine: c.asianLineInit,
        ftHandicapAway: c.asianAwayInit,
        ftHandicapHomeLive: c.asianHomeLive,
        ftHandicapLineLive: c.asianLineLive,
        ftHandicapAwayLive: c.asianAwayLive,
        // European odds initial
        euroHome: c.euroHomeInit,
        euroDraw: c.euroDrawInit,
        euroAway: c.euroAwayInit,
        euroHomeLive: c.euroHomeLive,
        euroDrawLive: c.euroDrawLive,
        euroAwayLive: c.euroAwayLive,
        // Euro-to-Asian initial (from website's 欧转亚盘 - NOT calculated, from original data)
        euroAsianHome: c.euroAsianHomeInit,
        euroAsianLine: c.euroAsianLineInit,
        euroAsianAway: c.euroAsianAwayInit,
        // Total goals initial
        ftTotalOver: c.totalOverInit,
        ftTotalLine: c.totalLineInit,
        ftTotalUnder: c.totalUnderInit,
        ftTotalOverLive: c.totalOverLive,
        ftTotalLineLive: c.totalLineLive,
        ftTotalUnderLive: c.totalUnderLive,
      }));

    // Crown (companyId=3) initial data at match level
    const crown = allOdds.find(c => c.companyId === "3");

    return jsonNoStore({
      success: true,
      source: "titan-analysis-odds",
      sourceObservedAt,
      score: detailScore,
      data: {
        matchId,
        openTime: "",
        companies,
        // Crown initial data at match level for convenience
        crownInitHomeOdds: crown?.asianHomeInit || "",
        crownInitHandicapLine: crown?.asianLineInit || "",
        crownInitAwayOdds: crown?.asianAwayInit || "",
        crownInitTotalLine: crown?.totalLineInit || "",
        crownInitOverOdds: crown?.totalOverInit || "",
        crownInitUnderOdds: crown?.totalUnderInit || "",
        crownInitEuroAsianHome: crown?.euroAsianHomeInit || "",
        crownInitEuroAsianLine: crown?.euroAsianLineInit || "",
        crownInitEuroAsianAway: crown?.euroAsianAwayInit || "",
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "抓取失败";
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
    console.error("[MatchAPI] Error:", msg, cause);
    return jsonNoStore({ error: msg }, { status: 500 });
  }
}
