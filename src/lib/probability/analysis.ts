import { handicapLineToNumber } from "@/lib/verification";
import { aggregateMarket } from "./aggregate";
import { aggregateOneXTwoOdds, devigBinary } from "./odds";
import { fitPoissonModel } from "./poisson";
import { recommendCandidate } from "./ev";
import type {
  EvRecommendation,
  MarketCandidate,
  OutcomeProbabilities,
  PoissonModel,
  ProbabilityQuality,
  ThreeWayProbabilities,
} from "./types";

interface AnalysisCompanyProbabilityInput {
  companyId: string;
  euroHomeInit?: string;
  euroDrawInit?: string;
  euroAwayInit?: string;
}

interface ReferenceHandicap {
  home: string;
  line: string;
  away: string;
}

interface ReferenceTotal {
  over: string;
  line: string;
  under: string;
}

export interface AnalysisProbabilityInput {
  scheduleMode: string;
  companies: AnalysisCompanyProbabilityInput[];
  crown12Handicap?: ReferenceHandicap;
  crown12Total?: ReferenceTotal;
  crownLiveHandicap?: ReferenceHandicap;
  crownLiveTotal?: ReferenceTotal;
  sourceObservedAt?: string | null;
}

export interface PreparedAnalysisProbability {
  quality: ProbabilityQuality;
  reason?: string;
  modelVersion?: string;
  calibrationVersion: string | null;
  sourceObservedAt: string | null;
  companyCount: number;
  oneXTwo: ThreeWayProbabilities | null;
  totalTarget: { line: number; overProbability: number } | null;
  model: PoissonModel | null;
  candidates: MarketCandidate[];
  recommendations: {
    handicap: EvRecommendation;
    total: EvRecommendation;
  };
}

export interface AnalysisProbabilityOutput {
  quality: ProbabilityQuality;
  reason?: string;
  modelVersion?: string;
  calibrationVersion: string | null;
  sourceObservedAt: string | null;
  companyCount: number;
  inputs: {
    oneXTwo: ThreeWayProbabilities | null;
    totalTarget: { line: number; overProbability: number } | null;
  };
  model: PoissonModel | null;
  markets: {
    handicap: { line: number; selection: "home" | "away"; probabilities: OutcomeProbabilities } | null;
    total: { line: number; selection: "over" | "under"; probabilities: OutcomeProbabilities } | null;
  };
  recommendations: PreparedAnalysisProbability["recommendations"];
}

