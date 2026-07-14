import type { AnalysisResultData, AutomationTaskStatusData } from "./contracts";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface ErrorPayload {
  success?: false;
  error?: string;
}

interface AutomationStatusPayload {
  success: true;
  dateKey: string;
  tasks: AutomationTaskStatusData[];
}

interface AutomationCompensationPayload {
  success: true;
  ensured: string[];
  processed: string[];
}

export interface AutomationCompensationInput {
  maxTasks?: number;
}

async function readJson(
  response: Response,
  invalidResponseMessage: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(invalidResponseMessage);
  }
}

function serverError(payload: unknown, fallback: string): Error {
  const error = (payload as ErrorPayload | null)?.error;
  return new Error(typeof error === "string" && error ? error : fallback);
}

async function requestJson<T>(
  fetcher: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fallback: string,
): Promise<T> {
  const response = await fetcher(input, init);
  const payload = await readJson(response, `${fallback}：响应格式错误`);
  const success = (payload as { success?: unknown } | null)?.success;
  if (!response.ok || success !== true) throw serverError(payload, fallback);
  return payload as T;
}

export async function fetchPredictions(fetcher: FetchLike, dateKey: string): Promise<string> {
  const response = await fetcher(`/api/prediction?date=${encodeURIComponent(dateKey)}`);
  const payload = await readJson(response, "加载预测数据失败：响应格式错误") as {
    data?: unknown;
    error?: string;
  };
  if (!response.ok) throw serverError(payload, "加载预测数据失败");
  return typeof payload.data === "string" ? payload.data : "";
}

export async function fetchPredictionDates(fetcher: FetchLike): Promise<string[]> {
  const response = await fetcher("/api/prediction");
  const payload = await readJson(response, "加载预测日期失败：响应格式错误") as {
    dates?: Array<{ date_key?: unknown }>;
  } & ErrorPayload;
  if (!response.ok) throw serverError(payload, "加载预测日期失败");
  return Array.isArray(payload.dates)
    ? payload.dates.flatMap((item) => typeof item.date_key === "string" ? [item.date_key] : [])
    : [];
}

export async function savePredictions(fetcher: FetchLike, dateKey: string, jsonContent: string): Promise<void> {
  await requestJson(fetcher, "/api/prediction", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: jsonContent, date: dateKey }),
  }, "保存预测数据失败");
}

export async function deletePredictions(fetcher: FetchLike, dateKey: string): Promise<void> {
  await requestJson(fetcher, `/api/prediction?date=${encodeURIComponent(dateKey)}`, {
    method: "DELETE",
  }, "删除预测数据失败");
}

export interface RemoteTextResult {
  extractedJson: string | null;
  detectedDate: string;
  error?: string;
}

export async function fetchRemoteText(fetcher: FetchLike, url: string): Promise<RemoteTextResult> {
  const response = await fetcher("/api/fetch-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const payload = await readJson(response, "抓取失败：响应格式错误") as {
    extractedJson?: unknown;
    detectedDate?: unknown;
    error?: unknown;
  };
  return {
    extractedJson: typeof payload.extractedJson === "string" ? payload.extractedJson : null,
    detectedDate: typeof payload.detectedDate === "string" ? payload.detectedDate : "",
    error: typeof payload.error === "string" && payload.error
      ? payload.error
      : response.ok ? undefined : "抓取失败",
  };
}

export async function fetchAnalysisDetail(
  fetcher: FetchLike,
  dateKey: string,
  matchId: string,
): Promise<AnalysisResultData | null> {
  const payload = await requestJson<{ success: true; prediction?: AnalysisResultData }>(
    fetcher,
    `/api/analysis?date=${encodeURIComponent(dateKey)}&detail=1&matchId=${encodeURIComponent(matchId)}`,
    undefined,
    "加载分析详情失败",
  );
  return payload.prediction ?? null;
}

export async function loadFeishuWebhook(fetcher: FetchLike): Promise<string> {
  const payload = await requestJson<{ success: true; settings?: Record<string, unknown> }>(
    fetcher, "/api/settings", undefined, "加载飞书设置失败",
  );
  const webhook = payload.settings?.feishu_webhook_url;
  return typeof webhook === "string" ? webhook : "";
}

export async function saveFeishuWebhook(fetcher: FetchLike, webhook: string): Promise<void> {
  await requestJson(fetcher, "/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: { feishu_webhook_url: webhook } }),
  }, "保存飞书设置失败");
}

export async function testFeishuWebhook(
  fetcher: FetchLike,
): Promise<{ success: boolean; error: string | undefined }> {
  const response = await fetcher("/api/feishu/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "test" }),
  });
  const payload = await readJson(response, "飞书测试响应格式错误") as { success?: unknown; error?: unknown };
  return {
    success: response.ok && payload.success === true,
    error: typeof payload.error === "string" ? payload.error : undefined,
  };
}

export async function fetchAutomationStatus(
  fetcher: FetchLike,
  dateKey: string,
): Promise<AutomationTaskStatusData[]> {
  const response = await fetcher(
    `/api/automation/status?date=${encodeURIComponent(dateKey)}`,
  );
  const payload = await readJson(response, "自动化状态响应格式错误");
  const status = payload as Partial<AutomationStatusPayload> & ErrorPayload;

  if (!response.ok || status.success !== true) {
    throw serverError(payload, "任务状态查询失败");
  }
  if (!Array.isArray(status.tasks)) {
    throw new Error("自动化状态响应格式错误");
  }

  return status.tasks;
}

export async function requestAutomationCompensation(
  fetcher: FetchLike,
  input: AutomationCompensationInput,
): Promise<{ ensured: string[]; processed: string[] }> {
  const response = await fetcher("/api/automation/compensate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await readJson(response, "自动化补偿响应格式错误");
  const compensation = payload as Partial<AutomationCompensationPayload> & ErrorPayload;

  if (!response.ok || compensation.success !== true) {
    throw serverError(payload, "补偿失败");
  }
  if (!Array.isArray(compensation.ensured) || !Array.isArray(compensation.processed)) {
    throw new Error("自动化补偿响应格式错误");
  }

  return {
    ensured: compensation.ensured,
    processed: compensation.processed,
  };
}
