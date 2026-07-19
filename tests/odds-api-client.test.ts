import { describe, expect, it } from "vitest";
import {
  deletePredictions,
  fetchAnalysisDetail,
  fetchAutomationStatus,
  fetchPredictions,
  fetchRemoteText,
  loadFeishuWebhook,
  requestAutomationCompensation,
  saveFeishuWebhook,
  savePredictions,
  testFeishuWebhook,
  type FetchLike,
} from "@/features/odds/api-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("odds automation API client", () => {
  it("returns typed automation tasks from a successful status response", async () => {
    const fetcher: FetchLike = async (input) => {
      expect(String(input)).toBe("/api/automation/status?date=20260714");
      return jsonResponse({
        success: true,
        dateKey: "20260714",
        tasks: [
          {
            id: "task-1",
            taskType: "analysis",
            status: "running",
            currentStep: "generate",
            lastError: null,
            updatedAt: "2026-07-14T04:10:00.000Z",
          },
        ],
      });
    };

    await expect(fetchAutomationStatus(fetcher, "20260714")).resolves.toEqual([
      expect.objectContaining({ id: "task-1", taskType: "analysis", status: "running" }),
    ]);
  });

  it("rejects a non-success status payload with the server error", async () => {
    const fetcher: FetchLike = async () =>
      jsonResponse({ success: false, error: "任务状态查询失败" }, 503);

    await expect(fetchAutomationStatus(fetcher, "20260714")).rejects.toThrow(
      "任务状态查询失败",
    );
  });

  it("rejects malformed JSON with a stable response error", async () => {
    const fetcher: FetchLike = async () =>
      new Response("not-json", { status: 200 });

    await expect(fetchAutomationStatus(fetcher, "20260714")).rejects.toThrow(
      "自动化状态响应格式错误",
    );
  });

  it("posts compensation parameters and returns ensured task ids", async () => {
    const fetcher: FetchLike = async (input, init) => {
      expect(String(input)).toBe("/api/automation/compensate");
      expect(init).toMatchObject({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxTasks: 1 }),
      });
      return jsonResponse({
        success: true,
        ensured: ["task-1"],
        processed: ["task-1"],
      });
    };

    await expect(
      requestAutomationCompensation(fetcher, { maxTasks: 1 }),
    ).resolves.toEqual({ ensured: ["task-1"], processed: ["task-1"] });
  });

  it("rejects a success-false compensation payload", async () => {
    const fetcher: FetchLike = async () =>
      jsonResponse({ success: false, error: "北京时间12:02后才可补偿" });

    await expect(
      requestAutomationCompensation(fetcher, { maxTasks: 1 }),
    ).rejects.toThrow("北京时间12:02后才可补偿");
  });
});

describe("odds workstation API client", () => {
  it("loads, saves, and deletes prediction JSON without changing endpoint shapes", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetcher: FetchLike = async (input, init) => {
      calls.push([String(input), init]);
      if (init?.method === "POST") return jsonResponse({ success: true });
      if (init?.method === "DELETE") return jsonResponse({ success: true });
      return jsonResponse({ data: "[{\"home\":\"主队\"}]" });
    };

    await expect(fetchPredictions(fetcher, "20260714")).resolves.toBe('[{"home":"主队"}]');
    await savePredictions(fetcher, "20260714", "[]");
    await deletePredictions(fetcher, "20260714");

    expect(calls).toEqual([
      ["/api/prediction?date=20260714", undefined],
      ["/api/prediction", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ data: "[]", date: "20260714" }),
      })],
      ["/api/prediction?date=20260714", expect.objectContaining({ method: "DELETE" })],
    ]);
  });

  it("returns the detected date and server error from a failed URL fetch", async () => {
    const fetcher: FetchLike = async () =>
      jsonResponse({ detectedDate: "20260713", error: "目标页面拒绝访问" }, 403);

    await expect(fetchRemoteText(fetcher, "https://example.com/a")).resolves.toEqual({
      extractedJson: null,
      detectedDate: "20260713",
      error: "目标页面拒绝访问",
    });
  });

  it("preserves malformed JSON and transport errors for URL fetches", async () => {
    const malformedFetcher: FetchLike = async () => new Response("not-json", { status: 502 });
    const transportError = new Error("连接超时");
    const failingFetcher: FetchLike = async () => { throw transportError; };

    await expect(fetchRemoteText(malformedFetcher, "https://example.com/a")).rejects.toThrow(
      "抓取失败：响应格式错误",
    );
    await expect(fetchRemoteText(failingFetcher, "https://example.com/a")).rejects.toBe(
      transportError,
    );
  });

  it("normalizes analysis-detail failures", async () => {
    const fetcher: FetchLike = async () =>
      jsonResponse({ success: false, error: "详情不存在" }, 404);

    await expect(fetchAnalysisDetail(fetcher, "20260714", "m1")).rejects.toThrow("详情不存在");
  });

  it("loads, saves, and tests Feishu settings through typed boundaries", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetcher: FetchLike = async (input, init) => {
      calls.push([String(input), init]);
      if (String(input) === "/api/settings" && !init) {
        return jsonResponse({ success: true, settings: { feishu_webhook_url: "***masked***" } });
      }
      return jsonResponse({ success: true });
    };

    await expect(loadFeishuWebhook(fetcher)).resolves.toBe("***masked***");
    await saveFeishuWebhook(fetcher, "https://open.feishu.cn/hook");
    await expect(testFeishuWebhook(fetcher)).resolves.toEqual({ success: true, error: undefined });
    expect(calls[1]).toEqual(["/api/admin/settings", expect.objectContaining({
      method: "PATCH",
      body: expect.stringContaining('"feishu_webhook_url":"https://open.feishu.cn/hook"'),
    })]);
  });
});
