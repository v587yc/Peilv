import { NextRequest } from "next/server";
import { POST as analyzeRoute } from "@/app/api/analysis/route";
import { GET as verifyRoute } from "@/app/api/analysis/verify/route";
import { POST as learnRoute } from "@/app/api/analysis/learn/route";

export interface ServiceResult {
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

function internalHeaders(json = false): HeadersInit {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    "x-internal-api-secret": process.env.INTERNAL_API_SECRET || "",
  };
}

async function unwrap(response: Response): Promise<ServiceResult> {
  const payload = (await response.json()) as ServiceResult;
  if (!response.ok) {
    throw new Error(payload.error || `内部服务调用失败 (${response.status})`);
  }
  return payload;
}

export async function analyzeMatch(
  input: Record<string, unknown>,
): Promise<ServiceResult> {
  const request = new NextRequest("http://internal/api/analysis", {
    method: "POST",
    headers: internalHeaders(true),
    body: JSON.stringify(input),
  });
  return unwrap(await analyzeRoute(request));
}

export async function verifyBacktestPredictions(
  startDate: string,
  endDate: string,
): Promise<ServiceResult> {
  const params = new URLSearchParams({ startDate, endDate, source: "backtest" });
  const request = new NextRequest(
    `http://internal/api/analysis/verify?${params}`,
    { headers: internalHeaders() },
  );
  return unwrap(await verifyRoute(request));
}

export async function learnBacktestPatterns(
  runId: string,
  trainingWindowStart: string,
  trainingWindowEnd: string,
): Promise<ServiceResult> {
  const learnMarket = async (market: "handicap" | "total") => {
    const request = new NextRequest("http://internal/api/analysis/learn", {
      method: "POST",
      headers: internalHeaders(true),
      body: JSON.stringify({
        market,
        league: "ALL",
        minSamples: 20,
        source: "backtest",
        runId,
        trainingWindowStart,
        trainingWindowEnd,
      }),
    });
    return unwrap(await learnRoute(request));
  };
  const [handicap, total] = await Promise.all([
    learnMarket("handicap"),
    learnMarket("total"),
  ]);
  return { success: true, markets: { handicap, total } };
}
