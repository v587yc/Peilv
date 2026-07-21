import { NextRequest, NextResponse } from "next/server";
import type { AnalysisRequest } from "@/features/analysis/contracts";
import { analyzeMatch } from "@/features/analysis/analysis-service";
import { createNewsSearch } from "@/features/analysis/news-service";
import { createLlmAnalyzer } from "@/features/analysis/llm-analysis-service";
import {
  AnalysisPersistenceError,
  SupabaseAnalysisRepository,
  SupabaseStrategyRepository,
} from "@/features/analysis/repository";
import { SupabaseAnalysisQueryRepository } from "@/features/analysis/query-service";
import { llmInvoke, webSearch } from "@/lib/llm";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { sendFeishuAIAnalysis } from "@/lib/integrations/feishu/notifier";
import { isInternalRequest } from "@/lib/internal-auth";
import { upsertMatchT30Task } from "@/lib/automation/match-t30-task";
import { SupabaseAutomationRepository } from "@/lib/automation/repository";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (isInternalRequest(request)) {
    return NextResponse.json({ success: false, error: "内部任务无权访问此接口" }, { status: 403 });
  }
  try {
    const body: AnalysisRequest = await request.json();
    if (body.source === "backtest" && !isInternalRequest(request)) {
      return NextResponse.json({ success: false, error: "回测分析仅允许内部任务调用" }, { status: 403 });
    }
    if (!body.matchId || !body.homeTeam || !body.awayTeam) {
      return NextResponse.json({ success: false, error: "缺少必要参数" }, { status: 400 });
    }
    const client = getSupabaseClient();
    const clock = () => new Date();
    const result = await analyzeMatch(body, {
      strategyRepository: new SupabaseStrategyRepository(client),
      analysisRepository: new SupabaseAnalysisRepository(client, clock),
      newsSearch: createNewsSearch(webSearch),
      llmAnalyzer: createLlmAnalyzer(llmInvoke),
      clock,
      logger: { error: (message, context) => console.error(message, context) },
      enqueueT30: async (analysisRequest, matchDate, now) => {
        await upsertMatchT30Task(new SupabaseAutomationRepository(), {
          matchId: analysisRequest.matchId, matchDate, matchTime: analysisRequest.matchTime,
          homeTeam: analysisRequest.homeTeam, awayTeam: analysisRequest.awayTeam,
          league: analysisRequest.league, scheduleMode: analysisRequest.scheduleMode,
        }, now);
      },
      notify: async (analysisResult) => {
        await sendFeishuAIAnalysis({
          homeTeam: analysisResult.homeTeam, awayTeam: analysisResult.awayTeam, league: analysisResult.league,
          matchTime: analysisResult.matchTime, waterDirection: analysisResult.water_direction,
          prediction: analysisResult.prediction, confidenceLevel: analysisResult.llmPrediction.confidenceLevel || "低",
          strategy: analysisResult.llmPrediction.strategy || "", reasoning: analysisResult.llmPrediction.reasoning || "",
        });
      },
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "分析失败";
    console.error("[Analysis] Error:", message);
    const responseMessage = error instanceof AnalysisPersistenceError
      ? "分析完成但保存预测失败"
      : "分析服务暂时不可用";
    return NextResponse.json({ success: false, error: responseMessage }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  if (isInternalRequest(req)) return NextResponse.json({ error: "内部任务无权访问此接口" }, { status: 403 });
  try {
    const date = req.nextUrl.searchParams.get("date");
    if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });
    const detail = req.nextUrl.searchParams.get("detail");
    const matchId = req.nextUrl.searchParams.get("matchId");
    const repository = new SupabaseAnalysisQueryRepository(getSupabaseClient());
    if (detail === "1" && matchId) {
      const prediction = await repository.findDetail(date, matchId);
      return NextResponse.json({ success: true, prediction });
    }
    const predictions = await repository.findByDate(date);
    return NextResponse.json({ success: true, predictions });
  } catch (error) {
    console.error("[Analysis] Query failed:", error);
    return NextResponse.json({ error: "分析结果加载失败" }, { status: 500 });
  }
}
