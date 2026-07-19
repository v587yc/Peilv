import { afterEach, describe, expect, it } from "vitest";
import { validateSettingValue } from "@/features/management/settings-service";

const originalHosts = process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS;

afterEach(() => {
  if (originalHosts === undefined) delete process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS;
  else process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS = originalHosts;
});

describe("management outbound URL settings", () => {
  it("accepts official endpoints by setting type", () => {
    expect(validateSettingValue("llm_base_url", "https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    expect(validateSettingValue("search_base_url", "https://api.tavily.com/search")).toBe("https://api.tavily.com/search");
    expect(validateSettingValue("feishu_webhook_url", "https://open.feishu.cn/open-apis/bot/v2/hook/example")).toContain("open.feishu.cn");
  });

  it("requires explicit administrator approval for a custom OpenAI-compatible host", () => {
    expect(() => validateSettingValue("llm_base_url", "https://llm.example.invalid/v1")).toThrow("域名不在允许列表");
    process.env.ADMIN_OUTBOUND_ALLOWED_HOSTS = "llm.example.invalid";
    expect(() => validateSettingValue("llm_base_url", "https://llm.example.invalid/v1")).not.toThrow();
  });

  it.each([
    "http://api.openai.com/v1",
    "https://user:pass@api.openai.com/v1",
    "https://api.openai.com/v1#fragment",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://2130706433/v1",
  ])("rejects unsafe LLM setting %s", value => {
    expect(() => validateSettingValue("llm_base_url", value)).toThrow("安全出站策略");
  });
});
