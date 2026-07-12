import { NextRequest } from "next/server";
import { llmStream } from "@/lib/llm";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export const dynamic = "force-dynamic";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequest {
  conversationId: string;
  messages: ChatMessage[];
}

// Score user input for importance (0-1)
function scoreInput(input: string): number {
  let score = 0.1; // default: trivial
  const highKeywords = ["项目", "决定", "承诺", "目标", "计划", "截止", "重要", "必须", "记住", "不要忘", "需求", "方案", "架构", "设计", "关键"];
  const mediumKeywords = ["会议", "讨论", "问题", "想法", "建议", "考虑", "变更", "更新", "进度", "反馈", "安排", "时间"];

  for (const kw of highKeywords) {
    if (input.includes(kw)) { score = Math.max(score, 0.8); break; }
  }
  if (score < 0.8) {
    for (const kw of mediumKeywords) {
      if (input.includes(kw)) { score = Math.max(score, 0.5); break; }
    }
  }
  if (score < 0.5 && input.length > 50) score = 0.4;
  if (score < 0.4 && input.length > 20) score = 0.3;
  return score;
}

// Extract keywords from content
function extractKeywords(content: string): string[] {
  const stopWords = new Set(["的", "了", "吗", "呢", "吧", "哈", "嗯", "啊", "哦", "是", "在", "有", "我", "你", "他", "她", "它", "这", "那", "和", "与", "或", "但", "不", "就", "也", "都", "还", "要", "会", "能", "可以", "要", "想"]);
  const words: string[] = [];
  // Extract 2-4 char segments as keywords (simple Chinese segmentation)
  const cleaned = content.replace(/[，。！？、；：""''（）\[\]{}【】《》\s\d]/g, " ").trim();
  const segments = cleaned.split(/\s+/).filter(s => s.length >= 2 && s.length <= 8);
  for (const seg of segments) {
    if (!stopWords.has(seg) && words.length < 8) {
      words.push(seg);
    }
  }
  return words;
}

export async function POST(request: NextRequest) {
  try {
    const body: ChatRequest = await request.json();
    const conversationId = body.conversationId || "default";
    const userMessages = body.messages || [];

    if (userMessages.length === 0) {
      return new Response(JSON.stringify({ error: "缺少消息" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const lastUserMsg = userMessages.filter(m => m.role === "user").pop();
    if (!lastUserMsg) {
      return new Response(JSON.stringify({ error: "没有用户消息" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = getSupabaseClient();

    // 1. Save new memory entry (short-term)
    const score = scoreInput(lastUserMsg.content);
    const keywords = extractKeywords(lastUserMsg.content);
    const memoryId = `S${Date.now()}`;

    const { error: insertError } = await supabase.from("memory_bank").insert({
      conversation_id: conversationId,
      memory_type: "short",
      content: lastUserMsg.content,
      score,
      keywords,
      original_id: memoryId,
    });
    if (insertError) console.error("[Memory] Insert error:", insertError.message);

    // 2. Compress: move short-term memories older than 48h to long-term
    const compressionThreshold = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: oldMemories } = await supabase
      .from("memory_bank")
      .select("id, content, original_id, keywords, score")
      .eq("conversation_id", conversationId)
      .eq("memory_type", "short")
      .lt("created_at", compressionThreshold);

    let compressedCount = 0;
    if (oldMemories && oldMemories.length > 0) {
      // Batch compress: summarize and move to long-term
      for (const mem of oldMemories) {
        const summary = mem.content.length > 100 ? mem.content.substring(0, 100) + "..." : mem.content;
        await supabase.from("memory_bank").insert({
          conversation_id: conversationId,
          memory_type: "long",
          content: mem.content,
          summary,
          keywords: mem.keywords,
          score: mem.score,
          original_id: mem.original_id,
          compressed_at: new Date().toISOString(),
        });
        await supabase.from("memory_bank").delete().eq("id", mem.id);
        compressedCount++;
      }
    }

    // 3. Load relevant memories for context
    const { data: shortMemories } = await supabase
      .from("memory_bank")
      .select("content, score, original_id, created_at")
      .eq("conversation_id", conversationId)
      .eq("memory_type", "short")
      .order("created_at", { ascending: false })
      .limit(20);

    const { data: longMemories } = await supabase
      .from("memory_bank")
      .select("summary, keywords, original_id, compressed_at")
      .eq("conversation_id", conversationId)
      .eq("memory_type", "long")
      .order("compressed_at", { ascending: false })
      .limit(10);

    const { data: rules } = await supabase
      .from("memory_bank")
      .select("content")
      .eq("conversation_id", conversationId)
      .eq("memory_type", "rule")
      .order("created_at", { ascending: false })
      .limit(10);

    // 4. Build memory context for LLM
    const memoryContext: string[] = [];

    if (rules && rules.length > 0) {
      memoryContext.push("## 记忆规则");
      rules.forEach(r => memoryContext.push(`- ${r.content}`));
    }

    if (shortMemories && shortMemories.length > 0) {
      memoryContext.push("\n## 短期记忆（最近48小时）");
      shortMemories.forEach(m => {
        memoryContext.push(`[${new Date(m.created_at).toLocaleString("zh-CN")}] (评分${m.score?.toFixed(1)}) ${m.content}`);
      });
    }

    if (longMemories && longMemories.length > 0) {
      memoryContext.push("\n## 压缩记忆（48小时前，已压缩存档）");
      longMemories.forEach(m => {
        memoryContext.push(`【已压缩，锚点${m.original_id}】${m.summary} (关键词: ${m.keywords?.join(", ") || "无"})`);
      });
    }

    // 5. Stream LLM response
    const systemPrompt = `你是我的私人记忆管家，背后有一套自动的记忆压缩引擎在运行。

## 你的记忆库
${memoryContext.length > 0 ? memoryContext.join("\n") : "（目前记忆库为空，这是我们的第一次对话）"}

## 对话规则
1. 你永远不会"忘记"。每次用户提起旧事，你要先搜自己的记忆库（短期找不到就搜压缩记忆），然后自然回答。
2. 当检索到压缩记忆时，在回复末尾用小字注明：【此条已压缩，可说"展开记忆"恢复】
3. 绝对不要对用户说"删除了"，要说"为了省点脑容量，我把这条记忆压缩存档了。需要我展开吗？"
4. 当一天结束或者话题告一段落时，主动问："今天的信息我已经整理好了，帮你做了任务串联和评分。需要我生成今天的记忆简报吗？"
5. 回复风格：亲切、干练，像一个靠谱的朋友。
6. 如果用户告诉你某个重要规则或原则（如"每周五要交周报"），你要特别标注并记住为"规则"。
7. 记忆评分说明：0-0.2=琐碎闲聊，0.3-0.5=一般信息，0.6-0.8=重要决定/承诺，0.9-1.0=关键规则`;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...userMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          // First, send memory metadata
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: "memory_meta",
            newScore: score,
            compressedCount,
            memoryId,
          })}\n\n`));

          for await (const chunk of llmStream(messages, {
            temperature: 0.6,
          })) {
            const data = chunk.content || "";
            if (data) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "content", content: data })}\n\n`));
            }
          }
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        } catch (err) {
          const msg = err instanceof Error ? err.message : "流式响应失败";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`));
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
    console.error("[Memory Chat] Error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
