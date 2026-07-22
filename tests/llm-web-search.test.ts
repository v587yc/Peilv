import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { safeOutboundFetch } = vi.hoisted(() => ({
  safeOutboundFetch: vi.fn(),
}));

vi.mock("@/lib/safe-fetch", () => ({
  safeOutboundFetch,
  assertOutboundUrl: (input: string) => new URL(input),
}));

vi.mock("@/storage/database/supabase-client", () => ({
  getSupabaseClient: () => {
    throw new Error("db unavailable in unit test");
  },
}));

import { clearLLMConfigCache, llmModelWebSearch } from "@/lib/llm";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("llmModelWebSearch Grok / Agent Tools", () => {
  beforeEach(() => {
    clearLLMConfigCache();
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_BASE_URL = "https://api.x.ai/v1";
    process.env.LLM_MODEL = "grok-4";
    delete process.env.LLM_ALLOW_LEGACY_SEARCH_PARAMETERS;
    safeOutboundFetch.mockReset();
  });

  afterEach(() => {
    clearLLMConfigCache();
    vi.restoreAllMocks();
  });

  it("uses Responses + web_search and never calls search_parameters for xAI/Grok", async () => {
    safeOutboundFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        output_text: "伤停：主力前锋缺阵。",
      }),
    );

    const result = await llmModelWebSearch("阿森纳 切尔西 伤停");
    expect(result?.[0]?.snippet).toContain("伤停");
    expect(safeOutboundFetch).toHaveBeenCalledTimes(1);
    const [url, init] = safeOutboundFetch.mock.calls[0];
    expect(String(url)).toContain("/responses");
    const body = JSON.parse(String(init.body));
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.search_parameters).toBeUndefined();
  });

  it("falls back to chat tools without search_parameters when responses fails", async () => {
    safeOutboundFetch
      .mockResolvedValueOnce(
        jsonResponse(404, { error: "not found" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          choices: [{ message: { content: "赛前情报：客队后卫停赛。" } }],
        }),
      );

    const result = await llmModelWebSearch("曼城 利物浦 赛前");
    expect(result?.[0]?.snippet).toContain("后卫");
    expect(safeOutboundFetch).toHaveBeenCalledTimes(2);
    const bodies = safeOutboundFetch.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)),
    );
    expect(bodies.every((b) => b.search_parameters === undefined)).toBe(true);
    expect(bodies[1].tools).toEqual([{ type: "web_search" }]);
  });

  it("classifies Live Search deprecation without calling legacy search_parameters on Grok", async () => {
    safeOutboundFetch
      .mockResolvedValueOnce(
        jsonResponse(401, {
          error: "Live search is deprecated. Please switch to the Agent Tools API",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(401, {
          error: "Live search is deprecated. Please switch to the Agent Tools API",
        }),
      );

    const result = await llmModelWebSearch("测试 伤停");
    expect(result).toBeNull();
    expect(safeOutboundFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of safeOutboundFetch.mock.calls) {
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body.search_parameters).toBeUndefined();
    }
  });
});
