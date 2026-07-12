import { NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import {
  handicapLineToNumber,
  parseDbJsonObject,
  verifyWaterPrediction,
  type SettlementOutcome,
  type VerificationStatus,
} from "@/lib/verification";
import {
  serializeVerification,
  summarizeMarketRows,
  type MarketVerification,
} from "@/lib/verification/market-service";
import { summarizeBenchmark } from "@/lib/analysis/strategy";

interface ReportRow {
  matchId: string;
  league: string;
  time: string;
  homeTeam: string;
  awayTeam: string;
  state: string;
  homeScore: string;
  awayScore: string;
  // 亚盘 - 盘口数据(保留作参考)
  initHandicap: string;
  liveHandicap: string;
  handicapChange: string;       // 盘口变化(保留参考)
  isReceiving: boolean;
  waterDirection: string;
  actualWaterDirection: string;
  waterResult: "+" | "-" | null;
  waterTolerance: boolean;
  // 其他
  prediction: string;
  action: string;
  accuracy: string;
  confidenceLevel: string;
  // 大小球
  initTotal: string;
  liveTotal: string;
  totalChange: string;
  totalResult: "+" | "-" | null;
  totalPrediction: string;
  totalAction: string;
  handicapOutcome: SettlementOutcome;
  totalOutcome: SettlementOutcome;
  verification: {
    handicap: MarketVerification;
    total: MarketVerification;
  };
  verified: boolean;
  verificationStatus: VerificationStatus;
  manualIsCorrect: boolean | null;
}

interface PredictionRow extends Record<string, unknown> {
  match_id: string;
  match_date: string;
  home_team: string;
  away_team: string;
  league: string;
  match_time: string;
  handicap_trend: string;
  water_direction: string;
  prediction: string;
  total_trend: string;
  total_prediction: string;
  total_action: string;
  confidence_level: string;
  accuracy: string;
  strategy: string;
  action: string;
  is_correct: boolean | null;
  auto_is_correct: boolean | null;
  manual_is_correct: boolean | null;
  verification_status: string | null;
  verified_at: string | null;
  analyzed_at: string | null;
  actual_water_direction: string | null;
  actual_handicap_trend: string | null;
  indicators_json: { name: string; signal: string }[] | null;
  strategy_version: string | null;
}

function normalizeDateKey(date: string): string {
  return date.includes("-") ? date.replace(/-/g, "") : date;
}

function displayDate(dateKey: string): string {
  const compact = normalizeDateKey(dateKey);
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}` : dateKey;
}

function legacyDateKey(date: string): string {
  const compact = normalizeDateKey(date);
  return compact.length === 8 ? displayDate(compact) : date;
}

// GET: fetch report by date, or list available dates, or get trend data
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const reportDate = searchParams.get("date");
    const trend = searchParams.get("trend");

    const client = getSupabaseClient();

    if (trend) {
      const days = parseInt(trend) || 7;
      const { data, error } = await client
        .from("daily_reports")
        .select("report_date, report_content, created_at")
        .order("created_at", { ascending: false })
        .limit(days * 3);

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      const trendMap = new Map<string, { report_date: string; report_content: string; created_at: string }>();
      for (const row of data || []) {
        const key = normalizeDateKey(row.report_date);
        if (!trendMap.has(key)) trendMap.set(key, row);
      }

      const trendData = Array.from(trendMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-days)
        .map(([key, row]) => {
        try {
          const content = JSON.parse(row.report_content);
          const handicap = content.summary?.markets?.handicap;
          const totalMarket = content.summary?.markets?.total;
          return {
            date: displayDate(key),
            total: handicap?.weightedTotal ?? content.summary?.total ?? 0,
            correct: handicap?.weightedCorrect ?? content.summary?.correct ?? 0,
            accuracy: handicap?.weightedAccuracy === null
              ? null
              : handicap?.weightedAccuracy !== undefined
                ? handicap.weightedAccuracy * 100
                : parseFloat(content.summary?.accuracy || "0"),
            totalCorrect: totalMarket?.weightedCorrect ?? content.summary?.totalCorrect ?? 0,
            totalAccuracy: totalMarket?.weightedAccuracy === null
              ? null
              : totalMarket?.weightedAccuracy !== undefined
                ? (totalMarket.weightedAccuracy * 100).toFixed(1)
                : content.summary?.totalAccuracy ?? "0",
            markets: content.summary?.markets,
          };
        } catch {
          return { date: row.report_date, total: 0, correct: 0, accuracy: 0, totalCorrect: 0, totalAccuracy: "0" };
        }
      });

      return NextResponse.json({ success: true, trend: trendData });
    }

    if (reportDate) {
      const reportKey = normalizeDateKey(reportDate);
      const oldReportKey = legacyDateKey(reportDate);
      const { data, error } = await client
        .from("daily_reports")
        .select("report_content, created_at")
        .in("report_date", [reportKey, oldReportKey])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw new Error(`查询失败: ${error.message}`);
      return NextResponse.json({ success: true, data: data || null });
    } else {
      const { data, error } = await client
        .from("daily_reports")
        .select("report_date, created_at")
        .order("report_date", { ascending: false })
        .limit(30);

      if (error) throw new Error(`查询失败: ${error.message}`);
      const dateMap = new Map<string, { report_date: string; created_at: string }>();
      for (const row of data || []) {
        const key = normalizeDateKey(row.report_date);
        const existing = dateMap.get(key);
        if (!existing || new Date(row.created_at).getTime() > new Date(existing.created_at).getTime()) {
          dateMap.set(key, { report_date: key, created_at: row.created_at });
        }
      }
      return NextResponse.json({ success: true, dates: Array.from(dateMap.values()).sort((a, b) => b.report_date.localeCompare(a.report_date)) });
    }
  } catch {
    return NextResponse.json({ success: false, error: "查询报表失败" }, { status: 500 });
  }
}

// POST: generate AI prediction report from prediction_results + match_odds
export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const predDate = normalizeDateKey(searchParams.get("predDate") || new Date().toISOString().slice(0, 10).replace(/-/g, ""));
    const mode = searchParams.get("mode") || "ai";

    const client = getSupabaseClient();

    if (mode === "ai") {
      // === AI Report: from prediction_results table ===
      const { data: predictions, error: predError } = await client
        .from("prediction_results")
        .select("*")
        .eq("match_date", predDate);

      if (predError) throw new Error(`查询预测失败: ${predError.message}`);
      if (!predictions || predictions.length === 0) {
        return NextResponse.json({ success: false, error: "该日期没有AI预测数据" }, { status: 400 });
      }

      // Get match_odds for terminal handicap data
      const matchIds = [...new Set(predictions.map((p: PredictionRow) => p.match_id))];
      const oddsData: Array<{ match_id: string; odds_data: unknown; crown_live_odds: unknown; crown_12_odds: unknown }> = [];
      const batchSize = 100;
      for (let i = 0; i < matchIds.length; i += batchSize) {
        const batchIds = matchIds.slice(i, i + batchSize);
        const { data: batchData, error: oddsError } = await client
          .from("match_odds")
          .select("match_id, odds_data, crown_live_odds, crown_12_odds")
          .eq("match_date", predDate)
          .in("match_id", batchIds);

        if (oddsError) throw new Error(`查询赔率失败: ${oddsError.message}`);
        if (batchData) oddsData.push(...batchData);
      }

      const oddsMap = new Map<string, { oddsData: Record<string, unknown>; crownLiveOdds: Record<string, unknown>; crown12Odds: Record<string, unknown> }>();
      if (oddsData) {
        for (const o of oddsData) {
          oddsMap.set(o.match_id, {
            oddsData: parseDbJsonObject(o.odds_data),
            crownLiveOdds: parseDbJsonObject(o.crown_live_odds),
            crown12Odds: parseDbJsonObject(o.crown_12_odds),
          });
        }
      }

      const unsortedRows: ReportRow[] = [];
      const benchmarkRows: Array<{ is_correct: boolean | null; strategy_version: string | null }> = [];

      for (const pred of predictions as PredictionRow[]) {
        const odds = oddsMap.get(pred.match_id);
        const companies = odds?.oddsData?.companies as Array<Record<string, string>> | undefined;
        const crownLive = odds?.crownLiveOdds;
        const crown12 = odds?.crown12Odds;

        const crown = companies?.find((c: Record<string, string>) => c.companyId === "3");
        const initComp = crown || companies?.[0];

        const waterDirection = pred.water_direction || "不变";
        const waterDiagnostics = verifyWaterPrediction(waterDirection, odds ? {
          odds_data: odds.oddsData,
          crown_12_odds: odds.crown12Odds,
          crown_live_odds: odds.crownLiveOdds,
        } : null);
        const verification = serializeVerification(pred);
        const handicapVerification = verification.handicap;
        const totalVerification = verification.total;
        benchmarkRows.push({
          is_correct: handicapVerification.effectiveIsCorrect,
          strategy_version: pred.strategy_version,
        });
        const actualWaterDirection = waterDiagnostics.actualWaterDirection || "未验证";
        const handicapChange = waterDiagnostics.actualHandicapTrend || "未验证";
        const isReceiving = waterDiagnostics.initHandicapValue !== null && waterDiagnostics.initHandicapValue < 0;
        const verified = ["win", "half_win", "push", "half_loss", "loss"].includes(handicapVerification.autoOutcome)
          || handicapVerification.manualIsCorrect !== null;
        const waterResult: "+" | "-" | null = handicapVerification.effectiveIsCorrect === null
          ? null
          : handicapVerification.effectiveIsCorrect ? "-" : "+";
        const waterTolerance = waterDiagnostics.actualWaterDirection === "不变" && waterDirection === "不变";

        const crown12TotalLine = (crown12?.totalLine as string) || "";
        const initTotalLine = crown12TotalLine || initComp?.ftTotalLine || initComp?.totalLineInit || "";
        const liveTotalLine = (crownLive?.totalLine as string) || "";
        let totalChange = "未验证";
        const initTotalVal = handicapLineToNumber(initTotalLine);
        const liveTotalVal = handicapLineToNumber(liveTotalLine);
        if (!isNaN(initTotalVal) && !isNaN(liveTotalVal)) {
          const totalDiff = parseFloat((liveTotalVal - initTotalVal).toFixed(2));
          totalChange = Math.abs(totalDiff) < 0.01 ? "不变" : totalDiff > 0 ? "盘口升" : "盘口降";
        }
        const totalResult: "+" | "-" | null = totalVerification.effectiveIsCorrect === null
          ? null
          : totalVerification.effectiveIsCorrect ? "-" : "+";

        unsortedRows.push({
          matchId: pred.match_id,
          league: pred.league,
          time: pred.match_time,
          homeTeam: pred.home_team,
          awayTeam: pred.away_team,
          state: "",
          homeScore: "",
          awayScore: "",
          initHandicap: waterDiagnostics.initHandicapLine,
          liveHandicap: waterDiagnostics.liveHandicapLine || "无终盘",
          handicapChange,
          isReceiving,
          waterDirection,
          actualWaterDirection,
          waterResult,
          waterTolerance,
          prediction: pred.prediction || "",
          action: pred.action || pred.water_direction || "",
          accuracy: pred.accuracy || "",
          confidenceLevel: pred.confidence_level || "",
          initTotal: initTotalLine,
          liveTotal: liveTotalLine || crown12TotalLine || "无终盘",
          totalChange,
          totalResult,
          totalPrediction: pred.total_prediction || "",
          totalAction: pred.total_action || "",
          handicapOutcome: handicapVerification.autoOutcome,
          totalOutcome: totalVerification.autoOutcome,
          verification,
          verified,
          verificationStatus: handicapVerification.effectiveStatus as VerificationStatus,
          manualIsCorrect: handicapVerification.manualIsCorrect,
        });
      }

      // Sort: league group + time within league
      const reportRows = unsortedRows.sort((a, b) => {
        if (a.league !== b.league) return a.league.localeCompare(b.league, 'zh-CN');
        return a.time.localeCompare(b.time);
      });

      const handicapSummary = summarizeMarketRows(predictions as PredictionRow[], "handicap");
      const totalSummary = summarizeMarketRows(predictions as PredictionRow[], "total");
      const legacyAccuracy = (value: number | null) => value === null ? "0" : (value * 100).toFixed(1);
      const confidenceSummary = (level: string) => {
        const summary = summarizeMarketRows(
          (predictions as PredictionRow[]).filter(prediction => (prediction.confidence_level || "低") === level),
          "handicap",
        );
        return {
          total: summary.weightedTotal,
          correct: summary.weightedCorrect,
          wrong: summary.weightedWrong,
          accuracy: legacyAccuracy(summary.weightedAccuracy),
        };
      };
      const reportKey = normalizeDateKey(predDate);
      const reportDate = displayDate(reportKey);
      const analyzedTimes = (predictions as PredictionRow[])
        .map((prediction) => prediction.analyzed_at ? Date.parse(prediction.analyzed_at) : NaN)
        .filter(Number.isFinite);
      const latestAnalysisAt = analyzedTimes.length > 0
        ? new Date(Math.max(...analyzedTimes)).toISOString()
        : null;

      const reportContent = JSON.stringify({
        date: reportDate,
        mode: "ai",
        latestAnalysisAt,
        rows: reportRows,
        summary: {
          matches: reportRows.length,
          markets: {
            handicap: handicapSummary,
            total: totalSummary,
          },
          total: handicapSummary.weightedTotal,
          correct: handicapSummary.weightedCorrect,
          wrong: handicapSummary.weightedWrong,
          accuracy: legacyAccuracy(handicapSummary.weightedAccuracy),
          totalTotal: totalSummary.weightedTotal,
          totalCorrect: totalSummary.weightedCorrect,
          totalWrong: totalSummary.weightedWrong,
          totalAccuracy: legacyAccuracy(totalSummary.weightedAccuracy),
          highConf: confidenceSummary("高"),
          midConf: confidenceSummary("中"),
          lowConf: confidenceSummary("低"),
          pending: handicapSummary.nonScoringCounts.pending,
          invalid: handicapSummary.nonScoringCounts.invalid,
          manual: reportRows.filter(row => row.verification.handicap.manualIsCorrect !== null).length,
          unverified: reportRows.filter(row => !row.verified).length,
          baselineComparison: summarizeBenchmark(benchmarkRows),
        },
      });

      // Save to DB
      const { error } = await client
        .from("daily_reports")
        .upsert(
          { report_date: reportKey, report_content: reportContent },
          { onConflict: "report_date" }
        );

      if (error) throw new Error(`保存失败: ${error.message}`);

      return NextResponse.json({
        success: true,
        report: JSON.parse(reportContent),
      });
    }

    // Legacy mode
    let jsonContent = "";
    const { data: predData } = await client
      .from("prediction_data")
      .select("json_content")
      .eq("date_key", predDate)
      .maybeSingle();
    jsonContent = predData?.json_content || "";

    if (!jsonContent) {
      return NextResponse.json({ success: false, error: "没有预测数据" }, { status: 400 });
    }

    return NextResponse.json({ success: true, report: { date: predDate, rows: [], summary: { total: 0, correct: 0, wrong: 0, accuracy: "0" } } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "生成报表失败";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
