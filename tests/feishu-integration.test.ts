import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearWebhookCache,
  getFeishuWebhookUrl,
  MASKED_FEISHU_WEBHOOK_VALUE,
} from "@/lib/integrations/feishu/settings";
import {
  sendFeishuPayload,
  sendFeishuText,
} from "@/lib/integrations/feishu/notifier";

afterEach(() => {
  clearWebhookCache();
  vi.restoreAllMocks();
});

describe("Feishu settings", () => {
  it("returns no webhook when neither environment nor storage is configured", async () => {
    await expect(getFeishuWebhookUrl({
      envUrl: "",
      loadStoredWebhookUrl: vi.fn().mockResolvedValue(""),
    })).resolves.toBe("");
  });

  it("rejects the masked settings placeholder as a real webhook", async () => {
    await expect(getFeishuWebhookUrl({
      envUrl: MASKED_FEISHU_WEBHOOK_VALUE,
      loadStoredWebhookUrl: vi.fn().mockResolvedValue(MASKED_FEISHU_WEBHOOK_VALUE),
    })).resolves.toBe("");
  });
});

describe("Feishu notifier", () => {
  it("sends the existing text payload shape and reports success", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0 })));

    await expect(sendFeishuText("任务完成", {
      getWebhookUrl: vi.fn().mockResolvedValue("https://open.feishu.cn/open-apis/bot/v2/hook/test"),
      fetcher,
    })).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/bot/v2/hook/test",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg_type: "text", content: { text: "任务完成" } }),
      }),
    );
  });

  it("preserves provider failure details for the HTTP adapter", async () => {
    const detail = { code: 19001, msg: "invalid webhook" };
    const result = await sendFeishuPayload(
      { msg_type: "text", content: { text: "test" } },
      {
        getWebhookUrl: vi.fn().mockResolvedValue("https://open.feishu.cn/open-apis/bot/v2/hook/test"),
        fetcher: vi.fn().mockResolvedValue(new Response(JSON.stringify(detail))),
      },
    );

    expect(result).toEqual({ success: false, detail, error: "invalid webhook" });
  });

  it("returns false when an injected notifier dependency fails externally", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));

    await expect(sendFeishuText("任务失败", {
      getWebhookUrl: vi.fn().mockResolvedValue("https://open.feishu.cn/open-apis/bot/v2/hook/test"),
      fetcher,
    })).resolves.toBe(false);
  });
});
