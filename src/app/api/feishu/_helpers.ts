/**
 * Feishu notification helper functions
 * Sends formatted messages to Feishu group via webhook
 */

interface FeishuTextElement {
  tag: string;
  text?: string;
  user_id?: string;
}

// Cache webhook URL (refreshed every 5 minutes)
let cachedWebhookUrl = "";
let webhookCacheTime = 0;

/**
 * Clear cached webhook URL (call after saving new URL)
 */
export function clearWebhookCache(): void {
  cachedWebhookUrl = "";
  webhookCacheTime = 0;
}

async function getWebhookUrl(): Promise<string> {
  // Check env var first (set by settings API at runtime)
  const envUrl = process.env.FEISHU_WEBHOOK_URL || "";
  if (envUrl) return envUrl;

  // Cache for 5 minutes
  const now = Date.now();
  if (cachedWebhookUrl && now - webhookCacheTime < 300000) {
    return cachedWebhookUrl;
  }

  // Load from DB
  try {
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "feishu_webhook_url")
      .single();

    if (data?.value) {
      cachedWebhookUrl = data.value;
      webhookCacheTime = now;
      return cachedWebhookUrl;
    }
  } catch {
    // DB not available
  }

  return "";
}

/**
 * Send raw payload to Feishu webhook
 */
async function sendToFeishu(payload: Record<string, unknown>): Promise<boolean> {
  const webhookUrl = await getWebhookUrl();
  if (!webhookUrl) return false;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    return result.code === 0 || result.StatusCode === 0;
  } catch {
    return false;
  }
}

/**
 * Send simple text message
 */
export async function sendFeishuText(text: string): Promise<boolean> {
  return sendToFeishu({
    msg_type: "text",
    content: { text },
  });
}

/**
 * Send rich text (post) message with title and sections
 */
export async function sendFeishuPost(
  title: string,
  sections: FeishuTextElement[][]
): Promise<boolean> {
  return sendToFeishu({
    msg_type: "post",
    content: {
      post: {
        zh_cn: {
          title,
          content: sections,
        },
      },
    },
  });
}

/**
 * Send AI analysis result notification
 */
export async function sendFeishuAIAnalysis(params: {
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchTime: string;
  waterDirection: string;
  prediction: string;
  confidenceLevel: string;
  strategy: string;
  reasoning: string;
}): Promise<boolean> {
  const { homeTeam, awayTeam, league, matchTime, waterDirection, prediction, confidenceLevel, strategy, reasoning } = params;

  const directionEmoji = waterDirection === "主降水" ? "🔵" : waterDirection === "客降水" ? "🟠" : "⚪";
  const predictionEmoji = prediction === "主" ? "🏠" : prediction === "客" ? "✈️" : "⚖️";

  return sendFeishuPost(
    `⚽ AI分析: ${homeTeam} vs ${awayTeam}`,
    [
      [
        { tag: "text", text: `${league} ${matchTime}\n` },
      ],
      [
        { tag: "text", text: `${directionEmoji} 水位方向: ` },
        { tag: "text", text: waterDirection },
        { tag: "text", text: `\n${predictionEmoji} 推荐: ${prediction}\n` },
        { tag: "text", text: `📊 置信度: ${confidenceLevel}\n` },
        { tag: "text", text: `💡 策略: ${strategy}` },
      ],
      [
        { tag: "text", text: `\n📝 ${reasoning.substring(0, 200)}${reasoning.length > 200 ? "..." : ""}` },
      ],
    ]
  );
}

/**
 * Send scheduled task completion notification
 */
export async function sendFeishuTaskComplete(params: {
  taskName: string;
  count: number;
  duration?: string;
  details?: string;
}): Promise<boolean> {
  const { taskName, count, duration, details } = params;

  return sendFeishuPost(
    `⏰ 定时任务完成: ${taskName}`,
    [
      [
        { tag: "text", text: `✅ 任务: ${taskName}\n` },
        { tag: "text", text: `📈 处理: ${count}场赛事\n` },
        ...(duration ? [{ tag: "text" as string, text: `⏱️ 耗时: ${duration}\n` }] : []),
        ...(details ? [{ tag: "text" as string, text: `📋 ${details}` }] : []),
      ],
    ]
  );
}

/**
 * Send verification/learning result notification
 */
export async function sendFeishuVerifyResult(params: {
  date: string;
  total: number;
  correct: number;
  accuracy: string;
  waterDirectionStats?: Record<string, { total: number; correct: number; rate: string }>;
  topPatterns?: Array<{ pattern_key: string; hit_rate: string; total_predictions: number }>;
}): Promise<boolean> {
  const { date, total, correct, accuracy, waterDirectionStats, topPatterns } = params;

  const sections: FeishuTextElement[][] = [
    [
      { tag: "text", text: `📅 日期: ${date}\n` },
      { tag: "text", text: `📊 总计: ${total}场 | 正确: ${correct}场 | 准确率: ${accuracy}\n` },
    ],
  ];

  if (waterDirectionStats) {
    const statLines = Object.entries(waterDirectionStats)
      .map(([dir, s]) => `${dir}: ${s.correct}/${s.total} (${s.rate}%)`)
      .join("\n");
    sections.push([{ tag: "text", text: `\n🔮 水位方向统计:\n${statLines}` }]);
  }

  if (topPatterns && topPatterns.length > 0) {
    const patternLines = topPatterns
      .slice(0, 5)
      .map((p) => `${p.pattern_key}: ${p.hit_rate} (${p.total_predictions}场)`)
      .join("\n");
    sections.push([{ tag: "text", text: `\n🧠 高命中模式:\n${patternLines}` }]);
  }

  return sendFeishuPost("🔍 AI验证+学习结果", sections);
}

/**
 * Send odds alert notification (赔率提醒)
 */
export async function sendFeishuOddsAlert(params: {
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchTime: string;
  alertType: string;
  currentValue: string;
  threshold: string;
}): Promise<boolean> {
  const { homeTeam, awayTeam, league, matchTime, alertType, currentValue, threshold } = params;

  return sendFeishuPost(
    `🚨 赔率提醒: ${homeTeam} vs ${awayTeam}`,
    [
      [
        { tag: "text", text: `${league} ${matchTime}\n` },
        { tag: "text", text: `⚠️ ${alertType}\n` },
        { tag: "text", text: `当前值: ${currentValue} | 阈值: ${threshold}` },
      ],
    ]
  );
}
