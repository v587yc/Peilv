import { NextRequest, NextResponse } from "next/server";
import { sendFeishuPayload } from "@/lib/integrations/feishu/notifier";
import { getFeishuWebhookUrl } from "@/lib/integrations/feishu/settings";

/**
 * Send a message to Feishu group via webhook
 * POST /api/feishu/notify
 * 
 * Body:
 * {
 *   "msg_type": "text" | "post" | "interactive" | "test",
 *   "content": { ... }  // depends on msg_type
 * }
 * 
 * Or simplified:
 * {
 *   "text": "simple text message"
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const webhookUrl = await getFeishuWebhookUrl({ preferStored: true });
    if (!webhookUrl) {
      return NextResponse.json(
        { success: false, error: "飞书Webhook未配置，请先在设置中填写Webhook URL" },
        { status: 400 }
      );
    }

    const body = await request.json();

    let payload: Record<string, unknown>;

    if (body.msg_type === "test") {
      // Test message
      payload = {
        msg_type: "post",
        content: {
          post: {
            zh_cn: {
              title: "⚽ 赔率监控系统 - 连接测试",
              content: [
                [
                  { tag: "text", text: "✅ 飞书机器人连接成功！\n" },
                  { tag: "text", text: "📊 AI分析、定时任务、赔率提醒等通知将自动推送到此群\n" },
                  { tag: "text", text: `🕐 测试时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` },
                ],
              ],
            },
          },
        },
      };
    } else if (body.text) {
      // Simplified: just send text
      payload = {
        msg_type: "text",
        content: {
          text: body.text,
        },
      };
    } else if (body.msg_type && body.content) {
      // Full format: pass through
      payload = {
        msg_type: body.msg_type,
        content: body.content,
      };
    } else if (body.msg_type === "interactive" && body.card) {
      // Card message
      payload = {
        msg_type: "interactive",
        card: body.card,
      };
    } else {
      return NextResponse.json(
        { success: false, error: "无效的消息格式，需要 text 或 msg_type+content" },
        { status: 400 }
      );
    }

    const result = await sendFeishuPayload(payload, {
      getWebhookUrl: async () => webhookUrl,
    });

    if (result.success) {
      return NextResponse.json({ success: true, data: result.detail });
    }
    return NextResponse.json(
      {
        success: false,
        error: result.transportError ? `飞书通知异常: ${result.error}` : result.error,
        ...(result.detail ? { detail: result.detail } : {}),
      },
      { status: 500 },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json(
      { success: false, error: `飞书通知异常: ${msg}` },
      { status: 500 }
    );
  }
}

/**
 * Check Feishu webhook configuration status
 * GET /api/feishu/notify
 */
export async function GET() {
  const webhookUrl = await getFeishuWebhookUrl({ preferStored: true });
  if (!webhookUrl) {
    return NextResponse.json({
      success: false,
      configured: false,
      error: "飞书Webhook未配置",
    });
  }

  return NextResponse.json({
    success: true,
    configured: true,
  });
}
