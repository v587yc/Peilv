import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import {
  DEFAULT_MODEL_VERSION,
  generateStrategyVersion,
  loadPublishedStrategy,
  normalizeIndicatorWeights,
  predictionAsOf,
} from "@/lib/analysis/strategy";

export async function GET(request: NextRequest) {
  try {
    const asOf = request.nextUrl.searchParams.get("asOf") || new Date().toISOString();
    if (Number.isNaN(Date.parse(asOf))) return NextResponse.json({ error: "asOf 无效" }, { status: 400 });
    const strategy = await loadPublishedStrategy(getSupabaseClient(), asOf);
    return NextResponse.json({ success: true, strategy, asOf });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取策略失败" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const supabase = getSupabaseClient();
    let sourceWeights = body.weights;
    if (!sourceWeights) {
      const { data, error } = await supabase
        .from("learned_patterns")
        .select("suggested_weights")
        .eq("status", "draft")
        .gte("total_predictions", 20)
        .not("suggested_weights", "is", null)
        .order("last_updated", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      sourceWeights = data?.suggested_weights;
    }

    const version = generateStrategyVersion();
    const now = new Date().toISOString();
    const row = {
      version,
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : version,
      status: "draft",
      rules: body.rules && typeof body.rules === "object" ? body.rules : {},
      weights: normalizeIndicatorWeights(sourceWeights),
      model_version: typeof body.modelVersion === "string" && body.modelVersion ? body.modelVersion : DEFAULT_MODEL_VERSION,
      model_config: body.modelConfig && typeof body.modelConfig === "object" ? body.modelConfig : {},
      parent_version: typeof body.parentVersion === "string" ? body.parentVersion : null,
      created_by: request.headers.get("x-authenticated-actor-id"),
      created_at: now,
      updated_at: now,
    };
    const { error } = await supabase.from("strategy_versions").insert(row);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, strategy: row, weightsVersion: `${version}:weights`, asOf: predictionAsOf({}) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "生成策略失败" }, { status: 500 });
  }
}
