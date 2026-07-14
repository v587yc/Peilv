import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { sendFeishuVerifyResult } from "@/lib/integrations/feishu/notifier";
import { isInternalRequest } from "@/lib/internal-auth";
import type { PredictionMarket } from "@/lib/verification";
import {
  marketVerificationWeight,
  summarizeMarketRows,
} from "@/lib/verification/market-service";
import {
  DEFAULT_MODEL_VERSION,
  MIN_LEARNING_SAMPLES,
  generateStrategyVersion,
  wilsonLowerBound,
} from "@/lib/analysis/strategy";

const MIN_PATTERN_SAMPLES_FOR_DISPLAY = MIN_LEARNING_SAMPLES;

type LearningPrediction = Record<string, unknown> & {
  league: string;
  match_id: string;
  match_date: string;
  learning_correct_weight: number;
  learning_total_weight: number;
};

function toLearningPrediction(row: Record<string, unknown>, market: PredictionMarket): LearningPrediction | null {
  const weight = marketVerificationWeight(row, market);
  if (weight.weightedTotal === 0) return null;
  return {
    ...row,
    league: String(row.league || ""),
    match_id: String(row.match_id || ""),
    match_date: String(row.match_date || ""),
    learning_correct_weight: weight.weightedCorrect,
    learning_total_weight: weight.weightedTotal,
  };
}

function weightedStats(rows: LearningPrediction[]) {
  const total = rows.reduce((sum, row) => sum + row.learning_total_weight, 0);
  const correct = rows.reduce((sum, row) => sum + row.learning_correct_weight, 0);
  return { total, correct, hitRate: total > 0 ? correct / total : 0 };
}

async function loadFocusedLeagues(supabase: ReturnType<typeof getSupabaseClient>): Promise<Set<string> | null> {
  const { data, error } = await supabase
    .from("user_focused_leagues")
    .select("league_name");

  if (error) {
    console.log("[Learn] Failed to load focused leagues:", error.message);
    return null;
  }

  return new Set((data || []).map((row: { league_name: string }) => row.league_name));
}

