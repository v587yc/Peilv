import { NextResponse } from "next/server";
import { fetchTitanUrlBuffer } from "@/lib/titan-vip-fetch";

const DATA_BASE_URL = "https://livestatic.titan007.com/vbsxml";
const REFERER = "https://live.titan007.com/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const headers: Record<string, string> = {
  Referer: REFERER,
  "User-Agent": UA,
  Accept: "*/*",
};

// GoalCn2 mapping: index -> handicap string
const GOAL_CN2 = [
  "0", "0/0.5", "0.5", "0.5/1", "1", "1/1.5", "1.5", "1.5/2", "2", "2/2.5",
  "2.5", "2.5/3", "3", "3/3.5", "3.5", "3.5/4", "4", "4/4.5", "4.5",
  "4.5/5", "5", "5/5.5", "5.5", "5.5/6", "6", "6/6.5", "6.5", "6.5/7", "7",
  "7/7.5", "7.5", "7.5/8", "8", "8/8.5", "8.5", "8.5/9", "9", "9/9.5",
  "9.5", "9.5/10", "10",
];

function goalToDisplay(goal: number | string): string {
  if (goal === "" || goal === undefined || goal === null) return "";
  const g = Number(goal);
  if (isNaN(g)) return String(goal);
  if (g > 10 || g < -10) return g + "球";
  const absG = Math.abs(g);
  const idx = Math.round(absG * 4);
  if (idx >= 0 && idx < GOAL_CN2.length) {
    return g < 0 ? "受" + GOAL_CN2[idx] : GOAL_CN2[idx];
  }
  return String(g);
}

interface MatchData {
  id: string;
  league: string;
  leagueColor: string;
  time: string;
  homeTeam: string;
  awayTeam: string;
  homeRank: string;
  awayRank: string;
  state: string;
  homeScore: string;
  awayScore: string;
  handicap: string;
  handicapRaw: number;
  homeOdds: string;
  awayOdds: string;
  totalLine: string;
  totalLineRaw: number;
  overOdds: string;
  underOdds: string;
  initialHandicap: string;
  initialTotalLine: string;
  sclassId: string;
  matchDate: string;
  orderIndex: number;
  isHot: boolean; // A[i][62] == "1" = hot match (simplified schedule)
}

interface LeagueData {
  id: string;
  name: string;
  color: string;
  count: number;
  isHot: boolean; // B[j][10] != "0" = important/hot league
}

async function fetchWithHeaders(url: string): Promise<string> {
  const buffer = await fetchTitanUrlBuffer(url, headers, 2, 15_000);
  return new TextDecoder("utf-8").decode(buffer);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

// Extract ranking from HTML team name, e.g. "队名<font...>[3]</font>" → "3"
function extractRankFromField(field: string): string {
  if (!field) return "";
  // Field format like "土超7", "英超3", "意甲20" — extract trailing digits
  const match = field.match(/(\d+)$/);
  return match ? match[1] : "";
}

// Strip HTML and remove ranking bracket from team name (for schedule HTML)
function stripTeamName(html: string): string {
  const text = stripHtml(html);
  // Remove trailing [rank] bracket
  return text.replace(/\[[^\]]+\]\s*$/, "").trim();
}

