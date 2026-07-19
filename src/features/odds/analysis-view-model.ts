import { HANDICAP_MAP } from "./constants";
import type {
  AnalysisResultData,
  CompanyOddsItem,
  LatestOddsDisplay,
  MatchData,
  ParsedCrownHandicap,
  PredictionComparison,
  PredictionData,
} from "./contracts";

export function parseCrownHandicap(str: string): ParsedCrownHandicap | null {
  if (!str) return null;

  const match = str.trim().match(/^([\d.]+)\s+(受让)?(.+?)\s+([\d.]+)$/);
  if (!match) return null;

  const homeOdds = parseFloat(match[1]);
  const isReceiving = Boolean(match[2]);
  const handicapText = match[3].trim();
  const awayOdds = parseFloat(match[4]);
  let handicapValue = HANDICAP_MAP[handicapText];

  if (handicapValue === undefined) {
    handicapValue = parseFloat(handicapText);
    if (isNaN(handicapValue)) return null;
  }

  if (isReceiving) handicapValue = -handicapValue;
  return { homeOdds, awayOdds, handicapValue };
}

function oddsValue(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized) return normalized;
  }
  return "";
}

export function getCompanyLatestOdds(company: CompanyOddsItem) {
  return {
    handicapHome: oddsValue(company.ftHandicapHomeLive, company.ftHandicapHome),
    handicapLine: oddsValue(company.ftHandicapLineLive, company.ftHandicapLine),
    handicapAway: oddsValue(company.ftHandicapAwayLive, company.ftHandicapAway),
    totalOver: oddsValue(company.ftTotalOverLive, company.ftTotalOver),
    totalLine: oddsValue(company.ftTotalLineLive, company.ftTotalLine),
    totalUnder: oddsValue(company.ftTotalUnderLive, company.ftTotalUnder),
    hasLive: Boolean(company.ftHandicapLineLive || company.ftTotalLineLive),
  };
}

export function getMatchLatestOdds(
  match: MatchData,
  crownCompany?: CompanyOddsItem,
): LatestOddsDisplay {
  if (crownCompany) {
    const latest = getCompanyLatestOdds(crownCompany);
    if (latest.handicapLine || latest.totalLine) {
      return {
        handicapHome: oddsValue(latest.handicapHome, match.homeOdds),
        handicapLine: oddsValue(latest.handicapLine, match.handicap),
        handicapAway: oddsValue(latest.handicapAway, match.awayOdds),
        totalOver: oddsValue(latest.totalOver, match.overOdds),
        totalLine: oddsValue(latest.totalLine, match.totalLine),
        totalUnder: oddsValue(latest.totalUnder, match.underOdds),
        source: latest.hasLive ? "旧页即时" : "旧页初盘",
        isCrownLatest: true,
      };
    }
  }

  return {
    handicapHome: match.homeOdds,
    handicapLine: match.handicap,
    handicapAway: match.awayOdds,
    totalOver: match.overOdds,
    totalLine: match.totalLine,
    totalUnder: match.underOdds,
    source: "即时",
    isCrownLatest: false,
  };
}

export function buildPurchaseAdvice(
  analysis: AnalysisResultData,
  odds: LatestOddsDisplay,
): { handicap: string; total: string; title: string } {
  const handicapOdds = analysis.prediction === "主"
    ? odds.handicapHome
    : analysis.prediction === "客"
      ? odds.handicapAway
      : "";
  const handicap = analysis.prediction === "主" || analysis.prediction === "客"
    ? `建议买${analysis.prediction}${odds.handicapLine ? `（${odds.handicapLine}${handicapOdds ? ` @ ${handicapOdds}` : ""}）` : ""}`
    : "建议观望";
  const totalOdds = analysis.totalPrediction === "大"
    ? odds.totalOver
    : analysis.totalPrediction === "小"
      ? odds.totalUnder
      : "";
  const total = analysis.totalPrediction === "大" || analysis.totalPrediction === "小"
    ? `大小球买${analysis.totalPrediction}${odds.totalLine ? `（${odds.totalLine}${totalOdds ? ` @ ${totalOdds}` : ""}）` : ""}`
    : "大小球观望";

  return {
    handicap,
    total,
    title: `${handicap}；${total}；信心${analysis.confidenceLevel} ${analysis.accuracy}`,
  };
}

export function computePredictionComparison(
  pred: PredictionData,
  liveHomeOdds: string,
  liveAwayOdds: string,
  liveHandicapRaw: number,
): PredictionComparison | null {
  let crown = parseCrownHandicap(pred.crown_handicap);

  if (!crown) {
    const predAny = pred as unknown as Record<string, unknown>;
    const handicapText = pred.crown_handicap || (predAny.handicap as string) || "";
    const homeOdds = (predAny.home_odds as number) || 0;
    const awayOdds = (predAny.away_odds as number) || 0;
    if (!handicapText || (!homeOdds && !awayOdds)) return null;

    let handicapValue = HANDICAP_MAP[handicapText];
    if (handicapValue === undefined) {
      handicapValue = parseFloat(handicapText);
      if (isNaN(handicapValue)) return null;
    }
    if (/受让/.test(handicapText)) handicapValue = -handicapValue;
    crown = { homeOdds, awayOdds, handicapValue };
  }

  const predictedSide: "home" | "away" = (pred.prediction || "").includes("主")
    ? "home"
    : "away";
  let oddsDiff: number | null = null;
  const liveHome = parseFloat(liveHomeOdds);
  const liveAway = parseFloat(liveAwayOdds);

  if (predictedSide === "home" && !isNaN(liveHome) && crown.homeOdds) {
    oddsDiff = parseFloat((liveHome - crown.homeOdds).toFixed(2));
  } else if (predictedSide === "away" && !isNaN(liveAway) && crown.awayOdds) {
    oddsDiff = parseFloat((liveAway - crown.awayOdds).toFixed(2));
  }

  let handicapChange: "升" | "降" | null = null;
  if (!isNaN(liveHandicapRaw)) {
    const diff = parseFloat((liveHandicapRaw - crown.handicapValue).toFixed(2));
    if (diff !== 0) {
      handicapChange = crown.handicapValue < 0
        ? diff < 0 ? "升" : "降"
        : diff > 0 ? "升" : "降";
    }
  }

  return {
    oddsDiff,
    handicapChange,
    predictedSide,
    action: pred.action || predAnyAction(pred),
  };
}

function predAnyAction(pred: PredictionData): string {
  return ((pred as unknown as Record<string, unknown>).action as string) || "";
}
