import { NextRequest, NextResponse } from "next/server";
import { fetchTitanUrlBuffer } from "@/lib/titan-vip-fetch";

// Increase max duration for this API route since it fetches multiple pages
export const maxDuration = 120;

// Abbreviated name → full name mapping (from website data like "Crow*" → "皇冠")
const ABBR_TO_FULL: Record<string, string> = {
  "澳": "澳门", "Crow": "皇冠", "盈": "盈禾", "18": "18博",
  "易": "易胜博", "平": "平博", "36": "36bet", "明": "明升",
  "伟": "伟德", "利": "利记", "12": "12BET", "1x": "1xbet",
  "金宝": "金宝博", "10B": "10BET", "必发": "必发", "Bet365": "Bet365",
  "沙巴": "沙巴", "立博": "立博", "5D": "5Dimes", "必赢": "必赢",
};

function resolveCompanyName(abbrName: string): string {
  const clean = abbrName.replace(/\*+$/, "");
  for (const [prefix, fullName] of Object.entries(ABBR_TO_FULL)) {
    if (clean.startsWith(prefix) || clean === prefix) return fullName;
  }
  return clean;
}

const FETCH_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://zq.titan007.com/",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

async function fetchUrl(url: string, retries = 2): Promise<string> {
  const buffer = await fetchTitanUrlBuffer(url, FETCH_HEADERS, retries, 20_000);
  return new TextDecoder("utf-8").decode(buffer);
}

type ParsedOddsString = {
  euroHome: string; euroDraw: string; euroAway: string;
  euroAsianHome: string; euroAsianLine: string; euroAsianAway: string;
  asianHome: string; asianLine: string; asianAway: string;
  totalOver: string; totalLine: string; totalUnder: string;
};

