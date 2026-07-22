import { NextRequest, NextResponse } from "next/server";
import { llmInvoke, llmStream, clearLLMConfigCache } from "@/lib/llm";
import { writeAuditLog } from "@/lib/audit-log";

// GET: 读取当前 LLM 配置 + 环境变量状态
export async function GET() {
  // Read from DB
  const dbSettings: Record<string, string> = {};
  try {
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", [
        "llm_api_key",
        "llm_base_url",
        "llm_model",
        "llm_web_search_enabled",
        "search_api_key",
        "search_base_url",
      ]);

    if (data) {
      for (const row of data) {
        dbSettings[row.key] = row.value;
      }
    }
  } catch { /* DB not available */ }

  const hasEnvApiKey = !!process.env.LLM_API_KEY;
  const hasSupabase = !!process.env.COZE_SUPABASE_URL;

  // 模型联网默认 true；DB 优先，env LLM_WEB_SEARCH 回退
  const webSearchRaw =
    dbSettings.llm_web_search_enabled
    || process.env.LLM_WEB_SEARCH
    || "true";
  const llmWebSearchEnabled = !["0", "false", "off", "no"].includes(
    String(webSearchRaw).trim().toLowerCase(),
  );

  return NextResponse.json({
    // DB settings (masked)
    db: {
      llm_api_key: dbSettings.llm_api_key ? maskKey(dbSettings.llm_api_key) : "",
      llm_base_url: dbSettings.llm_base_url || "",
      llm_model: dbSettings.llm_model || "",
      llm_web_search_enabled: llmWebSearchEnabled ? "true" : "false",
      search_api_key: dbSettings.search_api_key ? maskKey(dbSettings.search_api_key) : "",
      search_base_url: dbSettings.search_base_url || "",
    },
    // Env fallback status
    env: {
      LLM_API_KEY: hasEnvApiKey ? "已配置" : "未配置",
      LLM_BASE_URL: process.env.LLM_BASE_URL || "",
      LLM_MODEL: process.env.LLM_MODEL || "",
      LLM_WEB_SEARCH: process.env.LLM_WEB_SEARCH || "",
      COZE_SUPABASE_URL: hasSupabase ? "已配置" : "未配置",
    },
    // Is LLM ready?
    ready: !!(dbSettings.llm_api_key || hasEnvApiKey),
  });
}

// POST: 保存 LLM 配置 或 测试调用
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const action = body.action; // "save" | "test"

  if (action === "save") {
    return saveSettings(body, request);
  }

  if (action === "test") {
    return testLLM(body);
  }

  return NextResponse.json({ error: "未知 action，支持 save 或 test" }, { status: 400 });
}

// Save LLM settings to database
async function saveSettings(body: Record<string, unknown>, request: NextRequest) {
  const settings: Record<string, string> = {};

  if (body.llm_api_key !== undefined) settings.llm_api_key = String(body.llm_api_key);
  if (body.llm_base_url !== undefined) settings.llm_base_url = String(body.llm_base_url).trim();
  if (body.llm_model !== undefined) settings.llm_model = String(body.llm_model).trim();
  if (body.llm_web_search_enabled !== undefined) {
    const raw = String(body.llm_web_search_enabled).trim().toLowerCase();
    settings.llm_web_search_enabled =
      raw === "0" || raw === "false" || raw === "off" || raw === "no" ? "false" : "true";
  }
  if (body.search_api_key !== undefined) settings.search_api_key = String(body.search_api_key);
  if (body.search_base_url !== undefined) settings.search_base_url = String(body.search_base_url).trim();

  if (Object.keys(settings).length === 0) {
    return NextResponse.json({ error: "没有需要保存的设置" }, { status: 400 });
  }

  if (settings.llm_base_url !== undefined) {
    const raw = settings.llm_base_url;
    if (!raw || raw === "undefined" || raw === "null") {
      return NextResponse.json(
        { error: "Base URL 无效：不能为空或字面量 undefined/null" },
        { status: 400 },
      );
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return NextResponse.json({ error: "Base URL 仅支持 http/https" }, { status: 400 });
      }
      if (!parsed.hostname || parsed.hostname === "undefined" || parsed.hostname === "null") {
        return NextResponse.json(
          { error: "Base URL 主机名无效，请填写真实域名或 IP（如 api.openai.com 或 127.0.0.1）" },
          { status: 400 },
        );
      }
    } catch {
      return NextResponse.json(
        { error: `Base URL 无法解析：${raw}。示例：https://api.openai.com/v1` },
        { status: 400 },
      );
    }
  }

  try {
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const supabase = getSupabaseClient();
    const changedKeys = Object.keys(settings);
    const oldSettings: Record<string, string> = {};
    const { data: existingSettings } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", changedKeys);
    for (const row of existingSettings || []) {
      oldSettings[row.key] = row.value;
    }

    for (const [key, value] of Object.entries(settings)) {
      const { error } = await supabase
        .from("app_settings")
        .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });

      if (error) {
        return NextResponse.json({ error: `保存 ${key} 失败: ${error.message}` }, { status: 500 });
      }
    }

    // Clear cache so next LLM call uses new config
    clearLLMConfigCache();

    await writeAuditLog({
      actorId: request.headers.get("x-authenticated-actor-id") || "single-team-admin",
      actorType: request.headers.get("x-authenticated-actor-type") === "internal" ? "internal" : "admin",
      action: "configuration_update",
      objectType: "app_settings",
      objectId: "llm",
      requestId: request.headers.get("x-request-id"),
      oldValue: oldSettings,
      newValue: settings,
      metadata: { changedKeys },
    });

    return NextResponse.json({ success: true, saved: changedKeys });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "数据库不可用";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Test LLM call
async function testLLM(body: Record<string, unknown>) {
  const mode = body.mode || "invoke"; // "invoke" | "stream"
  const prompt = (body.prompt as string) || "你好，请用一句话介绍自己。";

  const messages = [
    { role: "system" as const, content: "你是一个AI助手。" },
    { role: "user" as const, content: prompt },
  ];

  if (mode === "stream") {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for await (const chunk of llmStream(messages, { temperature: 0.7 })) {
            if (chunk.content) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: chunk.content })}\n\n`));
            }
          }
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        } catch (err) {
          const msg = err instanceof Error ? err.message : "流式调用失败";
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
      },
    });
  }

  // Non-streaming
  const startTime = Date.now();
  try {
    const result = await llmInvoke(messages, { temperature: 0.7 });
    const elapsed = Date.now() - startTime;
    return NextResponse.json({ success: true, content: result.content, elapsed: `${elapsed}ms` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "调用失败";
    // Surface root-cause details for connection/config failures (e.g. Invalid IP / ECONNREFUSED).
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
