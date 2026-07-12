import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { isInternalRequest } from "@/lib/internal-auth";
import { summarizeBenchmark } from "@/lib/analysis/strategy";
import { parseDbJsonObject } from "@/lib/verification";
import {
  buildManualVerificationUpdate,
  readMarketVerification,
  serializeVerification,
  settleMarket,
  summarizeMarketRows,
  type PredictionVerificationRow,
} from "@/lib/verification/market-service";

async function loadFocusedLeagues(supabase: ReturnType<typeof getSupabaseClient>): Promise<Set<string> | null> {
  const { data, error } = await supabase.from("user_focused_leagues").select("league_name");
  if (error) return null;
  return new Set((data || []).map((row: { league_name: string }) => row.league_name));
}

function filterFocused<T extends { league: string }>(rows: T[] | null | undefined, focused: Set<string>): T[] {
  return focused.size ? (rows || []).filter(row => focused.has(row.league)) : rows || [];
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { matchId, matchDate, market, isCorrect } = body;
    if (!matchId || !matchDate) return NextResponse.json({ error: "缺少matchId或matchDate" }, { status: 400 });
    if (market !== "handicap" && market !== "total") return NextResponse.json({ error: "market必须是handicap或total" }, { status: 400 });
    if (isCorrect !== true && isCorrect !== false && isCorrect !== null) return NextResponse.json({ error: "isCorrect必须是true、false或null" }, { status: 400 });

    const supabase = getSupabaseClient();
    const { data: existing, error: selectError } = await supabase.from("prediction_results")
      .select("*")
      .eq("match_id", matchId).eq("match_date", matchDate).maybeSingle();
    if (selectError) return NextResponse.json({ error: selectError.message }, { status: 500 });
    if (!existing) return NextResponse.json({ error: "未找到对应预测记录" }, { status: 404 });

    const now = new Date().toISOString();
    const actor = request.headers.get("x-authenticated-actor-id");
    const update = buildManualVerificationUpdate(existing, market, isCorrect, now, actor);
    const { data: updatedRows, error } = await supabase.from("prediction_results").update(update)
      .eq("match_id", matchId).eq("match_date", matchDate).select("*");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const updated = updatedRows?.[0] ? { ...existing, ...updatedRows[0] } : { ...existing, ...update };
    const [{ data: dateRows }, focused] = await Promise.all([
      supabase.from("prediction_results").select("*").eq("match_date", matchDate),
      loadFocusedLeagues(supabase),
    ]);
    const summaryRows = focused
      ? filterFocused(dateRows as PredictionVerificationRow[], focused)
      : (dateRows as PredictionVerificationRow[] | null) || [];
    const stats = {
      handicap: summarizeMarketRows(summaryRows, "handicap"),
      total: summarizeMarketRows(summaryRows, "total"),
    };
    return NextResponse.json({
      success: true,
      market,
      verification: readMarketVerification(updated, market),
      markets: serializeVerification(updated),
      stats: { markets: stats },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "手动验证失败" }, { status: 500 });
  }
}

function evidenceFromSnapshot(snapshot: Record<string, unknown> | undefined, market: "handicap" | "total") {
  if (!snapshot) return undefined;
  const odds = parseDbJsonObject(snapshot.odds);
  const line = market === "handicap" ? odds.handicapLine ?? odds.line ?? odds.asianLine : odds.totalLine ?? odds.line;
  return line === undefined ? undefined : { line, basis: "odds_snapshot", snapshotId: Number(snapshot.id) || null };
}

function proxyEvidence(oddsRow: Record<string, unknown> | undefined, market: "handicap" | "total") {
  const crown12 = parseDbJsonObject(oddsRow?.crown_12_odds);
  const line = market === "handicap" ? crown12.handicapLine : crown12.totalLine;
  return line === undefined || line === null || line === "" ? undefined : { line, basis: "crown_opening_proxy", snapshotId: null };
}

