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

export type WebSearchResult = { title: string; snippet: string; url: string };

function isWebSearchFlagEnabled(value: string | undefined | null, defaultValue: boolean): boolean {
  if (value == null || String(value).trim() === "") return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  return defaultValue;
}

/**
 * 是否启用通道 B（模型联网搜索）。DB `llm_web_search_enabled` 优先，env `LLM_WEB_SEARCH` 回退。
 * 默认 true（用户要求赛前新闻走模型联网）。
 */
async function isLLMWebSearchEnabled(): Promise<boolean> {
  try {
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from("app_settings")
      .select("key, value")
      .eq("key", "llm_web_search_enabled")
      .maybeSingle();

    if (data?.value != null && String(data.value).trim() !== "") {
      return isWebSearchFlagEnabled(data.value, true);
    }
  } catch {
    /* fall through to env */
  }
  return isWebSearchFlagEnabled(process.env.LLM_WEB_SEARCH, true);
}

function extractResponsesOutputText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;

  if (typeof obj.output_text === "string" && obj.output_text.trim()) {
    return obj.output_text.trim();
  }

  if (Array.isArray(obj.output)) {
    const parts: string[] = [];
    for (const item of obj.output) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (row.type === "message" && Array.isArray(row.content)) {
        for (const c of row.content) {
          if (!c || typeof c !== "object") continue;
          const part = c as Record<string, unknown>;
          if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
            parts.push(part.text);
          }
        }
      }
      if ((row.type === "output_text" || row.type === "text") && typeof row.text === "string") {
        parts.push(row.text);
      }
    }
    if (parts.length > 0) return parts.join("\n").trim();
  }

  return "";
}

