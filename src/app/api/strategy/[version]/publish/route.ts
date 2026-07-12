import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ version: string }> },
) {
  const { version } = await params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const effectiveFrom = typeof body.effectiveFrom === "string" ? body.effectiveFrom : new Date().toISOString();
  if (Number.isNaN(Date.parse(effectiveFrom))) return NextResponse.json({ error: "effectiveFrom 无效" }, { status: 400 });

  const supabase = getSupabaseClient();
  const { data: draft, error: loadError } = await supabase
    .from("strategy_versions")
    .select("version,status")
    .eq("version", version)
    .maybeSingle();
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
  if (!draft) return NextResponse.json({ error: "策略不存在" }, { status: 404 });
  if (draft.status !== "draft") return NextResponse.json({ error: "只能发布 draft 策略" }, { status: 409 });

  const now = new Date().toISOString();
  const { error: retireError } = await supabase
    .from("strategy_versions")
    .update({ status: "retired", retired_at: effectiveFrom, updated_at: now })
    .eq("status", "published");
  if (retireError) return NextResponse.json({ error: retireError.message }, { status: 500 });

  const { data, error } = await supabase
    .from("strategy_versions")
    .update({ status: "published", effective_from: effectiveFrom, published_at: now, retired_at: null, updated_at: now })
    .eq("version", version)
    .eq("status", "draft")
    .select("*")
    .maybeSingle();
  if (error || !data) return NextResponse.json({ error: error?.message || "策略发布冲突" }, { status: 409 });

  await supabase.from("learned_patterns").update({ status: "retired", retired_at: effectiveFrom }).eq("status", "published");
  await supabase.from("learned_patterns").update({ status: "published", published_at: now, retired_at: null }).eq("strategy_version", version);
  return NextResponse.json({ success: true, strategy: data });
}
