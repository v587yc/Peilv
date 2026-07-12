import { NextRequest } from "next/server";
import { llmStream } from "@/lib/llm";

export const dynamic = "force-dynamic";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequest {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchTime: string;
  messages: ChatMessage[];
  // Context from previous analysis
  analysisContext?: string;
  liveHandicap?: string;
  liveHomeOdds?: string;
  liveAwayOdds?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: ChatRequest = await request.json();

    if (!body.messages || body.messages.length === 0) {
      return new Response(JSON.stringify({ error: "缺少消息" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Build system prompt with match context
    const systemPrompt = `你是一位专业的足球赔率分析师，正在与用户讨论一场赛事的盘口走势分析。

## 当前赛事
联赛: ${body.league}
时间: ${body.matchTime}
主队: ${body.homeTeam}
客队: ${body.awayTeam}
${body.liveHandicap ? `即时盘口: ${body.liveHandicap} (主水${body.liveHomeOdds}/客水${body.liveAwayOdds})` : ""}

${body.analysisContext ? `## 之前的分析结果\n${body.analysisContext}` : "## 注意\n尚未进行过AI分析，请先基于已有信息回答，并建议用户点击AI按钮获取完整分析。"}

## 回答规则
1. 专注于水位方向预测（主降水/客降水/不变），主降水=资金流入主队，客降水=资金流入客队
2. 如果用户补充了新信息（如伤停、阵容），据此调整判断
3. 如果用户质疑你的分析，解释推理过程，有理有据地坚持或修正
4. 简洁直接，避免冗长
5. 如果判断有变化，明确说明"修正判断：从X改为Y，原因：..."`;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...body.messages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    // Stream the response via SSE
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        try {
          for await (const chunk of llmStream(messages, {
            temperature: 0.5,
          })) {
            const data = chunk.content || "";
            if (data) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: data })}\n\n`));
            }
          }
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        } catch (err) {
          const msg = err instanceof Error ? err.message : "流式响应失败";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "聊天失败";
    console.error("[Chat] Error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
