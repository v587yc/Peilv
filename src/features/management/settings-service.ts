import { clearLLMConfigCache, LLM_DEFAULT_BASE_URL, LLM_DEFAULT_MODEL } from "@/lib/llm";
import { clearWebhookCache } from "@/lib/integrations/feishu/settings";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertOutboundUrl, type OutboundUrlKind } from "@/lib/safe-fetch";

export const MASKED_SETTING_VALUE = "••••••••";
export const SETTING_DEFINITIONS = [
  { key: "llm_api_key", label: "LLM API Key", sensitive: true, env: "LLM_API_KEY", effectiveAfter: "cache-refresh" },
  { key: "llm_base_url", label: "LLM 服务地址", sensitive: false, env: "LLM_BASE_URL", defaultValue: LLM_DEFAULT_BASE_URL, effectiveAfter: "cache-refresh" },
  { key: "llm_model", label: "LLM 模型", sensitive: false, env: "LLM_MODEL", defaultValue: LLM_DEFAULT_MODEL, effectiveAfter: "cache-refresh" },
  { key: "search_api_key", label: "搜索 API Key", sensitive: true, env: "SEARCH_API_KEY", effectiveAfter: "immediate" },
  { key: "search_base_url", label: "搜索服务地址", sensitive: false, env: "SEARCH_BASE_URL", effectiveAfter: "immediate" },
  { key: "feishu_webhook_url", label: "飞书 Webhook", sensitive: true, env: "FEISHU_WEBHOOK_URL", effectiveAfter: "cache-refresh" },
] as const;
type SettingKey = (typeof SETTING_DEFINITIONS)[number]["key"];
type SettingRow = { key: string; value: string };
export type ManagedSettingDto = { id: string; key: SettingKey; label: string; sensitive: boolean; configured: boolean; source: "database" | "environment" | "default" | "none"; value?: string; maskedValue?: string; effectiveAfter: string };

export interface SettingsRepository { list(): Promise<SettingRow[]>; upsert(values: SettingRow[]): Promise<void> }

export function createSupabaseSettingsRepository(client: SupabaseClient): SettingsRepository {
  return {
    async list() { const { data, error } = await client.from("app_settings").select("key,value"); if (error) throw new Error("设置读取失败"); return data || []; },
    async upsert(values) { if (!values.length) return; const { error } = await client.from("app_settings").upsert(values.map(row => ({ ...row, updated_at: new Date().toISOString() })), { onConflict: "key" }); if (error) throw new Error("设置保存失败"); },
  };
}

export function validateSettingValue(key: SettingKey, value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) throw new Error(`设置 ${key} 的值无效`);
  if (key.endsWith("_base_url") || key === "feishu_webhook_url") {
    const kind: OutboundUrlKind = key === "llm_base_url" ? "llm" : key === "search_base_url" ? "search" : "feishu";
    try { assertOutboundUrl(value, kind); } catch (error) {
      throw new Error(`设置 ${key} 不符合安全出站策略: ${error instanceof Error ? error.message : "URL 无效"}`);
    }
  }
  return value;
}

export class SettingsGovernanceService {
  constructor(private repository: SettingsRepository, private env: Record<string, string | undefined> = process.env) {}
  async list(): Promise<ManagedSettingDto[]> {
    const stored = new Map((await this.repository.list()).filter(row => SETTING_DEFINITIONS.some(item => item.key === row.key)).map(row => [row.key, row.value]));
    return SETTING_DEFINITIONS.map(definition => {
      const databaseValue = stored.get(definition.key); const environmentValue = this.env[definition.env]?.trim();
      const defaultValue = "defaultValue" in definition ? definition.defaultValue : undefined;
      const source = databaseValue ? "database" : environmentValue ? "environment" : defaultValue ? "default" : "none";
      const configured = Boolean(databaseValue || environmentValue || defaultValue);
      return { id: `setting.${definition.key}`, key: definition.key, label: definition.label, sensitive: definition.sensitive, configured, source, ...(definition.sensitive ? { maskedValue: configured ? MASKED_SETTING_VALUE : undefined } : { value: databaseValue || environmentValue || defaultValue || "" }), effectiveAfter: definition.effectiveAfter };
    });
  }
  async update(replacements: Record<string, unknown>): Promise<string[]> {
    const rows: SettingRow[] = [];
    for (const [id, raw] of Object.entries(replacements)) {
      const key = id.replace(/^setting\./, "") as SettingKey; const definition = SETTING_DEFINITIONS.find(item => item.key === key);
      if (!definition) throw new Error("包含不允许的设置项");
      if (definition.sensitive && (raw === "" || raw === MASKED_SETTING_VALUE || raw === undefined)) continue;
      rows.push({ key, value: validateSettingValue(key, raw) });
    }
    await this.repository.upsert(rows);
    if (rows.some(row => row.key.startsWith("llm_"))) clearLLMConfigCache();
    if (rows.some(row => row.key === "feishu_webhook_url")) clearWebhookCache();
    return rows.map(row => row.key);
  }
}