// Parse odds string from allCompOdds
function parseOddsString(s: string): ParsedOddsString {
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

function fixHandicapDirection(odds: ParsedOddsString): ParsedOddsString {
  const euroHome = parseFloat(odds.euroHome);
  const euroAway = parseFloat(odds.euroAway);
  if (isNaN(euroHome) || isNaN(euroAway)) return odds;

  const isAwayFavorite = euroHome > euroAway;
  const fixLine = (line: string): string => {
    if (!line || line === "平手") return line;
    const cleanLine = line.replace(/^\*/, "");
    if (cleanLine.startsWith("受") || cleanLine.startsWith("受让")) return line;
    return isAwayFavorite ? `${line.startsWith("*") ? "*" : ""}受${cleanLine}` : line;
  };

  return {
    ...odds,
    asianLine: fixLine(odds.asianLine),
    euroAsianLine: fixLine(odds.euroAsianLine),
  };
}

// Parse allCompOdds from /analysis/odds/{id}.htm
function parseAllCompOdds(html: string) {
  const match = html.match(/<input\s+type=['"]hidden['"]\s+value=['"]([^"']+)['"]/);
  if (!match) {
    const altMatch = html.match(/value=['"]([^"']+)['"]/);
    if (!altMatch) return [];
    return parseCompOddsData(altMatch[1]);
  }
  return parseCompOddsData(match[1]);
}

function parseCompOddsData(data: string) {
  const result: Array<{
    companyId: string; companyName: string;
    init: ReturnType<typeof parseOddsString>;
    live: ReturnType<typeof parseOddsString>;
  }> = [];

  const companies = data.split("^");
  for (const comp of companies) {
    const parts = comp.split(";");
    if (parts.length < 3) continue;
    const companyId = parts[0];
    const companyName = parts[1];
    const initStr = parts[2];
    const liveStr = parts.length > 3 ? parts[3] : "";

    result.push({
      companyId,
      companyName,
      init: fixHandicapDirection(parseOddsString(initStr)),
      live: fixHandicapDirection(parseOddsString(liveStr)),
    });
  }
  return result;
}

// Fetch match data from existing odds API
interface MatchListItem { id: string; state: string; [key: string]: unknown }
async function fetchMatchList(): Promise<MatchListItem[]> {
  const baseUrl = process.env.DEPLOY_RUN_PORT ? `http://localhost:${process.env.DEPLOY_RUN_PORT}` : "http://localhost:5000";
  const res = await fetch(`${baseUrl}/api/odds`);
  const data = await res.json();
  return data?.data?.matches || [];
}

// Fetch and parse a single match's odds from /analysis/odds/{id}.htm
async function fetchMatchOdds(matchId: string, companyIds: string[]) {
  try {
    const html = await fetchUrl(`https://zq.titan007.com/analysis/odds/${matchId}.htm`);
    if (!html || html.length < 100) return null;

    const allOdds = parseAllCompOdds(html);
    if (allOdds.length === 0) return null;

    const companies = allOdds
      .filter(c => companyIds.includes(c.companyId))
      .map(c => ({
        companyId: c.companyId,
        companyName: resolveCompanyName(c.companyName),
        openTime: "",
        ftHandicapHome: c.init.asianHome,
        ftHandicapLine: c.init.asianLine,
        ftHandicapAway: c.init.asianAway,
        ftHandicapHomeLive: c.live.asianHome,
        ftHandicapLineLive: c.live.asianLine,
        ftHandicapAwayLive: c.live.asianAway,
        euroHome: c.init.euroHome,
        euroDraw: c.init.euroDraw,
        euroAway: c.init.euroAway,
        euroHomeLive: c.live.euroHome,
        euroDrawLive: c.live.euroDraw,
        euroAwayLive: c.live.euroAway,
        euroAsianHome: c.init.euroAsianHome,
        euroAsianLine: c.init.euroAsianLine,
        euroAsianAway: c.init.euroAsianAway,
        ftTotalOver: c.init.totalOver,
        ftTotalLine: c.init.totalLine,
        ftTotalUnder: c.init.totalUnder,
        ftTotalOverLive: c.live.totalOver,
        ftTotalLineLive: c.live.totalLine,
        ftTotalUnderLive: c.live.totalUnder,
      }));

    const crown = allOdds.find(c => c.companyId === "3");
    return {
      matchId,
      openTime: "",
      companies,
      crownInitHomeOdds: crown?.init.asianHome || "",
      crownInitHandicapLine: crown?.init.asianLine || "",
      crownInitAwayOdds: crown?.init.asianAway || "",
      crownInitTotalLine: crown?.init.totalLine || "",
      crownInitOverOdds: crown?.init.totalOver || "",
      crownInitUnderOdds: crown?.init.totalUnder || "",
      crownInitEuroAsianHome: crown?.init.euroAsianHome || "",
      crownInitEuroAsianLine: crown?.init.euroAsianLine || "",
      crownInitEuroAsianAway: crown?.init.euroAsianAway || "",
    };
  } catch (err) {
    console.error(`[data/matches] Error fetching match ${matchId}:`, err);
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const requestedLimit = Number.parseInt(searchParams.get("limit") || "10", 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 10;
    const companyIdsStr = searchParams.get("companies") || "3,35,42,47,8";
    const companyIds = companyIdsStr.split(",");

    // Step 1: Get today's match list from existing odds API
    const matches = await fetchMatchList();

    // Filter to only upcoming matches (state === "0")
    const upcomingMatches = matches.filter((m: MatchListItem) => String(m.state) === "0");

    // Take first N matches
    const targetMatches = upcomingMatches.slice(0, limit);

    if (targetMatches.length === 0) {
      return NextResponse.json({ success: true, data: [], message: "没有未开赛赛事" });
    }

    // Step 2: Fetch odds data for each match (with concurrency limit)
    interface MatchOddsResult { matchId: string; companies: unknown[]; [key: string]: unknown }
    const results: MatchOddsResult[] = [];
    const batchSize = 1;

    for (let i = 0; i < targetMatches.length; i += batchSize) {
      const batch = targetMatches.slice(i, i + batchSize);
      const promises = batch.map(async (match: MatchListItem) => {
        const data = await fetchMatchOdds(String(match.id), companyIds);
        if (data && data.companies.length > 0) {
          return data;
        }
        return null;
      });

      const batchResults = await Promise.all(promises);
      for (const result of batchResults) {
        if (result) results.push(result);
      }

      // Small delay between batches
      if (i + batchSize < targetMatches.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return NextResponse.json({
      success: true,
      data: results,
      total: results.length,
      requested: targetMatches.length,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "抓取失败";
    console.error("[data/matches] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
