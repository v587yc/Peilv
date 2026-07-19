import { getStorageBackendInfo } from "@/storage/database/storage-config";
import { DEFAULT_COMPANY_IDS } from "@/features/odds/constants";
import type { SupabaseClient } from "@supabase/supabase-js";

export type SourceSection<T> = { status: "ok"; data: T; observedAt: string } | { status: "degraded"; error: { code: string; message: string }; observedAt: string };
async function section<T>(loader: () => Promise<T>): Promise<SourceSection<T>> { const observedAt = new Date().toISOString(); try { return { status: "ok", data: await loader(), observedAt }; } catch { return { status: "degraded", error: { code: "SOURCE_UNAVAILABLE", message: "数据暂时不可用" }, observedAt }; } }
export async function loadSourcesOverview(client: SupabaseClient) {
  const [storage, provider, companies, quality] = await Promise.all([
    section(async () => { const info = getStorageBackendInfo(); const { data, error } = await client.from("schema_migrations").select("version,applied_at").order("applied_at", { ascending: false }).limit(1).maybeSingle(); if (error) throw error; return { ...info, schemaVersion: data?.version || null }; }),
    section(async () => ({ id: "titan007", label: "Titan007", mode: "external-only", configured: true })),
    section(async () => ({ defaultCompanyIds: [...DEFAULT_COMPANY_IDS], mode: "read-only" })),
    section(async () => { const { data, error } = await client.from("data_quality_records").select("status,checked_at").order("checked_at", { ascending: false }).limit(100); if (error) throw error; const rows = data || []; return { observations: rows.length, issues: rows.filter(row => row.status !== "ok").length, latestCheckedAt: rows[0]?.checked_at || null }; }),
  ]);
  return { storage, provider, companies, quality };
}
