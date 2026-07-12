import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { clearWebhookCache } from "@/app/api/feishu/_helpers";
import { writeAuditLog } from "@/lib/audit-log";

const MASKED_SETTING_VALUE = "••••••••";
const ALLOWED_SETTING_KEYS = new Set([
  "llm_api_key",
  "llm_base_url",
  "llm_model",
  "search_api_key",
  "search_base_url",
  "feishu_webhook_url",
]);
const SENSITIVE_SETTING_KEYS = new Set(["llm_api_key", "search_api_key", "feishu_webhook_url"]);

function validateSettingValue(key: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) {
    throw new Error(`设置 ${key} 的值无效`);
  }
  if (key.endsWith("_base_url") || key === "feishu_webhook_url") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`设置 ${key} 必须是有效 URL`);
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error(`设置 ${key} 必须使用无凭据 HTTPS URL`);
    }
  }
  return value;
}

function maskSettingValue(key: string, value: string): string {
  return SENSITIVE_SETTING_KEYS.has(key) && value ? MASKED_SETTING_VALUE : value;
}

// GET: Retrieve app settings
export async function GET() {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("app_settings")
      .select("key, value");

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const settings: Record<string, string> = {};
    for (const row of data || []) {
      if (!ALLOWED_SETTING_KEYS.has(row.key)) continue;
      settings[row.key] = maskSettingValue(row.key, row.value);
    }

    return NextResponse.json({ success: true, settings });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "获取设置失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST: Save app settings
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { settings } = body as { settings: Record<string, string> };

    if (!settings || typeof settings !== "object") {
      return NextResponse.json({ error: "settings required" }, { status: 400 });
    }

    const entries = Object.entries(settings);
    if (entries.some(([key]) => !ALLOWED_SETTING_KEYS.has(key))) {
      return NextResponse.json({ error: "包含不允许的设置项" }, { status: 400 });
    }

    const validatedSettings: Record<string, string> = {};
    for (const [key, rawValue] of entries) {
      if (SENSITIVE_SETTING_KEYS.has(key) && rawValue === MASKED_SETTING_VALUE) {
        continue;
      }
      validatedSettings[key] = validateSettingValue(key, rawValue);
    }

    const supabase = getSupabaseClient();
    const changedKeys = Object.keys(validatedSettings);
    const oldSettings: Record<string, string> = {};
    if (changedKeys.length > 0) {
      const { data: existingSettings } = await supabase
        .from("app_settings")
        .select("key, value")
        .in("key", changedKeys);
      for (const row of existingSettings || []) {
        oldSettings[row.key] = row.value;
      }
    }

    for (const [key, value] of Object.entries(validatedSettings)) {

      const { error } = await supabase
        .from("app_settings")
        .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });

      if (error) {
        console.error(`[Settings] Save error for ${key}:`, error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    // Also set as environment variable for the current process
    if (validatedSettings.feishu_webhook_url !== undefined) {
      process.env.FEISHU_WEBHOOK_URL = validatedSettings.feishu_webhook_url;
      clearWebhookCache(); // Force reload on next notification
    }

    await writeAuditLog({
      actorId: req.headers.get("x-authenticated-actor-id") || "single-team-admin",
      actorType: req.headers.get("x-authenticated-actor-type") === "internal" ? "internal" : "admin",
      action: "configuration_update",
      objectType: "app_settings",
      objectId: "global",
      requestId: req.headers.get("x-request-id"),
      oldValue: oldSettings,
      newValue: validatedSettings,
      metadata: { changedKeys },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "保存设置失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
