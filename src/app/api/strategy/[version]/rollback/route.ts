import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { generateStrategyVersion } from "@/lib/analysis/strategy";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ version: string }> },
) {
  const { version: targetVersion } = await params;
  const supabase = getSupabaseClient();
  const { data: target, error: loadError } = await supabase
    .from("strategy_versions")
    .select("name,rules,weights,model_version,model_config")
    .eq("version", targetVersion)
    .maybeSingle();
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
  if (!target) return NextResponse.json({ error: "回滚目标不存在" }, { status: 404 });

  const now = new Date().toISOString();
  const version = generateStrategyVersion();
  const rollback = {
    version,
    name: `Rollback to ${targetVersion}`,
    status: "draft",
    rules: target.rules,
    weights: target.weights,
    model_version: target.model_version,
    model_config: target.model_config,
    parent_version: targetVersion,
    created_by: request.headers.get("x-authenticated-actor-id"),
    created_at: now,
    updated_at: now,
  };
  const { error: insertError } = await supabase.from("strategy_versions").insert(rollback);
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });

  const { error: retireError } = await supabase
    .from("strategy_versions")
    .update({ status: "retired", retired_at: now, updated_at: now })
    .eq("status", "published");
  if (retireError) return NextResponse.json({ error: retireError.message }, { status: 500 });
  const { data, error } = await supabase
    .from("strategy_versions")
    .update({ status: "published", effective_from: now, published_at: now, retired_at: null, updated_at: now })
    .eq("version", version)
    .select("*")
    .maybeSingle();
  if (error || !data) return NextResponse.json({ error: error?.message || "回滚发布失败" }, { status: 500 });

  return NextResponse.json({ success: true, strategy: data, rolledBackTo: targetVersion });
}
