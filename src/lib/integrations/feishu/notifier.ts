import type {
  FeishuNotifierDependencies,
  FeishuPayload,
  FeishuProviderResult,
  FeishuSendResult,
  FeishuTextElement,
} from "./contracts";
import { getFeishuWebhookUrl } from "./settings";

export async function sendFeishuPayload(
  payload: FeishuPayload,
  dependencies: FeishuNotifierDependencies = {},
): Promise<FeishuSendResult> {
  const webhookUrl = await (dependencies.getWebhookUrl ?? getFeishuWebhookUrl)();
  if (!webhookUrl) return { success: false, error: "飞书Webhook未配置，请先在设置中填写Webhook URL" };

  try {
    const response = await (dependencies.fetcher ?? fetch)(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const detail = await response.json() as FeishuProviderResult;
    if (detail.code === 0 || detail.StatusCode === 0) return { success: true, detail };
    return {
      success: false,
      error: detail.msg || detail.StatusMessage || "飞书发送失败",
      detail,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "未知错误", transportError: true };
  }
}

async function sendBoolean(payload: FeishuPayload, dependencies?: FeishuNotifierDependencies): Promise<boolean> {
  return (await sendFeishuPayload(payload, dependencies)).success;
}

export async function sendFeishuText(text: string, dependencies?: FeishuNotifierDependencies): Promise<boolean> {
  return sendBoolean({ msg_type: "text", content: { text } }, dependencies);
}

export async function sendFeishuPost(title: string, sections: FeishuTextElement[][]): Promise<boolean> {
  return sendBoolean({ msg_type: "post", content: { post: { zh_cn: { title, content: sections } } } });
}

export async function sendFeishuAIAnalysis(params: {
  homeTeam: string; awayTeam: string; league: string; matchTime: string; waterDirection: string;
  prediction: string; confidenceLevel: string; strategy: string; reasoning: string;
}): Promise<boolean> {
  const { homeTeam, awayTeam, league, matchTime, waterDirection, prediction, confidenceLevel, strategy, reasoning } = params;
  const directionEmoji = waterDirection === "主降水" ? "🔵" : waterDirection === "客降水" ? "🟠" : "⚪";
  const predictionEmoji = prediction === "主" ? "🏠" : prediction === "客" ? "✈️" : "⚖️";
  return sendFeishuPost(`⚽ AI分析: ${homeTeam} vs ${awayTeam}`, [
    [{ tag: "text", text: `${league} ${matchTime}\n` }],
    [{ tag: "text", text: `${directionEmoji} 水位方向: ` }, { tag: "text", text: waterDirection }, { tag: "text", text: `\n${predictionEmoji} 推荐: ${prediction}\n` }, { tag: "text", text: `📊 置信度: ${confidenceLevel}\n` }, { tag: "text", text: `💡 策略: ${strategy}` }],
    [{ tag: "text", text: `\n📝 ${reasoning.substring(0, 200)}${reasoning.length > 200 ? "..." : ""}` }],
  ]);
}

export async function sendFeishuTaskComplete(params: { taskName: string; count: number; duration?: string; details?: string }): Promise<boolean> {
  const { taskName, count, duration, details } = params;
  return sendFeishuPost(`⏰ 定时任务完成: ${taskName}`, [[
    { tag: "text", text: `✅ 任务: ${taskName}\n` }, { tag: "text", text: `📈 处理: ${count}场赛事\n` },
    ...(duration ? [{ tag: "text", text: `⏱️ 耗时: ${duration}\n` }] : []),
    ...(details ? [{ tag: "text", text: `📋 ${details}` }] : []),
  ]]);
}

export async function sendFeishuVerifyResult(params: {
  date: string; total: number; correct: number; accuracy: string;
  waterDirectionStats?: Record<string, { total: number; correct: number; rate: string }>;
  topPatterns?: Array<{ pattern_key: string; hit_rate: string; total_predictions: number }>;
}): Promise<boolean> {
  const { date, total, correct, accuracy, waterDirectionStats, topPatterns } = params;
  const sections: FeishuTextElement[][] = [[{ tag: "text", text: `📅 日期: ${date}\n` }, { tag: "text", text: `📊 总计: ${total}场 | 正确: ${correct}场 | 准确率: ${accuracy}\n` }]];
  if (waterDirectionStats) sections.push([{ tag: "text", text: `\n🔮 水位方向统计:\n${Object.entries(waterDirectionStats).map(([dir, s]) => `${dir}: ${s.correct}/${s.total} (${s.rate}%)`).join("\n")}` }]);
  if (topPatterns?.length) sections.push([{ tag: "text", text: `\n🧠 高命中模式:\n${topPatterns.slice(0, 5).map((p) => `${p.pattern_key}: ${p.hit_rate} (${p.total_predictions}场)`).join("\n")}` }]);
  return sendFeishuPost("🔍 AI验证+学习结果", sections);
}

export async function sendFeishuOddsAlert(params: { homeTeam: string; awayTeam: string; league: string; matchTime: string; alertType: string; currentValue: string; threshold: string }): Promise<boolean> {
  const { homeTeam, awayTeam, league, matchTime, alertType, currentValue, threshold } = params;
  return sendFeishuPost(`🚨 赔率提醒: ${homeTeam} vs ${awayTeam}`, [[{ tag: "text", text: `${league} ${matchTime}\n` }, { tag: "text", text: `⚠️ ${alertType}\n` }, { tag: "text", text: `当前值: ${currentValue} | 阈值: ${threshold}` }]]);
}
