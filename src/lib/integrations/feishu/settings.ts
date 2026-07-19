export const MASKED_FEISHU_WEBHOOK_VALUE = "••••••••";
const WEBHOOK_CACHE_TTL_MS = 300000;

let cachedWebhookUrl = "";
let webhookCacheTime = 0;

export interface FeishuWebhookDependencies {
  envUrl?: string;
  loadStoredWebhookUrl?: () => Promise<string>;
  now?: () => number;
  preferStored?: boolean;
}

function usableWebhookUrl(value: unknown): string {
  if (typeof value !== "string" || value === MASKED_FEISHU_WEBHOOK_VALUE) return "";
  return value;
}

async function loadStoredWebhookUrl(): Promise<string> {
  try {
    const { getSupabaseClient } = await import("@/storage/database/supabase-client");
    const { data } = await getSupabaseClient()
      .from("app_settings")
      .select("value")
      .eq("key", "feishu_webhook_url")
      .single();
    return usableWebhookUrl(data?.value);
  } catch {
    return "";
  }
}

export function clearWebhookCache(): void {
  cachedWebhookUrl = "";
  webhookCacheTime = 0;
}

export async function getFeishuWebhookUrl(
  dependencies: FeishuWebhookDependencies = {},
): Promise<string> {
  const envUrl = usableWebhookUrl(dependencies.envUrl ?? process.env.FEISHU_WEBHOOK_URL ?? "");
  if (!dependencies.preferStored && envUrl) return envUrl;

  const now = (dependencies.now ?? Date.now)();
  if (cachedWebhookUrl && now - webhookCacheTime < WEBHOOK_CACHE_TTL_MS) {
    return cachedWebhookUrl;
  }

  const storedUrl = usableWebhookUrl(await (dependencies.loadStoredWebhookUrl ?? loadStoredWebhookUrl)());
  if (storedUrl) {
    cachedWebhookUrl = storedUrl;
    webhookCacheTime = now;
    return storedUrl;
  }
  return envUrl;
}
