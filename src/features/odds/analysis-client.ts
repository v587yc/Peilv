import type { PredictionMarket } from "@/lib/verification";
import type { MarketVerification } from "@/lib/verification/market-service";
import type { AnalysisResultData } from "./contracts";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type AnalysisScheduleMode = "today" | "history" | "future";
export type AnalysisChatMessage = { role: "user" | "assistant"; content: string };
export type OddsTriple = { home: string; line: string; away: string };
export type TotalTriple = { over: string; line: string; under: string };

export interface AnalysisRequestInput {
  match: { id: string; homeTeam: string; awayTeam: string; league: string; time: string };
  matchDate: string;
  scheduleMode: AnalysisScheduleMode;
  companies: unknown[];
  crown12Handicap?: OddsTriple;
  crown12Total?: TotalTriple;
  crownLiveHandicap?: OddsTriple;
  crownLiveTotal?: TotalTriple;
}

export interface AnalysisRequestDto {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchTime: string;
  matchDate: string;
  scheduleMode: AnalysisScheduleMode;
  companies: unknown[];
  crown12Handicap?: OddsTriple;
  crown12Total?: TotalTriple;
  crownLiveHandicap?: OddsTriple;
  crownLiveTotal?: TotalTriple;
}

export interface AnalysisChatRequest {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchTime: string;
  messages: AnalysisChatMessage[];
  analysisContext?: string;
  liveHandicap?: string;
  liveHomeOdds?: string;
  liveAwayOdds?: string;
}

export interface ManualVerificationResponse {
  markets: { handicap: MarketVerification; total: MarketVerification };
  stats?: { markets?: unknown };
}

export interface EvolutionStats {
  totalPredictions: number;
  correctPredictions: number;
  overallAccuracy: string;
  topPatterns: Array<{ key: string; description: string; hitRate: string; total: number }>;
}

export type AnalysisList = Record<string, AnalysisResultData>;

async function json(response: Response, malformed: string): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new Error(malformed);
  }
}

function errorMessage(payload: Record<string, unknown>, fallback: string) {
  return typeof payload.error === "string" && payload.error ? payload.error : fallback;
}

export function buildAnalysisRequest(input: AnalysisRequestInput): AnalysisRequestDto {
  return {
    matchId: input.match.id,
    homeTeam: input.match.homeTeam,
    awayTeam: input.match.awayTeam,
    league: input.match.league,
    matchTime: input.match.time,
    matchDate: input.matchDate,
    scheduleMode: input.scheduleMode,
    companies: input.companies,
    crown12Handicap: input.crown12Handicap,
    crown12Total: input.crown12Total,
    crownLiveHandicap: input.crownLiveHandicap,
    crownLiveTotal: input.crownLiveTotal,
  };
}

type AnalysisResponseData = Partial<AnalysisResultData> & {
  llmPrediction?: Partial<Pick<AnalysisResultData,
    "handicapTrend" | "waterDirection" | "prediction" | "totalTrend" | "totalPrediction" |
    "totalAction" | "confidenceLevel" | "accuracy" | "strategy" | "action" | "reasoning"
  >>;
  handicap_trend?: string;
  water_direction?: string;
  total_trend?: string;
  total_prediction?: string;
  total_action?: string;
  confidence_level?: string;
};

export async function fetchAnalysisList(
  fetcher: FetchLike,
  dateKey: string,
): Promise<AnalysisList> {
  const response = await fetcher(`/api/analysis?date=${encodeURIComponent(dateKey)}`);
  const payload = await json(response, "分析列表响应格式异常");
  if (!response.ok || payload.success !== true) {
    throw new Error(errorMessage(payload, "加载分析列表失败"));
  }
  if (!payload.predictions || typeof payload.predictions !== "object" || Array.isArray(payload.predictions)) {
    throw new Error("分析列表响应格式异常");
  }
  return payload.predictions as AnalysisList;
}