function extractChatContent(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
          return (c as { text: string }).text;
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function summaryToResults(text: string): WebSearchResult[] {
  return [{ title: "赛前新闻摘要", snippet: text, url: "" }];
}

/** Per-attempt budget for model web search (does not use full LLM 90s). */
const LLM_WEB_SEARCH_ATTEMPT_TIMEOUT_MS = 20_000;

function isXaiOrGrokEndpoint(baseUrl: string, model: string): boolean {
  const host = baseUrl.toLowerCase();
  const m = model.toLowerCase();
  return host.includes("api.x.ai") || host.includes("x.ai/") || m.includes("grok");
}

function isDeprecatedLiveSearchError(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  const t = body.toLowerCase();
  return (
    t.includes("live search is deprecated") ||
    t.includes("agent tools api") ||
    (t.includes("search_parameters") && t.includes("deprecated"))
  );
}

/**
 * 通道 B：用当前 LLM 做联网搜索（需 Bearer API Key，不是免密钥）。
 *
 * xAI / Grok（官方文档）：
 * - 正确路径：POST /v1/responses + tools: [{ type: "web_search" }]（Agent Tools）
 * - 已废弃：chat + search_parameters（Live Search）→ 会 401 + deprecation 文案
 *
 * 其它 OpenAI 兼容中转：先试 /responses + web_search，再试 chat + tools web_search。
 * 默认 **不再调用** search_parameters，避免 Grok 固定 401 噪声。
 * 任一步成功即返回；全部失败 return null。失败只 warn。
 * 单次尝试约 20s 超时，避免拖死 AI 分析。
 */
export async function llmModelWebSearch(query: string): Promise<WebSearchResult[] | null> {
  let apiKey = "";
  let baseUrl = "";
  let model = "";
  try {
    const cfg = await loadLLMConfig();
    apiKey = cfg.apiKey;
    baseUrl = cfg.baseUrl;
    model = cfg.model;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[llmModelWebSearch] LLM 配置不可用: ${msg.slice(0, 160)}`);
    return null;
  }

  const userPrompt =
    `请联网搜索并摘要以下足球赛事的赛前新闻（伤停、阵容、近期状态、关键情报）。` +
    `用中文简洁列出要点，不要编造。查询：${query}`;
  const systemPrompt =
    "你是足球赛前情报助手。请基于联网搜索结果，用中文摘要伤停、阵容与赛前分析，不要编造。";
  const grokLike = isXaiOrGrokEndpoint(baseUrl, model);
  if (grokLike) {
    console.info("[llmModelWebSearch] provider=xai/grok → Agent Tools only (skip deprecated Live Search / search_parameters)");
  }

  const attemptSignal = () => AbortSignal.timeout(LLM_WEB_SEARCH_ATTEMPT_TIMEOUT_MS);

  // 1) Responses API + built-in web_search tool（OpenAI / xAI Agent Tools 主路径）
  try {
    const targetUrl = `${baseUrl}/responses`;
    const res = await safeOutboundFetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: userPrompt,
        tools: [{ type: "web_search" }],
        max_output_tokens: 600,
      }),
      signal: attemptSignal(),
    }, "llm");

    if (res.ok) {
      const data = await res.json();
      const text = extractResponsesOutputText(data);
      if (text) {
        console.info("[llmModelWebSearch] channel responses ok");
        return summaryToResults(text);
      }
      console.warn("[llmModelWebSearch] responses: empty output_text");
    } else {
      const errBody = await res.text().catch(() => "");
      if (isDeprecatedLiveSearchError(res.status, errBody)) {
        console.warn(
          `[llmModelWebSearch] responses reported deprecation/auth issue ${res.status} (not treated as missing key alone): ${errBody.slice(0, 160)}`,
        );
      } else {
        console.warn(
          `[llmModelWebSearch] responses HTTP ${res.status}: ${errBody.slice(0, 160)}`,
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[llmModelWebSearch] responses failed: ${msg.slice(0, 160)}`);
  }

  // 2) Chat Completions + tools web_search（部分中转只支持 chat）
  //    不再默认调用 search_parameters：xAI Live Search 已废弃，会返回 401 + deprecation。
  try {
    const targetUrl = `${baseUrl}/chat/completions`;
    const res = await safeOutboundFetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools: [{ type: "web_search" }],
        max_tokens: 600,
        temperature: 0.2,
      }),
      signal: attemptSignal(),
    }, "llm");

    if (res.ok) {
      const data = await res.json();
      const text = extractChatContent(data);
      if (text) {
        console.info("[llmModelWebSearch] channel chat tools web_search ok");
        return summaryToResults(text);
      }
      console.warn("[llmModelWebSearch] chat tools: empty content (tool_calls-only responses are not executed)");
    } else {
      const errBody = await res.text().catch(() => "");
      if (isDeprecatedLiveSearchError(res.status, errBody)) {
        console.warn(
          `[llmModelWebSearch] chat tools: Live Search/Agent Tools deprecation ${res.status}: ${errBody.slice(0, 160)}`,
        );
      } else {
        console.warn(
          `[llmModelWebSearch] chat tools HTTP ${res.status}: ${errBody.slice(0, 160)}`,
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[llmModelWebSearch] chat tools failed: ${msg.slice(0, 160)}`);
  }

  // 3) Legacy Live Search (search_parameters) — only for non-Grok gateways that still document it.
  //    Explicitly skipped for xAI/Grok to avoid guaranteed 401 noise.
  if (!grokLike && process.env.LLM_ALLOW_LEGACY_SEARCH_PARAMETERS === "1") {
    try {
      const targetUrl = `${baseUrl}/chat/completions`;
      const res = await safeOutboundFetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          search_parameters: { mode: "on", return_citations: true },
          max_tokens: 600,
          temperature: 0.2,
        }),
        signal: attemptSignal(),
      }, "llm");

      if (res.ok) {
        const data = await res.json();
        const text = extractChatContent(data);
        if (text) {
          console.info("[llmModelWebSearch] channel legacy search_parameters ok");
          return summaryToResults(text);
        }
      } else {
        const errBody = await res.text().catch(() => "");
        if (isDeprecatedLiveSearchError(res.status, errBody)) {
          console.warn(
            `[llmModelWebSearch] legacy search_parameters deprecated ${res.status}: ${errBody.slice(0, 160)}`,
          );
        } else {
          console.warn(
            `[llmModelWebSearch] legacy search_parameters HTTP ${res.status}: ${errBody.slice(0, 160)}`,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[llmModelWebSearch] legacy search_parameters failed: ${msg.slice(0, 160)}`);
    }
  } else if (grokLike) {
    console.info("[llmModelWebSearch] skipped deprecated Live Search (search_parameters) for Grok/xAI");
  }

  return null;
}

/**
 * 双通道 Web 搜索（赛前新闻）
 *
 * 通道 A（可选优先）：专用 SEARCH_API_KEY + SEARCH_BASE_URL；有结果即返回。
 * 通道 B（默认启用）：当前 LLM 配置做模型联网（Agent Tools / Responses web_search；Grok 不再走 Live Search）。
 * 全部失败 return null。
 */
export async function webSearch(
  query: string,
  maxResults: number = 5
): Promise<WebSearchResult[] | null> {
  // --- 通道 A：专用搜索 API ---
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

  if (!searchApiKey) searchApiKey = process.env.SEARCH_API_KEY || "";
  if (!searchBaseUrl) searchBaseUrl = process.env.SEARCH_BASE_URL || "";

  if (searchApiKey && searchBaseUrl) {
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

      if (res.ok) {
        const data = await res.json();
        const results = (data.results || data.web_items || null) as WebSearchResult[] | null;
        if (Array.isArray(results) && results.length > 0) {
          console.info(`[webSearch] channel A (dedicated search) ok, n=${results.length}`);
          return results;
        }
        console.warn("[webSearch] channel A returned no results, try channel B");
      } else {
        console.warn(`[webSearch] channel A HTTP ${res.status}, try channel B`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[webSearch] channel A failed, try channel B: ${msg.slice(0, 160)}`);
    }
  }

  // --- 通道 B：模型联网搜索 ---
  if (!(await isLLMWebSearchEnabled())) {
    console.warn("[webSearch] channel B disabled (llm_web_search_enabled / LLM_WEB_SEARCH)");
    return null;
  }

  return llmModelWebSearch(query);
}
