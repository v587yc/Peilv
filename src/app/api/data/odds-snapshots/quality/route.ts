import { NextRequest, NextResponse } from "next/server";
import { paginationMetadata, parseOddsQueryParameters } from "@/lib/odds/query";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export async function GET(request: NextRequest) {
  try {
    const filters = parseOddsQueryParameters(request.url);
    const offset = (filters.page - 1) * filters.limit;
    const supabase = getSupabaseClient();
    let query = supabase
      .from("data_quality_records")
      .select("*", { count: "exact" })
      .eq("entity_type", "odds_snapshot")
      .order("checked_at", { ascending: false });

    if (filters.matchId) query = query.contains("details", { matchId: filters.matchId });
    if (filters.date) query = query.eq("date_key", filters.date);
    if (filters.companyId) query = query.contains("details", { companyId: filters.companyId });
    if (filters.marketType) query = query.eq("dimension", filters.marketType);
    if (filters.snapshotType) query = query.contains("details", { snapshotType: filters.snapshotType });
    if (filters.source) query = query.eq("source", filters.source);
    if (filters.from) query = query.gte("checked_at", filters.from);
    if (filters.to) query = query.lte("checked_at", filters.to);

    const { data, error, count } = await query.range(offset, offset + filters.limit - 1);
    if (error) {
      console.error("[odds-snapshots/quality] Query error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      data: data ?? [],
      pagination: paginationMetadata(filters.page, filters.limit, count ?? 0),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "查询质量记录失败";
    console.error("[odds-snapshots/quality] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