export async function requestAnalysis(fetcher: FetchLike, input: AnalysisRequestInput): Promise<AnalysisResultData> {
  const response = await fetcher("/api/analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildAnalysisRequest(input)),
  });
  const payload = await json(response, "分析服务返回格式异常");
  if (!response.ok || payload.success !== true || !payload.data) {
    throw new Error(errorMessage(payload, `AI分析失败（${response.status}）`));
  }
  const data = payload.data as AnalysisResponseData;
  return {
    matchId: input.match.id,
    homeTeam: data.homeTeam || input.match.homeTeam,
    awayTeam: data.awayTeam || input.match.awayTeam,
    league: data.league || input.match.league,
    matchTime: data.matchTime || input.match.time,
    matchDate: input.matchDate,
    analyzedAt: data.analyzedAt || null,
    indicators: data.indicators || [],
    newsSummary: data.newsSummary || "",
    handicapTrend: data.llmPrediction?.handicapTrend || data.handicap_trend || data.handicapTrend || "不确定",
    waterDirection: data.llmPrediction?.waterDirection || data.water_direction || data.waterDirection || "不变",
    prediction: data.llmPrediction?.prediction || data.prediction || "中立",
    totalTrend: data.llmPrediction?.totalTrend || data.total_trend || "不变",
    totalPrediction: data.llmPrediction?.totalPrediction || data.total_prediction || "中立",
    totalAction: data.llmPrediction?.totalAction || data.total_action || "",
    confidenceLevel: data.llmPrediction?.confidenceLevel || data.confidence_level || "低",
    accuracy: data.llmPrediction?.accuracy || data.accuracy || "50%",
    strategy: data.llmPrediction?.strategy || data.strategy || "",
    action: data.llmPrediction?.action || data.action || "",
    reasoning: data.llmPrediction?.reasoning || data.reasoning || "",
    verification: data.verification,
    probability: data.probability || null,
    settlementEvidence: data.settlementEvidence,
    crown_handicap: data.crown_handicap || "",
    yinghe_handicap: data.yinghe_handicap || "",
    who_open_later: data.who_open_later || "",
  };
}

export async function requestAnalysisChat(
  fetcher: FetchLike,
  input: AnalysisChatRequest,
  onContent: (completeContent: string) => void,
): Promise<string> {
  const response = await fetcher("/api/analysis/chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) throw new Error("连接失败");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let complete = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = done ? "" : lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as { content?: unknown };
        if (typeof parsed.content === "string" && parsed.content) {
          complete += parsed.content;
          onContent(complete);
        }
      } catch {
        // Preserve the existing protocol: malformed SSE events are ignored.
      }
    }
    if (done) break;
  }
  return complete;
}

export async function requestManualVerification(
  fetcher: FetchLike,
  input: { matchId: string; matchDate: string; market: PredictionMarket; isCorrect: boolean | null },
): Promise<ManualVerificationResponse> {
  const response = await fetcher("/api/analysis/verify", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const payload = await json(response, "服务未能保存验证结果");
  if (!response.ok || payload.success !== true) throw new Error(errorMessage(payload, "服务未能保存验证结果"));
  return payload as unknown as ManualVerificationResponse;
}

export async function requestVerification(fetcher: FetchLike, dateKey: string) {
  const response = await fetcher(`/api/analysis/verify?startDate=${dateKey}&endDate=${dateKey}`);
  const payload = await json(response, "自动验证失败");
  if (!response.ok || payload.success !== true) throw new Error(errorMessage(payload, "自动验证失败"));
  return { verified: Number(payload.verified || 0), correct: Number(payload.correct || 0) };
}

export async function requestLearning(fetcher: FetchLike, market: PredictionMarket) {
  const response = await fetcher("/api/analysis/learn", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ market, league: "ALL", minSamples: 3 }),
  });
  const payload = await json(response, "学习失败");
  if (!response.ok || payload.success !== true) throw new Error(errorMessage(payload, "学习失败"));
  return { patternsFound: Number(payload.patternsFound || 0) };
}

export async function fetchEvolutionStats(fetcher: FetchLike): Promise<EvolutionStats | null> {
  const response = await fetcher("/api/analysis/learn");
  const payload = await json(response, "学习统计响应格式错误");
  if (!response.ok || payload.success !== true) return null;
  return {
    totalPredictions: Number(payload.totalPredictions || 0),
    correctPredictions: Number(payload.correctPredictions || 0),
    overallAccuracy: String(payload.overallAccuracy || ""),
    topPatterns: Array.isArray(payload.topPatterns) ? payload.topPatterns as EvolutionStats["topPatterns"] : [],
  };
}
