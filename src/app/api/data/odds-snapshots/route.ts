import { NextRequest, NextResponse } from "next/server";
import { paginationMetadata, parseOddsQueryParameters } from "@/lib/odds/query";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export async function GET(request: NextRequest) {
  try {
    const filters = parseOddsQueryParameters(request.url);
    const offset = (filters.page - 1) * filters.limit;
    const supabase = getSupabaseClient();
    let query = supabase
      .from("odds_snapshots")
      .select("*", { count: "exact" })
      .order("collected_at", { ascending: false });

    if (filters.matchId) query = query.eq("match_id", filters.matchId);
    if (filters.date) query = query.eq("match_date", filters.date);
    if (filters.companyId) query = query.eq("company_id", filters.companyId);
    if (filters.marketType) query = query.eq("market_type", filters.marketType);
    if (filters.snapshotType) query = query.eq("snapshot_type", filters.snapshotType);
    if (filters.source) query = query.eq("source", filters.source);
    if (filters.from) query = query.gte("collected_at", filters.from);
    if (filters.to) query = query.lte("collected_at", filters.to);

    const { data, error, count } = await query.range(offset, offset + filters.limit - 1);
    if (error) {
      console.error("[odds-snapshots] Query error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = (data ?? []).map((row) => ({
      id: row.id,
      match_id: row.match_id,
      match_date: row.match_date,
      company_id: row.company_id,
      market_type: row.market_type,
      snapshot_type: row.snapshot_type,
      source: row.source,
      captured_at: row.collected_at,
      source_observed_at: row.source_observed_at,
      raw_payload: row.odds,
      content_hash: row.content_hash,
      created_at: row.created_at,
    }));

    return NextResponse.json({
      success: true,
      data: rows,
      pagination: paginationMetadata(filters.page, filters.limit, count ?? 0),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "查询快照失败";
    console.error("[odds-snapshots] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