export async function GET(request: NextRequest) {
  try {
    const startDate = request.nextUrl.searchParams.get("startDate");
    const endDate = request.nextUrl.searchParams.get("endDate") || startDate;
    const source = request.nextUrl.searchParams.get("source") === "backtest" ? "backtest" : "production";
    if (source === "backtest" && !isInternalRequest(request)) return NextResponse.json({ error: "回测验证仅允许内部任务调用" }, { status: 403 });
    if (!startDate) return NextResponse.json({ error: "缺少startDate参数" }, { status: 400 });

    const supabase = getSupabaseClient();
    const focused = await loadFocusedLeagues(supabase);
    if (!focused) return NextResponse.json({ error: "关注联赛白名单不可用" }, { status: 503 });
    const table = source === "backtest" ? "prediction_results_backtest" : "prediction_results";
    const { data: raw, error } = await supabase.from(table).select("*").gte("match_date", startDate).lte("match_date", endDate!);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const predictions = filterFocused(raw as PredictionVerificationRow[], focused);
    const ids = [...new Set(predictions.map(row => row.match_id))];

    const [resultQuery, snapshotQuery, oddsQuery] = await Promise.all([
      ids.length ? supabase.from("match_results").select("*").in("match_id", ids).gte("match_date", startDate).lte("match_date", endDate!) : Promise.resolve({ data: [], error: null }),
      ids.length ? supabase.from("odds_snapshots").select("id,match_id,match_date,market_type,odds,collected_at").in("match_id", ids).lte("collected_at", new Date().toISOString()).order("collected_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
      ids.length ? supabase.from("match_odds").select("match_id,match_date,crown_12_odds").in("match_id", ids) : Promise.resolve({ data: [], error: null }),
    ]);
    const key = (row: Record<string, unknown>) => `${row.match_id}:${row.match_date}`;
    const results = new Map((resultQuery.data || []).map((row: Record<string, unknown>) => [key(row), row]));
    const odds = new Map((oddsQuery.data || []).map((row: Record<string, unknown>) => [key(row), row]));
    const snapshots = snapshotQuery.data || [];
    const now = new Date().toISOString();

    for (const prediction of predictions) {
      const result = results.get(key(prediction)) || null;
      const before = snapshots.filter((row: Record<string, unknown>) => row.match_id === prediction.match_id && row.match_date === prediction.match_date && (!prediction.analyzed_at || String(row.collected_at) <= String(prediction.analyzed_at)));
      const update: Record<string, unknown> = {
        actual_score_margin: result?.status === "finished" ? Number(result.home_score) - Number(result.away_score) : null,
        actual_total_goals: result?.status === "finished" ? Number(result.home_score) + Number(result.away_score) : null,
      };
      for (const market of ["handicap", "total"] as const) {
        const snapshot = before.find((row: Record<string, unknown>) => row.market_type === market);
        const evidence = evidenceFromSnapshot(snapshot, market) || proxyEvidence(odds.get(key(prediction)), market);
        Object.assign(update, settleMarket(prediction, market, result as { home_score: unknown; away_score: unknown; status?: unknown } | null, evidence, now));
      }
      const { error: updateError } = await supabase.from(table).update(update).eq("match_id", prediction.match_id).eq("match_date", prediction.match_date);
      if (!updateError) Object.assign(prediction, update);
    }

    const handicap = summarizeMarketRows(predictions, "handicap");
    const total = summarizeMarketRows(predictions, "total");
    const accuracy = handicap.weightedAccuracy === null ? "N/A" : `${(handicap.weightedAccuracy * 100).toFixed(1)}%`;
    return NextResponse.json({
      success: true,
      verified: handicap.weightedTotal,
      correct: handicap.weightedCorrect,
      accuracy,
      excludedByWhitelist: (raw?.length || 0) - predictions.length,
      markets: { handicap, total },
      baselineComparison: summarizeBenchmark(predictions),
      stats: { markets: { handicap, total } },
      legacyWaterDiagnostics: null,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "验证失败" }, { status: 500 });
  }
}
