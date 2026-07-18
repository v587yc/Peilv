export type AutomaticVerificationStatus = "pending" | "invalid" | "correct" | "wrong";
export type VerificationStatus = AutomaticVerificationStatus | "manual";
export type PredictionMarket = "handicap" | "total";
export type SettlementOutcome =
  | "win"
  | "half_win"
  | "push"
  | "half_loss"
  | "loss"
  | "pending"
  | "invalid"
  | "void"
  | "legacy_unknown";

export interface ScoreSettlementInput {
  market: PredictionMarket;
  prediction: unknown;
  line: unknown;
  homeScore: unknown;
  awayScore: unknown;
  specialStatus?: "void" | "legacy_unknown" | null;
}

export interface SettlementSummary {
  eligible: number;
  weightedCorrect: number;
  weightedWrong: number;
  weightedTotal: number;
  weightedAccuracy: number | null;
  counts: Record<SettlementOutcome, number>;
  scoredCounts: Record<"win" | "half_win" | "push" | "half_loss" | "loss", number>;
  nonScoringCounts: Record<"pending" | "invalid" | "void" | "legacy_unknown", number>;
}

export interface MatchOddsInput {
  odds_data?: unknown;
  crown_12_odds?: unknown;
  crown_live_odds?: unknown;
}

export interface WaterVerificationResult {
  status: AutomaticVerificationStatus;
  autoIsCorrect: boolean | null;
  actualHandicapTrend: string | null;
  actualWaterDirection: string | null;
  initHandicapLine: string;
  liveHandicapLine: string;
  initHandicapValue: number | null;
  liveHandicapValue: number | null;
  reason: string | null;
}

export interface EffectiveVerificationResult {
  status: VerificationStatus;
  isCorrect: boolean | null;
  source: "manual" | "auto" | null;
}

const HANDICAP_MAP: Record<string, number> = {
  "平手": 0, "平": 0, "0": 0,
  "平手/半球": 0.25, "平/半": 0.25, "0/0.5": 0.25,
  "半球": 0.5, "半": 0.5, "0.5": 0.5,
  "半球/一球": 0.75, "半/一": 0.75, "0.5/1": 0.75,
  "一球": 1, "一": 1, "1": 1,
  "一球/球半": 1.25, "一/球半": 1.25, "1/1.5": 1.25,
  "球半": 1.5, "一球半": 1.5, "1.5": 1.5,
  "球半/两球": 1.75, "球半/两": 1.75, "1.5/2": 1.75,
  "两球": 2, "两": 2, "2": 2,
  "两球/两球半": 2.25, "两/两球半": 2.25, "2/2.5": 2.25,
  "两球半": 2.5, "2.5": 2.5,
  "两球半/三球": 2.75, "两球半/三": 2.75, "2.5/3": 2.75,
  "三球": 3, "三": 3, "3": 3,
  "三球/三球半": 3.25, "三/三球半": 3.25, "3/3.5": 3.25,
  "三球半": 3.5, "3.5": 3.5,
  "三球半/四球": 3.75, "3.5/4": 3.75,
  "四球": 4, "四": 4, "4": 4,
  "四球/四球半": 4.25, "4/4.5": 4.25,
  "四球半": 4.5, "4.5": 4.5,
  "五球": 5, "5": 5,
  "五球半": 5.5, "5.5": 5.5,
};

export function parseDbJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function handicapLineToNumber(line: string): number {
  if (!line) return NaN;
  const noStar = line.trim().replace(/^\*/, "");
  const isReceiving = noStar.startsWith("受让") || noStar.startsWith("受");
  const cleanLine = noStar.replace(/^受让?/, "").trim();
  const mapped = HANDICAP_MAP[cleanLine];
  if (mapped !== undefined) return isReceiving ? -mapped : mapped;

  if (cleanLine.includes("/")) {
    const parts = cleanLine.split("/");
    if (parts.length === 2) {
      const low = HANDICAP_MAP[parts[0]] ?? Number.parseFloat(parts[0]);
      const high = HANDICAP_MAP[parts[1]] ?? Number.parseFloat(parts[1]);
      if (Number.isFinite(low) && Number.isFinite(high)) {
        const value = (low + high) / 2;
        return isReceiving ? -value : value;
      }
    }
  }

  const numeric = Number.parseFloat(cleanLine);
  return Number.isFinite(numeric) ? (isReceiving ? -numeric : numeric) : NaN;
}

