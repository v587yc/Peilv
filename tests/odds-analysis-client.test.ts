import { describe, expect, it } from "vitest";
import {
  buildAnalysisRequest,
  fetchAnalysisList,
  requestAnalysis,
  requestAnalysisChat,
  requestLearning,
  requestManualVerification,
  requestVerification,
  type AnalysisChatMessage,
  type FetchLike,
} from "@/features/odds/analysis-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("odds analysis client", () => {
  it("loads the exact date-level analysis list envelope", async () => {
    const predictions = {
      m1: {
        matchId: "m1", homeTeam: "主队", awayTeam: "客队", league: "中超", matchTime: "19:30",
        indicators: [], newsSummary: "", handicapTrend: "不变", waterDirection: "不变", prediction: "主",
        totalTrend: "不变", totalPrediction: "中立", totalAction: "", confidenceLevel: "低",
        accuracy: "50%", strategy: "", action: "", reasoning: "列表推理",
        crown_handicap: "", yinghe_handicap: "", who_open_later: "",
      },
    };
    const fetcher: FetchLike = async (url, init) => {
      expect(String(url)).toBe("/api/analysis?date=2026%2F07%2F14");
      expect(init).toBeUndefined();
      return jsonResponse({ success: true, predictions });
    };

    await expect(fetchAnalysisList(fetcher, "2026/07/14")).resolves.toEqual(predictions);
  });

  it("preserves date-level analysis list server and malformed response errors", async () => {
    await expect(fetchAnalysisList(
      async () => jsonResponse({ success: false, error: "分析列表不可用" }, 503),
      "20260714",
    )).rejects.toThrow("分析列表不可用");
    await expect(fetchAnalysisList(
      async () => new Response("bad", { status: 200 }),
      "20260714",
    )).rejects.toThrow("分析列表响应格式异常");
  });

  it("keeps top-level reasoning visible when llmPrediction is absent", async () => {
    const input = {
      match: { id: "m1", homeTeam: "主队", awayTeam: "客队", league: "中超", time: "19:30" },
      matchDate: "20260714",
      scheduleMode: "today" as const,
      companies: [],
    };

    await expect(requestAnalysis(async () => jsonResponse({
      success: true,
      data: { reasoning: "顶层完整推理" },
    }), input)).resolves.toMatchObject({ reasoning: "顶层完整推理" });
  });

  it("constructs the exact analysis request payload and maps rich response fields", async () => {
    const input = {
      match: { id: "m1", homeTeam: "主队", awayTeam: "客队", league: "中超", time: "19:30" },
      matchDate: "20260714",
      scheduleMode: "future" as const,
      companies: [{ companyId: "3", ftHandicapLineLive: "半球" }],
      crown12Handicap: { home: "0.91", line: "平手", away: "0.95" },
      crown12Total: { over: "0.90", line: "2.5", under: "0.96" },
      crownLiveHandicap: { home: "0.88", line: "半球", away: "1.00" },
      crownLiveTotal: { over: "0.92", line: "2.75", under: "0.94" },
    };
    expect(buildAnalysisRequest(input)).toEqual({
      matchId: "m1", homeTeam: "主队", awayTeam: "客队", league: "中超", matchTime: "19:30",
      matchDate: "20260714", scheduleMode: "future", companies: input.companies,
      crown12Handicap: input.crown12Handicap, crown12Total: input.crown12Total,
      crownLiveHandicap: input.crownLiveHandicap, crownLiveTotal: input.crownLiveTotal,
    });

    const fetcher: FetchLike = async (url, init) => {
      expect(String(url)).toBe("/api/analysis");
      expect(JSON.parse(String(init?.body))).toEqual(buildAnalysisRequest(input));
      return jsonResponse({ success: true, data: {
        indicators: [{ name: "水位", value: "低", signal: "主", weight: 1, reasoning: "证据" }],
        newsSummary: "新闻", llmPrediction: { prediction: "主", reasoning: "完整推理" },
        probability: { home: 0.6 }, settlementEvidence: { source: "snapshot" },
      } });
    };
    await expect(requestAnalysis(fetcher, input)).resolves.toMatchObject({
      matchId: "m1", homeTeam: "主队", prediction: "主", reasoning: "完整推理",
      newsSummary: "新闻", probability: { home: 0.6 }, settlementEvidence: { source: "snapshot" },
    });
  });

  it("preserves analysis response errors and malformed response wording", async () => {
    await expect(requestAnalysis(async () => jsonResponse({ error: "模型不可用" }, 503), {
      match: { id: "m", homeTeam: "a", awayTeam: "b", league: "l", time: "t" }, matchDate: "20260714",
      scheduleMode: "today", companies: [],
    })).rejects.toThrow("模型不可用");
    await expect(requestAnalysis(async () => new Response("bad"), {
      match: { id: "m", homeTeam: "a", awayTeam: "b", league: "l", time: "t" }, matchDate: "20260714",
      scheduleMode: "today", companies: [],
    })).rejects.toThrow("分析服务返回格式异常");
  });

  it("streams chat chunks while preserving the complete message protocol", async () => {
    const messages: AnalysisChatMessage[] = [{ role: "user", content: "怎么看" }];
    const chunks: string[] = [];
    const fetcher: FetchLike = async (url, init) => {
      expect(String(url)).toBe("/api/analysis/chat");
      expect(JSON.parse(String(init?.body))).toEqual({
        matchId: "m1", homeTeam: "主", awayTeam: "客", league: "联赛", matchTime: "20:00", messages,
        analysisContext: "推理", liveHandicap: "半球", liveHomeOdds: "0.9", liveAwayOdds: "1.0",
      });
      return new Response("data: {\"content\":\"第一\"}\n\ndata: {\"content\":\"段\"}\n\ndata: [DONE]\n\n", { status: 200 });
    };
    await expect(requestAnalysisChat(fetcher, {
      matchId: "m1", homeTeam: "主", awayTeam: "客", league: "联赛", matchTime: "20:00", messages,
      analysisContext: "推理", liveHandicap: "半球", liveHomeOdds: "0.9", liveAwayOdds: "1.0",
    }, content => chunks.push(content))).resolves.toBe("第一段");
    expect(chunks).toEqual(["第一", "第一段"]);
  });

  it("keeps manual verification, verification, and learning payloads and errors", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetcher: FetchLike = async (url, init) => {
      calls.push([String(url), init]);
      if (String(url).includes("verify?")) return jsonResponse({ success: false, error: "自动验证失败" }, 500);
      if (String(url).includes("learn")) return jsonResponse({ error: "学习失败" }, 500);
      return jsonResponse({ success: true, markets: { handicap: {}, total: {} }, stats: { markets: {} } });
    };
    await requestManualVerification(fetcher, { matchId: "m1", matchDate: "20260714", market: "total", isCorrect: null });
    expect(calls[0]).toEqual(["/api/analysis/verify", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ matchId: "m1", matchDate: "20260714", market: "total", isCorrect: null }),
    })]);
    await expect(requestVerification(fetcher, "20260714")).rejects.toThrow("自动验证失败");
    await expect(requestLearning(fetcher, "handicap")).rejects.toThrow("学习失败");
  });
});
