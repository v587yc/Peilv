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
 * AI analysis LLM retry policy (product requirement):
 * - Total attempts = 1 initial + 3 retries = 4
 * - Retry network/timeout/5xx AND 4xx business errors (400/401/403/404/422/429...)
 * - Config errors from loadLLMConfig() still fail immediately (no empty key thrash)
 */
export const LLM_MAX_RETRIES = 3;
export const LLM_MAX_ATTEMPTS = 1 + LLM_MAX_RETRIES;
const LLM_RETRY_BASE_DELAY_MS = 500;
const LLM_RETRY_MAX_DELAY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(failedAttempt: number): number {
  // failedAttempt is 1-based count of failures so far
  return Math.min(LLM_RETRY_MAX_DELAY_MS, LLM_RETRY_BASE_DELAY_MS * (2 ** (failedAttempt - 1)));
}

function isConfigOnlyLLMError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  // Only block retries for local configuration problems, not upstream 4xx.
  return /API Key 未配置|LLM API Key|Base URL 无效|未配置。请在 \/test-ai/i.test(message);
}

/**
 * Non-streaming LLM call with automatic retries.
 * Retries up to LLM_MAX_RETRIES times on network errors, empty content, and all HTTP 4xx/5xx.
 */
export async function llmInvoke(
  messages: ChatMessage[],
  options?: LLMOptions
): Promise<LLMResponse> {
  const { apiKey, baseUrl, model } = await loadLLMConfig();
  let lastError: unknown;

  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
    try {
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
      if (!String(content).trim()) {
        throw new Error("LLM API error 503: empty content");
      }

      if (attempt > 1) {
        console.warn(`[LLM] invoke succeeded on attempt ${attempt}/${LLM_MAX_ATTEMPTS}`);
      }
      return { content };
    } catch (error) {
      lastError = error;
      // Local config errors: fail fast (do not burn retries).
      if (isConfigOnlyLLMError(error)) throw error;

      if (attempt >= LLM_MAX_ATTEMPTS) {
        if (error instanceof Error) {
          error.message = `${error.message}（已重试${LLM_MAX_RETRIES}次）`;
        }
        throw error;
      }

      const delay = retryDelayMs(attempt);
      console.warn(
        `[LLM] invoke failed (attempt ${attempt}/${LLM_MAX_ATTEMPTS}), retry in ${delay}ms:`,
        error instanceof Error ? error.message : error,
      );
      await sleep(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || "LLM failed"));
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
