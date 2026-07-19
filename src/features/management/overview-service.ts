import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSourcesOverview } from "./sources-service";
import { SettingsGovernanceService, createSupabaseSettingsRepository } from "./settings-service";

type Section = { status: "ok" | "degraded"; observedAt: string; data?: unknown; error?: string };

export async function loadManagementOverview(client: SupabaseClient): Promise<{ status: "ok" | "degraded"; sections: Record<string, Section> }> {
  const observedAt = new Date().toISOString();
  const loaders: Record<string, () => Promise<unknown>> = {
    settings: async () => {
      const settings = await new SettingsGovernanceService(createSupabaseSettingsRepository(client)).list();
      return { total: settings.length, configured: settings.filter(setting => setting.configured).length, defaults: settings.filter(setting => setting.source === "default").map(setting => setting.id), items: settings.map(setting => ({ ...setting, maskedValue: undefined })) };
    },
    sources: () => loadSourcesOverview(client),
    automation: async () => {
      const { data, error } = await client.from("automation_tasks").select("status,last_error,updated_at").order("updated_at", { ascending: false }).limit(100);
      if (error) throw new Error("自动化状态不可用");
      const rows = data || []; return { total: rows.length, active: rows.filter(row => ["pending","running","retrying"].includes(row.status)).length, failed: rows.filter(row => row.status === "failed").length, latestError: rows.find(row => row.last_error)?.last_error || null };
    },
    strategy: async () => {
      const { data, error } = await client.from("strategy_versions").select("version,name,status,published_at").eq("status", "published").order("published_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error("策略状态不可用"); return data || null;
    },
    backtests: async () => {
      const { data, error } = await client.from("backtest_jobs").select("id,status,accuracy,updated_at").order("updated_at", { ascending: false }).limit(100);
      if (error) throw new Error("回测状态不可用"); const rows = data || []; return { total: rows.length, active: rows.filter(row => ["running","cancelling"].includes(row.status)).length, latest: rows[0] || null };
    },
    audit: async () => {
      const { data, error } = await client.from("audit_logs").select("action,object_type,object_id,created_at").order("created_at", { ascending: false }).limit(5);
      if (error) throw new Error("审计摘要不可用"); return { recent: data || [] };
    },
  };
  const entries = await Promise.all(Object.entries(loaders).map(async ([name, load]) => { try { return [name, { status: "ok", observedAt, data: await load() }] as const; } catch (error) { return [name, { status: "degraded", observedAt, error: error instanceof Error ? error.message : "暂时不可用" }] as const; } }));
  const sections = Object.fromEntries(entries) as Record<string, Section>;
  return { status: Object.values(sections).some(section => section.status === "degraded") ? "degraded" : "ok", sections };
}