function numeric(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.trim().replace(/^\*/, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function line(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = handicapLineToNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function candidate(
  id: string,
  market: "handicap" | "total",
  marketLine: number | null,
  selection: "home" | "away" | "over" | "under",
  netOdds: number | null,
  source: string,
): MarketCandidate | null {
  if (marketLine === null || netOdds === null || netOdds < 0) return null;
  return { id, market, line: marketLine, selection, netOdds, source };
}

export function prepareAnalysisProbability(input: AnalysisProbabilityInput): PreparedAnalysisProbability {
  const books = input.companies.flatMap(company => {
    const home = numeric(company.euroHomeInit);
    const draw = numeric(company.euroDrawInit);
    const away = numeric(company.euroAwayInit);
    return home !== null && draw !== null && away !== null ? [{ home, draw, away }] : [];
  });
  const oneXTwoResult = aggregateOneXTwoOdds(books);
  const useLive = input.scheduleMode === "future";
  const handicap = useLive ? input.crownLiveHandicap : input.crown12Handicap;
  const total = useLive ? input.crownLiveTotal : input.crown12Total;
  const handicapLine = line(handicap?.line);
  const totalLine = line(total?.line);
  const overNet = numeric(total?.over);
  const underNet = numeric(total?.under);
  const totalProbability = overNet === null || underNet === null
    ? { quality: "insufficient_data" as const, value: null, reason: "No complete total-market prices supplied" }
    : devigBinary({ first: 1 + overNet, second: 1 + underNet });
  const totalTarget = totalLine !== null && totalProbability.value
    ? { line: totalLine, overProbability: totalProbability.value.first }
    : null;

  const fit = oneXTwoResult.value && totalTarget
    ? fitPoissonModel({
        oneXTwo: oneXTwoResult.value,
        totalLine: totalTarget.line,
        overProbability: totalTarget.overProbability,
      })
    : {
        quality: oneXTwoResult.value ? totalProbability.quality : oneXTwoResult.quality,
        value: null,
        reason: oneXTwoResult.reason || totalProbability.reason || "Probability inputs are incomplete",
      };
  const candidates = [
    candidate("reference-handicap-home", "handicap", handicapLine, "home", numeric(handicap?.home), useLive ? "crown_live" : "crown_12"),
    candidate("reference-handicap-away", "handicap", handicapLine, "away", numeric(handicap?.away), useLive ? "crown_live" : "crown_12"),
    candidate("reference-total-over", "total", totalLine, "over", overNet, useLive ? "crown_live" : "crown_12"),
    candidate("reference-total-under", "total", totalLine, "under", underNet, useLive ? "crown_live" : "crown_12"),
  ].filter((item): item is MarketCandidate => item !== null);
  const quality = fit.quality as ProbabilityQuality;
  const distribution = fit.value?.distribution || null;

  return {
    quality,
    reason: fit.reason,
    modelVersion: fit.modelVersion,
    calibrationVersion: null,
    sourceObservedAt: input.sourceObservedAt || null,
    companyCount: books.length,
    oneXTwo: oneXTwoResult.value,
    totalTarget,
    model: fit.value || null,
    candidates,
    recommendations: {
      handicap: recommendCandidate(distribution, quality, candidates.filter(item => item.market === "handicap")),
      total: recommendCandidate(distribution, quality, candidates.filter(item => item.market === "total")),
    },
  };
}

export function finalizeAnalysisProbability(
  prepared: PreparedAnalysisProbability,
  selections: { handicap: string; total: string },
): AnalysisProbabilityOutput {
  const distribution = prepared.model?.distribution || null;
  const handicapCandidate = prepared.candidates.find(item => item.market === "handicap" && item.selection === (selections.handicap === "主" ? "home" : selections.handicap === "客" ? "away" : ""));
  const totalCandidate = prepared.candidates.find(item => item.market === "total" && item.selection === (selections.total === "大" ? "over" : selections.total === "小" ? "under" : ""));
  return {
    quality: prepared.quality,
    reason: prepared.reason,
    modelVersion: prepared.modelVersion,
    calibrationVersion: prepared.calibrationVersion,
    sourceObservedAt: prepared.sourceObservedAt,
    companyCount: prepared.companyCount,
    inputs: { oneXTwo: prepared.oneXTwo, totalTarget: prepared.totalTarget },
    model: prepared.model,
    markets: {
      handicap: distribution && handicapCandidate ? {
        line: handicapCandidate.line,
        selection: handicapCandidate.selection as "home" | "away",
        probabilities: aggregateMarket(distribution, "handicap", handicapCandidate.line, handicapCandidate.selection as "home" | "away"),
      } : null,
      total: distribution && totalCandidate ? {
        line: totalCandidate.line,
        selection: totalCandidate.selection as "over" | "under",
        probabilities: aggregateMarket(distribution, "total", totalCandidate.line, totalCandidate.selection as "over" | "under"),
      } : null,
    },
    recommendations: prepared.recommendations,
  };
}

export function probabilityPromptContext(prepared: PreparedAnalysisProbability): string {
  const summarizeRecommendation = (recommendation: EvRecommendation) => ({
    quality: recommendation.quality,
    recommended: recommendation.recommended && {
      market: recommendation.recommended.market,
      line: recommendation.recommended.line,
      selection: recommendation.recommended.selection,
      expectedValue: recommendation.recommended.expectedValue,
      probabilities: recommendation.recommended.probabilities,
    },
    evaluated: recommendation.evaluated.map(item => ({
      market: item.market,
      line: item.line,
      selection: item.selection,
      expectedValue: item.expectedValue,
      probabilities: item.probabilities,
    })),
  });
  return JSON.stringify({
    quality: prepared.quality,
    reason: prepared.reason,
    modelVersion: prepared.modelVersion,
    calibrated: prepared.calibrationVersion !== null,
    companyCount: prepared.companyCount,
    expectedGoals: prepared.model && { home: prepared.model.lambdaHome, away: prepared.model.lambdaAway },
    recommendations: {
      handicap: summarizeRecommendation(prepared.recommendations.handicap),
      total: summarizeRecommendation(prepared.recommendations.total),
    },
  });
}