// Mine patterns from verified predictions and update learned_patterns table
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.market !== "handicap" && body.market !== "total") {
      return NextResponse.json({ error: "market必须是handicap或total" }, { status: 400 });
    }
    const market: PredictionMarket = body.market;
    const league = body.league || "ALL";
    const requestedMinSamples = Number(body.minSamples);
    const minSamples = Math.max(MIN_LEARNING_SAMPLES, Number.isFinite(requestedMinSamples) ? Math.floor(requestedMinSamples) : MIN_LEARNING_SAMPLES);
    const trainingWindowStart = typeof body.trainingWindowStart === "string" && /^\d{8}$/.test(body.trainingWindowStart) ? body.trainingWindowStart : null;
    const trainingWindowEnd = typeof body.trainingWindowEnd === "string" && /^\d{8}$/.test(body.trainingWindowEnd) ? body.trainingWindowEnd : null;
    if (trainingWindowStart && trainingWindowEnd && trainingWindowStart > trainingWindowEnd) {
      return NextResponse.json({ error: "训练窗口起始日期不能晚于结束日期" }, { status: 400 });
    }
    const source = body.source === "backtest" ? "backtest" : "production";
    const predictionTable = source === "backtest" ? "prediction_results_backtest" : "prediction_results";
    const patternTable = source === "backtest" ? "learned_patterns_backtest" : "learned_patterns";
    if (source === "backtest" && !isInternalRequest(request)) {
      return NextResponse.json({ error: "回测学习仅允许内部任务调用" }, { status: 403 });
    }

    const supabase = getSupabaseClient();

    // Fetch candidates, then derive the final effective result with manual priority.
    let query = supabase
      .from(predictionTable)
      .select("*");

    if (league !== "ALL") {
      query = query.eq("league", league);
    }
    if (trainingWindowStart) query = query.gte("match_date", trainingWindowStart);
    if (trainingWindowEnd) query = query.lte("match_date", trainingWindowEnd);
    if (source === "backtest") {
      if (typeof body.runId !== "string" || !body.runId) {
        return NextResponse.json({ error: "回测学习必须指定 runId" }, { status: 400 });
      }
      query = query.eq("run_id", body.runId);
    }

    const { data: rawPredictions, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const focusedLeagues = await loadFocusedLeagues(supabase);
    if (!focusedLeagues) {
      return NextResponse.json({ error: "关注联赛白名单不可用" }, { status: 503 });
    }
    const effectivePredictions = (rawPredictions || []).flatMap(prediction => {
      const learningPrediction = toLearningPrediction(prediction, market);
      return learningPrediction ? [learningPrediction] : [];
    });
    const predictions = focusedLeagues.size > 0
      ? effectivePredictions.filter(prediction => focusedLeagues.has(prediction.league))
      : effectivePredictions;
    const excludedInvalidResult = (rawPredictions?.length || 0) - effectivePredictions.length;
    const excludedByWhitelist = effectivePredictions.length - predictions.length;
    const initialSummary = summarizeMarketRows(
      focusedLeagues.size > 0
        ? (rawPredictions || []).filter(prediction => focusedLeagues.has(String(prediction.league || "")))
        : rawPredictions || [],
      market,
    );

    if (weightedStats(predictions).total < minSamples) {
      const available = weightedStats(predictions).total;
      return NextResponse.json({
        success: true,
        market,
        message: `白名单内加权验证样本不足(${available})，至少需要${minSamples}`,
        patterns: [],
        summary: initialSummary,
        excludedInvalidResult,
        excludedByWhitelist,
      });
    }

    const filteredPredictions = predictions;
    const excludedCount = 0;
    const sortedDates = filteredPredictions
      .map(prediction => String(prediction.match_date || ""))
      .filter(date => /^\d{8}$/.test(date))
      .sort();
    const effectiveTrainingStart = trainingWindowStart || sortedDates[0] || null;
    const effectiveTrainingEnd = trainingWindowEnd || sortedDates.at(-1) || null;

    // --- Pattern Mining ---
    const patterns: {
      key: string;
      description: string;
      indicatorSignals: Record<string, string>;
      total: number;
      correct: number;
      hitRate: number;
      suggestedWeights: Record<string, number>;
    }[] = [];

    // 1. Single indicator patterns
    const indicatorFields = [
      { field: "indicator_handicap_direction", name: "盘口变化方向", defaultWeight: 0.25 },
      { field: "indicator_water_direction", name: "水位变化方向", defaultWeight: 0.15 },
      { field: "indicator_divergence", name: "公司分歧度", defaultWeight: 0.15 },
      { field: "indicator_euro_asian", name: "欧亚偏差", defaultWeight: 0.20 },
      { field: "indicator_open_time", name: "开盘时间早晚", defaultWeight: 0.10 },
      { field: "indicator_total_goals", name: "大小球趋势", defaultWeight: 0.15 },
    ];

    // Compute per-indicator accuracy and adjusted weights
    const newWeights: Record<string, number> = {};
    const indicatorStats: Record<string, { total: number; correct: number }> = {};

    for (const ind of indicatorFields) {
      // Group by signal value
      const groups: Record<string, { total: number; correct: number }> = {};
      for (const pred of filteredPredictions) {
        const val = (pred as Record<string, unknown>)[ind.field] as string | null;
        if (!val) continue;
        if (!groups[val]) groups[val] = { total: 0, correct: 0 };
        groups[val].total += pred.learning_total_weight;
        groups[val].correct += pred.learning_correct_weight;
      }

      for (const [signal, stats] of Object.entries(groups)) {
        if (stats.total >= minSamples && wilsonLowerBound(stats.correct, stats.total) >= 0.5) {
          const hitRate = stats.correct / stats.total;
          patterns.push({
            key: `${ind.field}=${signal}`,
            description: `${ind.name}=${signal}`,
            indicatorSignals: { [ind.field]: signal },
            total: stats.total,
            correct: stats.correct,
            hitRate,
            suggestedWeights: {},
          });
        }
      }

      // Compute overall accuracy for this indicator
      const withSignal = filteredPredictions.filter(p => (p as Record<string, unknown>)[ind.field] != null);
      const withSignalStats = weightedStats(withSignal);
      indicatorStats[ind.field] = {
        total: withSignalStats.total,
        correct: withSignalStats.correct,
      };

      const overallStats = weightedStats(filteredPredictions);
      const avgAccuracy = overallStats.total > 0 ? overallStats.hitRate : 0.5;
      const indAccuracy = withSignalStats.total > 0 ? withSignalStats.hitRate : avgAccuracy;

      // Weight adjustment: scale proportionally but keep sum = 1
      const ratio = avgAccuracy > 0 ? indAccuracy / avgAccuracy : 1;
      // Clamp ratio between 0.5 and 2.0 to avoid extreme values
      const clampedRatio = Math.max(0.5, Math.min(2.0, ratio));
      newWeights[ind.field] = ind.defaultWeight * clampedRatio;
    }

    // Normalize weights to sum to 1
    const weightSum = Object.values(newWeights).reduce((a, b) => a + b, 0);
    for (const key of Object.keys(newWeights)) {
      newWeights[key] = parseFloat((newWeights[key] / weightSum).toFixed(4));
    }

    // 2. Two-indicator combination patterns
    for (let i = 0; i < indicatorFields.length; i++) {
      for (let j = i + 1; j < indicatorFields.length; j++) {
        const ind1 = indicatorFields[i];
        const ind2 = indicatorFields[j];

        // Group by combination
        const groups: Record<string, { total: number; correct: number; signals: Record<string, string> }> = {};
        for (const pred of filteredPredictions) {
          const val1 = (pred as Record<string, unknown>)[ind1.field] as string | null;
          const val2 = (pred as Record<string, unknown>)[ind2.field] as string | null;
          if (!val1 || !val2) continue;
          // Only mine directional signals (主降水/客降水/中立)
          if (val1 !== "主降水" && val1 !== "客降水" && val1 !== "中立") continue;
          if (val2 !== "主降水" && val2 !== "客降水" && val2 !== "中立") continue;

          const key = `${ind1.field}=${val1}+${ind2.field}=${val2}`;
          if (!groups[key]) {
            groups[key] = { total: 0, correct: 0, signals: { [ind1.field]: val1, [ind2.field]: val2 } };
          }
          groups[key].total += pred.learning_total_weight;
          groups[key].correct += pred.learning_correct_weight;
        }

        for (const [key, stats] of Object.entries(groups)) {
          if (stats.total >= minSamples && wilsonLowerBound(stats.correct, stats.total) >= 0.5) {
            const hitRate = stats.correct / stats.total;
            patterns.push({
              key,
              description: `${ind1.name}=${stats.signals[ind1.field]} + ${ind2.name}=${stats.signals[ind2.field]}`,
              indicatorSignals: stats.signals,
              total: stats.total,
              correct: stats.correct,
              hitRate,
              suggestedWeights: {},
            });
          }
        }
      }
    }

    // 3. Three-indicator patterns (top combinations only)
    const directionalFields = indicatorFields;
    for (let i = 0; i < directionalFields.length; i++) {
      for (let j = i + 1; j < directionalFields.length; j++) {
        for (let k = j + 1; k < directionalFields.length; k++) {
          const ind1 = directionalFields[i];
          const ind2 = directionalFields[j];
          const ind3 = directionalFields[k];

          const groups: Record<string, { total: number; correct: number; signals: Record<string, string> }> = {};
          for (const pred of filteredPredictions) {
            const val1 = (pred as Record<string, unknown>)[ind1.field] as string | null;
            const val2 = (pred as Record<string, unknown>)[ind2.field] as string | null;
            const val3 = (pred as Record<string, unknown>)[ind3.field] as string | null;
            if (!val1 || !val2 || !val3) continue;
            if ((val1 !== "主降水" && val1 !== "客降水" && val1 !== "中立") ||
                (val2 !== "主降水" && val2 !== "客降水" && val2 !== "中立") ||
                (val3 !== "主降水" && val3 !== "客降水" && val3 !== "中立")) continue;

            const key = `${ind1.field}=${val1}+${ind2.field}=${val2}+${ind3.field}=${val3}`;
            if (!groups[key]) {
              groups[key] = {
                total: 0,
                correct: 0,
                signals: { [ind1.field]: val1, [ind2.field]: val2, [ind3.field]: val3 },
              };
            }
            groups[key].total++;
            if (pred.is_correct) groups[key].correct++;
          }

          for (const [key, stats] of Object.entries(groups)) {
            if (stats.total >= minSamples && wilsonLowerBound(stats.correct, stats.total) >= 0.5) {
              const hitRate = stats.correct / stats.total;
              patterns.push({
                key,
                description: `${ind1.name}=${stats.signals[ind1.field]} + ${ind2.name}=${stats.signals[ind2.field]} + ${ind3.name}=${stats.signals[ind3.field]}`,
                indicatorSignals: stats.signals,
                total: stats.total,
                correct: stats.correct,
                hitRate,
                suggestedWeights: newWeights,
              });
            }
          }
        }
      }
    }

    // --- Save a versioned draft and its statistically qualified patterns ---
    const strategyVersion = generateStrategyVersion();
    const weightsVersion = `${strategyVersion}:weights`;
    const modelVersion = typeof body.modelVersion === "string" && body.modelVersion ? body.modelVersion : DEFAULT_MODEL_VERSION;
    const now = new Date().toISOString();
    const { error: strategyError } = await supabase.from("strategy_versions").insert({
      version: strategyVersion,
      name: `Learned ${market} ${league} ${effectiveTrainingStart || "unknown"}-${effectiveTrainingEnd || "unknown"}`,
      status: "draft",
      rules: { market, league, minSamples, confidenceGate: "wilson-95-lower>=0.5" },
      weights: newWeights,
      model_version: modelVersion,
      model_config: {},
      created_by: request.headers.get("x-authenticated-actor-id"),
      created_at: now,
      updated_at: now,
    });
    if (strategyError) {
      return NextResponse.json({ error: `策略草稿保存失败: ${strategyError.message}` }, { status: 500 });
    }

    let upsertedCount = 0;
    let firstUpsertError: string | null = null;
    for (const pattern of patterns) {
      const { error: upsertError } = await supabase
        .from(patternTable)
        .upsert({
          pattern_key: pattern.key,
          pattern_description: `${market === "handicap" ? "让球" : "进球"}：${pattern.description}`,
          league,
          market,
          total_predictions: pattern.total,
          correct_predictions: pattern.correct,
          hit_rate: pattern.hitRate,
          indicator_signals: pattern.indicatorSignals,
          suggested_weights: Object.keys(pattern.suggestedWeights).length > 0 ? pattern.suggestedWeights : newWeights,
          strategy_version: strategyVersion,
          weights_version: weightsVersion,
          model_version: modelVersion,
          status: "draft",
          published_at: null,
          retired_at: null,
          training_window_start: effectiveTrainingStart,
          training_window_end: effectiveTrainingEnd,
          last_updated: now,
        }, {
          onConflict: "market,pattern_key,league",
        });

      if (upsertError) {
        firstUpsertError ||= upsertError.message;
      } else {
        upsertedCount++;
      }
    }

    if (firstUpsertError) {
      return NextResponse.json({
        error: `学习模式保存失败: ${firstUpsertError}`,
        patternsFound: patterns.length,
        patternsUpserted: upsertedCount,
      }, { status: 500 });
    }

    // --- Get top patterns for response ---
    const topPatterns = patterns
      .filter(p => p.total >= minSamples)
      .sort((a, b) => b.hitRate - a.hitRate)
      .slice(0, 20);

    const overallStats = weightedStats(filteredPredictions);
    const totalPredictions = overallStats.total;
    const totalCorrect = overallStats.correct;
    const overallAccuracy = totalPredictions > 0 ? `${(overallStats.hitRate * 100).toFixed(1)}%` : "N/A";
    const marketSummary = summarizeMarketRows(filteredPredictions, market);

    sendFeishuVerifyResult({
      date: `${league === "ALL" ? "全部" : league}-${market === "handicap" ? "让球" : "进球"}`,
      total: totalPredictions,
      correct: totalCorrect,
      accuracy: overallAccuracy,
      topPatterns: topPatterns.map(p => ({
        pattern_key: p.key,
        hit_rate: `${(p.hitRate * 100).toFixed(1)}%`,
        total_predictions: p.total,
      })),
    }).catch(() => {/* Don't block */});

    return NextResponse.json({
      success: true,
      market,
      totalPredictions,
      totalCorrect,
      summary: marketSummary,
      excludedIncomplete: excludedCount,
      excludedInvalidResult,
      excludedByWhitelist,
      overallAccuracy,
      patternsFound: patterns.length,
      patternsUpserted: upsertedCount,
      strategyVersion,
      weightsVersion,
      modelVersion,
      trainingWindow: { start: effectiveTrainingStart, end: effectiveTrainingEnd },
      confidenceGate: "wilson-95-lower>=0.5",
      dynamicWeights: newWeights,
      topPatterns: topPatterns.map(p => ({
        key: p.key,
        description: p.description,
        total: p.total,
        correct: p.correct,
        hitRate: `${(p.hitRate * 100).toFixed(1)}%`,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "学习失败";
    console.error("[Learn] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Get current learned patterns and dynamic weights
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const league = searchParams.get("league") || "ALL";
    const marketParam = searchParams.get("market") || "handicap";
    if (marketParam !== "handicap" && marketParam !== "total") {
      return NextResponse.json({ error: "market必须是handicap或total" }, { status: 400 });
    }
    const market: PredictionMarket = marketParam;

    const supabase = getSupabaseClient();

    // Get top patterns sorted by hit rate
    let query = supabase
      .from("learned_patterns")
      .select("*")
      .eq("market", market)
      .eq("status", "published")
      .lte("published_at", new Date().toISOString())
      .gte("total_predictions", MIN_PATTERN_SAMPLES_FOR_DISPLAY)
      .order("hit_rate", { ascending: false })
      .limit(30);

    if (league !== "ALL") {
      query = query.eq("league", league);
    }

    const { data: patterns, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Get the most recent suggested_weights from 3-indicator patterns (most evolved)
    const threeIndicatorPattern = patterns?.find(p => {
      const signals = p.indicator_signals as Record<string, string>;
      return Object.keys(signals).length >= 3 && p.suggested_weights;
    });

    const { data: predictionRows, error: predictionError } = await supabase
      .from("prediction_results")
      .select("*");
    if (predictionError) {
      return NextResponse.json({ error: predictionError.message }, { status: 500 });
    }
    const handicapSummary = summarizeMarketRows(predictionRows || [], "handicap");
    const totalSummary = summarizeMarketRows(predictionRows || [], "total");
    const selectedSummary = market === "handicap" ? handicapSummary : totalSummary;
    const legacyAccuracy = handicapSummary.weightedAccuracy === null
      ? "N/A"
      : `${(handicapSummary.weightedAccuracy * 100).toFixed(1)}%`;

    return NextResponse.json({
      success: true,
      market,
      markets: { handicap: handicapSummary, total: totalSummary },
      totalPredictions: handicapSummary.weightedTotal,
      correctPredictions: handicapSummary.weightedCorrect,
      overallAccuracy: legacyAccuracy,
      selectedMarketAccuracy: selectedSummary.weightedAccuracy === null
        ? "N/A"
        : `${(selectedSummary.weightedAccuracy * 100).toFixed(1)}%`,
      dynamicWeights: threeIndicatorPattern?.suggested_weights || null,
      topPatterns: (patterns || []).slice(0, 15).map(p => ({
        key: p.pattern_key,
        description: p.pattern_description,
        market: p.market,
        league: p.league,
        total: p.total_predictions,
        correct: p.correct_predictions,
        hitRate: `${(p.hit_rate * 100).toFixed(1)}%`,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "获取失败";
    console.error("[Learn GET] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
