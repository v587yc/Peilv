/**
 * OpenAI-compatible LLM client
 * Supports config from database (app_settings) with env var fallback
 */
import { safeOutboundFetch } from "@/lib/safe-fetch";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

interface LLMResponse {
  content: string;
}

interface StreamChunk {
  content: string;
}

interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const LLM_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const LLM_DEFAULT_MODEL = "gpt-4o-mini";

// Cached config from database
let cachedConfig: LLMConfig | null = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Clear cached config (call after saving new settings)
 */
export function clearLLMConfigCache(): void {
  cachedConfig = null;
  configCacheTime = 0;
}

/**
 * Load LLM config: database first, then env vars
 */
async function loadLLMConfig(): Promise<LLMConfig> {
  const now = Date.now();
  if (cachedConfig && now - configCacheTime < CONFIG_CACHE_TTL) {
    return cachedConfig;
  }

  // Try loading from database
  try {
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const supabase = getSupabaseClient();

    const { data } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["llm_api_key", "llm_base_url", "llm_model"]);

    if (data && data.length > 0) {
      const settings: Record<string, string> = {};
      for (const row of data) {
        settings[row.key] = row.value;
      }

      if (settings.llm_api_key) {
        cachedConfig = {
          apiKey: settings.llm_api_key,
          baseUrl: (settings.llm_base_url || LLM_DEFAULT_BASE_URL).replace(/\/+$/, ""),
          model: settings.llm_model || LLM_DEFAULT_MODEL,
        };
        configCacheTime = now;
        return cachedConfig;
      }
    }
  } catch {
    // DB not available, fall through to env vars
  }

  // Fallback to env vars
  const apiKey = process.env.LLM_API_KEY || "";
  const baseUrl = (process.env.LLM_BASE_URL || LLM_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = process.env.LLM_MODEL || LLM_DEFAULT_MODEL;

  if (!apiKey) {
    throw new Error("LLM API Key 未配置。请在 /test-ai 页面填写，或设置 LLM_API_KEY 环境变量。");
  }

  cachedConfig = { apiKey, baseUrl, model };
  configCacheTime = now;
  return cachedConfig;
}

/**
 * Non-streaming LLM call
 */
export async function llmInvoke(
  messages: ChatMessage[],
  options?: LLMOptions
): Promise<LLMResponse> {
  const { apiKey, baseUrl, model } = await loadLLMConfig();

  const res = await safeOutboundFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: options?.model || model,
      messages,
      temperature: options?.temperature ?? 0.3,
      ...(options?.max_tokens ? { max_tokens: options.max_tokens } : {}),
    }),
  }, "llm");

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`LLM API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";

  return { content };
}

/**
 * Streaming LLM call — yields content chunks
 */
export async function* llmStream(
  messages: ChatMessage[],
  options?: LLMOptions
): AsyncGenerator<StreamChunk> {
  const { apiKey, baseUrl, model } = await loadLLMConfig();

  const res = await safeOutboundFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: options?.model || model,
      messages,
      temperature: options?.temperature ?? 0.3,
      stream: true,
      ...(options?.max_tokens ? { max_tokens: options.max_tokens } : {}),
    }),
  }, "llm");

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`LLM API error ${res.status}: ${errBody}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6);
      if (payload === "[DONE]") return;

      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          yield { content: delta };
        }
      } catch {
        // skip malformed chunks
      }
    }
  }
}

async function openAIWebSearch(
  query: string,
  maxResults: number
): Promise<{ title: string; snippet: string; url: string }[] | null> {
  try {
    const { apiKey, baseUrl, model } = await loadLLMConfig();
    const res = await safeOutboundFetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: `请联网搜索并摘要以下足球比赛相关新闻，重点关注伤停、阵容、赛前动态、盘口相关消息。查询：${query}`,
        tools: [{ type: "web_search" }],
        max_output_tokens: 500,
      }),
    }, "llm");

    if (!res.ok) return null;

    const data = await res.json();
    const texts: string[] = [];
    for (const item of data.output || []) {
      if (item.type !== "message") continue;
      for (const content of item.content || []) {
        if (content.type === "output_text" && content.text) texts.push(content.text);
      }
    }

    const summary = texts.join("\n").trim();
    if (!summary) return null;

    return [{
      title: "OpenAI 联网搜索摘要",
      snippet: summary,
      url: "",
    }].slice(0, maxResults);
  } catch {
    return null;
  }
}

/**
 * Web search — simple wrapper using search API
 * Falls back to OpenAI Responses web_search when no search API is configured
 */
export async function webSearch(
  query: string,
  maxResults: number = 5
): Promise<{ title: string; snippet: string; url: string }[] | null> {
  // Try DB settings first
  let searchApiKey = "";
  let searchBaseUrl = "";

  try {
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["search_api_key", "search_base_url"]);

    if (data) {
      for (const row of data) {
        if (row.key === "search_api_key") searchApiKey = row.value;
        if (row.key === "search_base_url") searchBaseUrl = row.value;
      }
    }
  } catch { /* fall through */ }

  // Fallback to env vars
  if (!searchApiKey) searchApiKey = process.env.SEARCH_API_KEY || "";
  if (!searchBaseUrl) searchBaseUrl = process.env.SEARCH_BASE_URL || "";

  if (!searchApiKey || !searchBaseUrl) {
    return openAIWebSearch(query, maxResults);
  }

  try {
    const res = await safeOutboundFetch(`${searchBaseUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${searchApiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
      }),
    }, "search");

    if (!res.ok) return openAIWebSearch(query, maxResults);

    const data = await res.json();
    return data.results || data.web_items || openAIWebSearch(query, maxResults);
  } catch {
    return openAIWebSearch(query, maxResults);
  }
}
