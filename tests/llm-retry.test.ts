import { afterEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("@/lib/safe-fetch", () => ({
  safeOutboundFetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock("@/storage/database/supabase-client", () => ({
  getSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        in: async () => ({ data: [] }),
      }),
    }),
  }),
}));

describe("llmInvoke automatic retries for AI analysis", () => {
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
  });

  it("retries 4xx business errors up to 3 extra times then succeeds (4 total)", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("LLM_BASE_URL", "https://api.openai.com/v1");
    vi.stubEnv("LLM_MODEL", "gpt-4o-mini");
    const { clearLLMConfigCache, llmInvoke } = await import("@/lib/llm");
    clearLLMConfigCache();

    fetchMock
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "ok-after-4xx-retries" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const result = await llmInvoke([{ role: "user", content: "hi" }], { temperature: 0 });
    expect(result.content).toBe("ok-after-4xx-retries");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries persistent 401 three times then fails with retry note", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("LLM_BASE_URL", "https://api.openai.com/v1");
    vi.stubEnv("LLM_MODEL", "gpt-4o-mini");
    const { clearLLMConfigCache, llmInvoke } = await import("@/lib/llm");
    clearLLMConfigCache();

    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(llmInvoke([{ role: "user", content: "hi" }])).rejects.toThrow(/已重试3次/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries empty content and network timeouts", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("LLM_BASE_URL", "https://api.openai.com/v1");
    vi.stubEnv("LLM_MODEL", "gpt-4o-mini");
    const { clearLLMConfigCache, llmInvoke } = await import("@/lib/llm");
    clearLLMConfigCache();

    fetchMock
      .mockRejectedValueOnce(new Error("出站请求超时(90000ms)"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const result = await llmInvoke([{ role: "user", content: "hi" }]);
    expect(result.content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