export function splitQuarterLine(line: number): [number] | [number, number] | null {
  if (!Number.isFinite(line)) return null;
  const quarterUnits = Math.round(line * 4);
  if (Math.abs(line * 4 - quarterUnits) > 1e-7) return null;
  if (Math.abs(quarterUnits) % 2 === 0) return [quarterUnits / 4];

  const lowerValue = Math.floor(quarterUnits / 2) / 2;
  const upperValue = Math.ceil(quarterUnits / 2) / 2;
  const lower = Object.is(lowerValue, -0) ? 0 : lowerValue;
  const upper = Object.is(upperValue, -0) ? 0 : upperValue;
  return [lower, upper];
}

export function splitHandicapLine(line: string | number): [number] | [number, number] | null {
  const value = typeof line === "number" ? line : handicapLineToNumber(line);
  return splitQuarterLine(value);
}

function finiteScore(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function settleLeg(value: number): "win" | "push" | "loss" {
  const normalized = Number(value.toFixed(8));
  return normalized > 0 ? "win" : normalized < 0 ? "loss" : "push";
}

export function combineSettlementLegs(
  legs: readonly ("win" | "push" | "loss")[],
): "win" | "half_win" | "push" | "half_loss" | "loss" {
  if (legs.length === 1) return legs[0];
  const wins = legs.filter(leg => leg === "win").length;
  const losses = legs.filter(leg => leg === "loss").length;
  if (wins === legs.length) return "win";
  if (losses === legs.length) return "loss";
  if (wins > 0 && losses === 0) return "half_win";
  if (losses > 0 && wins === 0) return "half_loss";
  return "push";
}

/**
 * Handicap lines are normalized from the home-team perspective: positive means
 * the home team gives goals, negative means the home team receives goals.
 */
export function settlePrediction(input: ScoreSettlementInput): SettlementOutcome {
  if (input.specialStatus === "void" || input.specialStatus === "legacy_unknown") {
    return input.specialStatus;
  }

  const homeScore = finiteScore(input.homeScore);
  const awayScore = finiteScore(input.awayScore);
  if (homeScore === null || awayScore === null) return "pending";
  if (typeof input.prediction !== "string") return "invalid";
  const prediction = input.prediction.trim();
  if (["观望", "中立", "待定", "pending"].includes(prediction)) return "pending";

  const rawLine = typeof input.line === "number"
    ? input.line
    : typeof input.line === "string"
      ? handicapLineToNumber(input.line)
      : NaN;
  const lines = splitQuarterLine(rawLine);
  if (!lines) return "invalid";

  if (input.market === "handicap") {
    if (prediction !== "主" && prediction !== "客" && prediction !== "主队" && prediction !== "客队") {
      return "invalid";
    }
    if (!Number.isSafeInteger(homeScore) || !Number.isSafeInteger(awayScore)) return "invalid";
    try {
      return calculateAsianSettlement({
        selection: prediction === "主" || prediction === "主队" ? "home" : "away",
        handicapQuarterUnits: Math.round(rawLine * 4), homeScore, awayScore,
        selectedWaterMillionths: 1_000_000,
      }).outcome;
    } catch { return "invalid"; }
  }

  if (input.market === "total") {
    if (prediction !== "大" && prediction !== "小") return "invalid";
    const total = homeScore + awayScore;
    return combineSettlementLegs(lines.map(line => settleLeg(
      prediction === "大" ? total - line : line - total,
    )));
  }

  return "invalid";
}

const SETTLEMENT_OUTCOMES: SettlementOutcome[] = [
  "win", "half_win", "push", "half_loss", "loss",
  "pending", "invalid", "void", "legacy_unknown",
];

export function summarizeSettlementOutcomes(
  outcomes: readonly SettlementOutcome[],
  manualResults: readonly boolean[] = [],
): SettlementSummary {
  const counts = Object.fromEntries(SETTLEMENT_OUTCOMES.map(outcome => [outcome, 0])) as Record<SettlementOutcome, number>;
  for (const outcome of outcomes) {
    if (Object.prototype.hasOwnProperty.call(counts, outcome)) counts[outcome] += 1;
  }

  const manualCorrect = manualResults.filter(result => result === true).length;
  const manualWrong = manualResults.filter(result => result === false).length;
  const weightedCorrect = counts.win + counts.half_win * 0.5 + manualCorrect;
  const weightedWrong = counts.loss + counts.half_loss * 0.5 + manualWrong;
  const weightedTotal = weightedCorrect + weightedWrong;

  return {
    eligible: counts.win + counts.half_win + counts.push + counts.half_loss + counts.loss,
    weightedCorrect,
    weightedWrong,
    weightedTotal,
    weightedAccuracy: weightedTotal === 0 ? null : weightedCorrect / weightedTotal,
    counts,
    scoredCounts: {
      win: counts.win,
      half_win: counts.half_win,
      push: counts.push,
      half_loss: counts.half_loss,
      loss: counts.loss,
    },
    nonScoringCounts: {
      pending: counts.pending,
      invalid: counts.invalid,
      void: counts.void,
      legacy_unknown: counts.legacy_unknown,
    },
  };
}

export function determineHandicapTrend(initLine: number, liveLine: number): "升盘" | "降盘" | "不变" | null {
  if (!Number.isFinite(initLine) || !Number.isFinite(liveLine)) return null;
  if (initLine > 0 && liveLine < 0) return "降盘";
  if (initLine < 0 && liveLine > 0) return "升盘";
  const difference = Number.parseFloat((Math.abs(liveLine) - Math.abs(initLine)).toFixed(2));
  if (difference > 0.01) return "升盘";
  if (difference < -0.01) return "降盘";
  return "不变";
}

export function determineWaterDirection(
  initial: Record<string, unknown>,
  live: Record<string, unknown>,
): "主降水" | "客降水" | "不变" | null {
  const initHome = Number.parseFloat(String(initial.handicapHome ?? ""));
  const initAway = Number.parseFloat(String(initial.handicapAway ?? ""));
  const liveHome = Number.parseFloat(String(live.handicapHome ?? ""));
  const liveAway = Number.parseFloat(String(live.handicapAway ?? ""));
  if (![initHome, initAway, liveHome, liveAway].every(Number.isFinite)) return null;

  const homeDifference = Number((liveHome - initHome).toFixed(4));
  const awayDifference = Number((liveAway - initAway).toFixed(4));
  const threshold = 0.03;
  const homeChanged = Math.abs(homeDifference) > threshold;
  const awayChanged = Math.abs(awayDifference) > threshold;

  if (!homeChanged && !awayChanged) return "不变";
  if (homeChanged && awayChanged) {
    if (homeDifference < awayDifference) return "主降水";
    if (awayDifference < homeDifference) return "客降水";
    return "不变";
  }
  if (homeChanged) return homeDifference < 0 ? "主降水" : "客降水";
  return awayDifference < 0 ? "客降水" : "主降水";
}

function getCompanies(oddsData: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(oddsData.companies)
    ? oddsData.companies.filter((company): company is Record<string, unknown> => Boolean(company) && typeof company === "object")
    : [];
}

function getString(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function verifyWaterPrediction(predictedDirection: unknown, odds: MatchOddsInput | null | undefined): WaterVerificationResult {
  const pending = (reason: string): WaterVerificationResult => ({
    status: "pending",
    autoIsCorrect: null,
    actualHandicapTrend: null,
    actualWaterDirection: null,
    initHandicapLine: "",
    liveHandicapLine: "",
    initHandicapValue: null,
    liveHandicapValue: null,
    reason,
  });

  if (!odds) return pending("缺少赔率记录");

  const oddsData = parseDbJsonObject(odds.odds_data);
  const crown12 = parseDbJsonObject(odds.crown_12_odds);
  const crownLive = parseDbJsonObject(odds.crown_live_odds);
  const companies = getCompanies(oddsData);
  const crown = companies.find(company => String(company.companyId ?? "") === "3");
  const initialCompany = crown ?? companies[0];

  const initHandicapLine = getString(crown12, "handicapLine")
    || getString(initialCompany, "ftHandicapLine")
    || getString(initialCompany, "asianLineInit");
  const liveHandicapLine = getString(crownLive, "handicapLine");

  if (!liveHandicapLine) return pending("缺少终盘盘口");
  if (!initHandicapLine) {
    return { ...pending("缺少初始盘口"), status: "invalid", liveHandicapLine };
  }

  const initHandicapValue = handicapLineToNumber(initHandicapLine);
  const liveHandicapValue = handicapLineToNumber(liveHandicapLine);
  if (!Number.isFinite(initHandicapValue) || !Number.isFinite(liveHandicapValue)) {
    return {
      ...pending("盘口格式无法识别"),
      status: "invalid",
      initHandicapLine,
      liveHandicapLine,
      initHandicapValue: Number.isFinite(initHandicapValue) ? initHandicapValue : null,
      liveHandicapValue: Number.isFinite(liveHandicapValue) ? liveHandicapValue : null,
    };
  }

  const actualHandicapTrend = determineHandicapTrend(initHandicapValue, liveHandicapValue);
  const validDirections = new Set(["主降水", "客降水", "不变"]);
  if (typeof predictedDirection !== "string" || !validDirections.has(predictedDirection)) {
    return {
      status: "invalid",
      autoIsCorrect: null,
      actualHandicapTrend,
      actualWaterDirection: null,
      initHandicapLine,
      liveHandicapLine,
      initHandicapValue,
      liveHandicapValue,
      reason: "预测水位方向无效",
    };
  }

  let actualWaterDirection: string | null;
  if (actualHandicapTrend === "不变") {
    const initialWater = Object.keys(crown12).length > 0
      ? crown12
      : {
          handicapHome: crown?.ftHandicapHome,
          handicapAway: crown?.ftHandicapAway,
        };
    actualWaterDirection = determineWaterDirection(initialWater, crownLive);
    if (!actualWaterDirection) {
      return {
        status: "invalid",
        autoIsCorrect: null,
        actualHandicapTrend,
        actualWaterDirection: null,
        initHandicapLine,
        liveHandicapLine,
        initHandicapValue,
        liveHandicapValue,
        reason: "盘口不变但水位数据不完整",
      };
    }
  } else if (actualHandicapTrend) {
    actualWaterDirection = initHandicapValue >= 0
      ? (actualHandicapTrend === "升盘" ? "主降水" : "客降水")
      : (actualHandicapTrend === "升盘" ? "客降水" : "主降水");
  } else {
    actualWaterDirection = null;
  }

  if (!actualWaterDirection) {
    return {
      status: "invalid",
      autoIsCorrect: null,
      actualHandicapTrend,
      actualWaterDirection: null,
      initHandicapLine,
      liveHandicapLine,
      initHandicapValue,
      liveHandicapValue,
      reason: "无法确定实际水位方向",
    };
  }

  const autoIsCorrect = predictedDirection === actualWaterDirection;
  return {
    status: autoIsCorrect ? "correct" : "wrong",
    autoIsCorrect,
    actualHandicapTrend,
    actualWaterDirection,
    initHandicapLine,
    liveHandicapLine,
    initHandicapValue,
    liveHandicapValue,
    reason: null,
  };
}

export function resolveEffectiveVerification(
  autoIsCorrect: boolean | null | undefined,
  manualIsCorrect: boolean | null | undefined,
  automaticStatus?: AutomaticVerificationStatus | null,
): EffectiveVerificationResult {
  if (manualIsCorrect === true || manualIsCorrect === false) {
    return { status: "manual", isCorrect: manualIsCorrect, source: "manual" };
  }
  if (autoIsCorrect === true || autoIsCorrect === false) {
    return {
      status: autoIsCorrect ? "correct" : "wrong",
      isCorrect: autoIsCorrect,
      source: "auto",
    };
  }
  return {
    status: automaticStatus === "invalid" ? "invalid" : "pending",
    isCorrect: null,
    source: null,
  };
}

export function resolveStoredEffectiveVerification(record: {
  auto_is_correct?: boolean | null;
  manual_is_correct?: boolean | null;
  is_correct?: boolean | null;
  verification_status?: string | null;
}): EffectiveVerificationResult {
  const automaticStatus = record.verification_status === "invalid" ? "invalid" : "pending";
  const autoResult = record.auto_is_correct ?? (
    record.verification_status === "correct" || record.verification_status === "wrong"
      ? record.is_correct
      : null
  );
  return resolveEffectiveVerification(autoResult, record.manual_is_correct, automaticStatus);
}

export function hasCompleteVerificationOdds(odds: MatchOddsInput | null | undefined): boolean {
  if (!odds) return false;
  const crownLive = parseDbJsonObject(odds.crown_live_odds);
  return Boolean(crownLive.handicapLine && crownLive.handicapHome && crownLive.handicapAway);
}
import { calculateAsianSettlement } from "./asian-settlement";