function parseMatchData(jsText: string): {
  matches: MatchData[];
  leagues: LeagueData[];
  hotMatchCount: number;
} {
  const matches: MatchData[] = [];
  const leagueMap = new Map<string, LeagueData>();

  // Parse B array to identify hot/important leagues
  // B[j][10] != "0" means important/hot league
  // B[j][4] = sclassId, B[j][0] = league name
  // Note: league.isHot is based on ALL matches (not just state==0),
  // because hot/important is a league property, not a match state filter.
  const hotLeagueIds = new Set<string>();
  const bRegex = /B\[(\d+)\]="([^"]+)"/g;
  let bMatch;
  while ((bMatch = bRegex.exec(jsText)) !== null) {
    const fields = bMatch[2].split("^");
    if (fields.length > 10 && fields[10] !== "0") {
      const sclassId = fields[4] || "";
      if (sclassId) hotLeagueIds.add(sclassId);
    }
  }

  // Count ALL matches per sclassId (regardless of state) for accurate league counts
  // Also count total hot matches (A[i][62]==1) across ALL states
  const leagueAllCountMap = new Map<string, number>();
  let hotMatchTotal = 0;
  const allARegex = /A\[(\d+)\]="([^"]+)"/g;
  let allAMatch;
  while ((allAMatch = allARegex.exec(jsText)) !== null) {
    const fields = allAMatch[2].split("^");
    if (fields.length < 46) continue;
    const sclassId = fields[45] || "";
    if (sclassId) {
      leagueAllCountMap.set(sclassId, (leagueAllCountMap.get(sclassId) || 0) + 1);
    }
    // Count hot matches (A[i][62]==1) regardless of state
    if (fields.length > 62 && fields[62] === "1") {
      hotMatchTotal++;
    }
  }

  // Extract A array entries
  const aRegex = /A\[(\d+)\]="([^"]+)"/g;
  let match;

  // Extract global vars
  const matchdateMatch = jsText.match(/matchdate="([^"]+)"/);
  const matchdate = matchdateMatch ? matchdateMatch[1] : "";

  let orderIdx = 0;

  while ((match = aRegex.exec(jsText)) !== null) {
    const fields = match[2].split("^");
    if (fields.length < 14) continue;

    const state = fields[13];
    // Include all matches regardless of state
    // Frontend handles display filtering (not-started at top, finished at bottom)

    const id = fields[0];
    const color = fields[1];
    const league = stripHtml(fields[2]); // CN name
    const homeTeamHtml = fields[5];
    const awayTeamHtml = fields[8];
    const homeTeam = stripTeamName(homeTeamHtml); // CN name
    const awayTeam = stripTeamName(awayTeamHtml); // CN name
    // Rank data is in fields[22] (home) and fields[23] (away), format like "土超7"
    const homeRank = extractRankFromField(fields[22] || "");
    const awayRank = extractRankFromField(fields[23] || "");
    const time = fields[11];
    const sclassId = fields[45] || "";
    // A[i][62] == "1" means this match is in the simplified/hot schedule
    const isHotMatch = fields[62] === "1";

    const matchData: MatchData = {
      id,
      league,
      leagueColor: color,
      time,
      homeTeam,
      awayTeam,
      homeRank,
      awayRank,
      state,
      homeScore: "0",
      awayScore: "0",
      handicap: "",
      handicapRaw: 0,
      homeOdds: "",
      awayOdds: "",
      totalLine: "",
      totalLineRaw: 0,
      overOdds: "",
      underOdds: "",
      initialHandicap: "",
      initialTotalLine: "",
      sclassId,
      matchDate: matchdate,
      orderIndex: orderIdx++,
      isHot: isHotMatch,
    };

    matches.push(matchData);

    // Build league map
    if (league) {
      const existing = leagueMap.get(league);
      if (existing) {
        existing.count++;
      } else {
        leagueMap.set(league, {
          id: sclassId,
          name: league,
          color,
          count: 1,
          isHot: hotLeagueIds.has(sclassId),
        });
      }
    }
  }

  return {
    matches,
    leagues: Array.from(leagueMap.values()).sort((a, b) => b.count - a.count),
    hotMatchCount: hotMatchTotal,
  };
}

function parseOddsData(xmlText: string, matches: MatchData[]): void {
  // Parse the XML odds data
  const mRegex = /<m>([^<]+)<\/m>/g;
  let m;

  const matchMap = new Map<string, MatchData>();
  for (const m of matches) {
    matchMap.set(m.id, m);
  }

  while ((m = mRegex.exec(xmlText)) !== null) {
    const fields = m[1].split(",");
    if (fields.length < 13) continue;

    const matchId = fields[0];
    const matchData = matchMap.get(matchId);
    if (!matchData) continue;

    // Handicap (让球)
    const handicapRaw = parseFloat(fields[2]);
    if (!isNaN(handicapRaw)) {
      matchData.handicapRaw = handicapRaw;
      matchData.handicap = goalToDisplay(handicapRaw);
    }

    // Home/Away odds for handicap
    matchData.homeOdds = fields[3] || "";
    matchData.awayOdds = fields[4] || "";

    // Total line (大小球)
    const totalRaw = parseFloat(fields[10]);
    if (!isNaN(totalRaw)) {
      matchData.totalLineRaw = totalRaw;
      matchData.totalLine = goalToDisplay(totalRaw);
    }

    // Over/Under odds
    matchData.overOdds = fields[11] || "";
    matchData.underOdds = fields[12] || "";

    // Initial handicap and total (fields 35, 36)
    if (fields.length > 36) {
      const initH = parseFloat(fields[35]);
      if (!isNaN(initH)) {
        matchData.initialHandicap = goalToDisplay(initH);
      }
      const initT = parseFloat(fields[36]);
      if (!isNaN(initT)) {
        matchData.initialTotalLine = goalToDisplay(initT);
      }
    }
  }
}

export async function GET(request: Request) {
  try {
    // searchParams available for future use (e.g. filtering by date)
    void new URL(request.url).searchParams;
    const timestamp = Date.now();

    // Fetch Titan resources sequentially to minimize upstream request concurrency.
    const matchJsText = await fetchWithHeaders(`${DATA_BASE_URL}/bfdata_ut.js?r=007${timestamp}`);
    const oddsXmlText = await fetchWithHeaders(`${DATA_BASE_URL}/goalBf3.xml?r=007${timestamp}`);

    const { matches, leagues, hotMatchCount } = parseMatchData(matchJsText);
    parseOddsData(oddsXmlText, matches);

    return NextResponse.json({
      success: true,
      data: {
        matches,
        leagues,
        hotMatchCount,
        matchDate: matches.length > 0 ? matches[0].matchDate : "",
        timestamp,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Failed to fetch odds data:", message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
