import { NextRequest, NextResponse } from "next/server";
import { llmInvoke, webSearch } from "@/lib/llm";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { sendFeishuAIAnalysis } from "@/app/api/feishu/_helpers";
import { isInternalRequest } from "@/lib/internal-auth";
import { upsertMatchT30Task } from "@/lib/automation/match-t30-task";
import { SupabaseAutomationRepository } from "@/lib/automation/repository";
import { serializeVerification, settleMarket } from "@/lib/verification/market-service";
import {
  finalizeAnalysisProbability,
  prepareAnalysisProbability,
  probabilityPromptContext,
  type AnalysisProbabilityOutput,
} from "@/lib/probability";
import {
  DEFAULT_INDICATOR_WEIGHTS,
  loadPublishedStrategy,
  normalizeIndicatorWeights,
  predictionAsOf,
  type IndicatorWeights,
  type StrategySnapshot,
} from "@/lib/analysis/strategy";

function parseDbJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseDbJsonObject<T>(value: unknown): T | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as T;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : null;
    } catch {
      return null;
    }
  }
  return null;
}

// --- Types ---

interface AnalysisResultData {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchTime: string;
  matchDate?: string;
  analyzedAt?: string | null;
  indicators: { name: string; value: string; signal: string; weight: number; reasoning: string }[];
  newsSummary: string;
  waterDirection: string;    // "主降水" | "客降水" | "不变" — 核心预测
  handicapTrend: string;     // 保留作参考（升盘/降盘/不变）
  prediction: string;        // "主" | "客" | "中立" — 由waterDirection派生
  totalTrend: string;
  totalPrediction: string;
  totalAction: string;
  confidenceLevel: string;
  accuracy: string;
  strategy: string;
  action: string;
  reasoning: string;
  crown_handicap: string;
  yinghe_handicap: string;
  who_open_later: string;
  isCorrect?: boolean | null;
  manualIsCorrect?: boolean | null;
  verification?: ReturnType<typeof serializeVerification>;
  settlementEvidence?: Record<string, unknown>;
  probability?: AnalysisProbabilityOutput | null;
}

interface AnalysisRequest {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchTime: string;
  matchDate?: string;
  source?: "production" | "backtest";
  runId?: string;
  scheduleMode: string;
  analysisTrigger?: "match-t30";
  sourceObservedAt?: string | null;
  companies: CompanyOddsForAnalysis[];
  crown12Handicap?: { home: string; line: string; away: string };
  crown12Total?: { over: string; line: string; under: string };
  crownLiveHandicap?: { home: string; line: string; away: string };
  crownLiveTotal?: { over: string; line: string; under: string };
}

interface CompanyOddsForAnalysis {
  companyId: string;
  companyName: string;
  openTime: string;
  asianHomeInit: string;
  asianLineInit: string;
  asianAwayInit: string;
  euroAsianHomeInit: string;
  euroAsianLineInit: string;
  euroAsianAwayInit: string;
  totalOverInit: string;
  totalLineInit: string;
  totalUnderInit: string;
  asianHomeLive: string;
  asianLineLive: string;
  asianAwayLive: string;
  euroHomeInit?: string;
  euroDrawInit?: string;
  euroAwayInit?: string;
}

// 信号类型：直接输出水位方向（核心预测目标）
type WaterSignal = "主降水" | "客降水" | "中立" | "不确定";

interface RuleIndicator {
  name: string;
  value: string;
  signal: WaterSignal;      // 亚盘指标统一使用水位方向信号
  weight: number;
  reasoning: string;
}

interface AnalysisResult {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchTime: string;
  analyzedAt: string;
  indicators: RuleIndicator[];
  newsSummary: string;
  llmPrediction: {
    waterDirection: string;    // "主降水" | "客降水" | "不变" — 核心预测
    handicapTrend: string;     // 保留参考
    prediction: string;        // "主" | "客" | "中立"
    totalTrend: string;
    totalPrediction: string;
    confidenceLevel: string;
    accuracy: string;
    strategy: string;
    action: string;
    totalAction: string;
    reasoning: string;
  };
  priorityRules: {
    matched: { id: string; priority: string; description: string; implication: string; hitRate: number; samples: number }[];
    topPriority: string | null;
  };
  crown_handicap: string;
  yinghe_handicap: string;
  who_open_later: string;
  strategy: string;
  prediction: string;
  water_direction: string;   // 核心预测结果
  accuracy: string;
  confidence_level: string;
  action: string;
  total_prediction: string;
  total_trend: string;
  total_action: string;
  probability: AnalysisProbabilityOutput;
  verification?: ReturnType<typeof serializeVerification>;
  settlementEvidence?: Record<string, unknown>;
}

// --- Rule Engine ---

function parseNumber(s: string | undefined | null): number {
  if (!s) return NaN;
  const cleaned = s.replace(/[*受让球手半]/g, "").replace("一", "1").replace("两", "2").replace("三", "3").replace("四", "4").replace("五", "5");
  const n = parseFloat(cleaned);
  return n;
}

// Convert Chinese handicap line to numeric value
function handicapLineToNumber(line: string): number {
  if (!line) return NaN;
  const cleanStar = line.replace(/^\*/, "");
  const isReceiving = cleanStar.startsWith("受让") || cleanStar.startsWith("受");
  const cleanLine = cleanStar.replace(/^受让/, "").replace(/^受/, "");
  
  const chineseMap: Record<string, number> = {
    "平手": 0, "平": 0,
    "半球": 0.5, "半": 0.5,
    "一球": 1, "一": 1,
    "一球半": 1.5,
    "两球": 2, "两": 2,
    "两球半": 2.5,
    "三球": 3, "三": 3,
    "三球半": 3.5,
    "四球": 4, "四": 4,
    "四球半": 4.5,
    "球半": 1.5,
  };
  
  if (cleanLine.includes("/")) {
    const parts = cleanLine.split("/");
    const low = chineseMap[parts[0]] ?? parseFloat(parts[0]);
    const high = chineseMap[parts[1]] ?? parseFloat(parts[1]);
    if (!isNaN(low) && !isNaN(high)) {
      const val = (low + high) / 2;
      return isReceiving ? -val : val;
    }
  }
  
  if (chineseMap[cleanLine] !== undefined) {
    return isReceiving ? -chineseMap[cleanLine] : chineseMap[cleanLine];
  }
  
  const numVal = parseFloat(cleanLine);
  if (!isNaN(numVal)) return isReceiving ? -numVal : numVal;
  
  return NaN;
}

// 判断主队是否为让球方（init line > 0 表示主让）
function isHomeFavoring(initLine: number): boolean {
  return initLine > 0;
}

// 将盘口升降信号映射为水位方向信号
// 升盘=让球方优势扩大=让球方被看好=让球方水位下降
// 降盘=让球方优势缩小=受让方被看好=受让方水位下降
function mapLineChangeToWaterSignal(
  lineChange: "up" | "down" | "same" | "cross_to_receiving" | "cross_to_favoring",
  companyInitLine: number
): WaterSignal {
  if (lineChange === "same") return "中立";
  
  const homeIsFav = isHomeFavoring(companyInitLine);
  
  if (lineChange === "up") {
    // 升盘=让球方优势扩大 → 让球方水位下降
    return homeIsFav ? "主降水" : "客降水";
  }
  if (lineChange === "down") {
    // 降盘=让球方优势缩小 → 受让方水位下降
    return homeIsFav ? "客降水" : "主降水";
  }
  if (lineChange === "cross_to_receiving") {
    // 从让变受=让球方优势大幅缩小 → 受让方(此时是主队)被看好 → 主降水
    // 但其实从让变受意味着盘口方向翻转，让球方变成了受让方
    // 例如: init=+0.25(主让) → ref=-0.25(主受)
    // 这意味着客队从被让变成了让球，客队被看好 → 客降水
    return homeIsFav ? "客降水" : "主降水";
  }
  if (lineChange === "cross_to_favoring") {
    // 从受变让=让球方优势大幅扩大 → 新让球方被看好
    // 例如: init=-0.25(主受) → ref=+0.25(主让)
    // 这意味着主队从受让变成让球，主队被看好 → 主降水
    return homeIsFav ? "主降水" : "客降水";
  }
  
  return "中立";
}

function computeRuleIndicators(req: AnalysisRequest, weights: IndicatorWeights = DEFAULT_INDICATOR_WEIGHTS): RuleIndicator[] {
  const indicators: RuleIndicator[] = [];
  const crown = req.companies.find(c => c.companyId === "3");
  const yinghe = req.companies.find(c => c.companyId === "35");
  const bet18 = req.companies.find(c => c.companyId === "42");
  const pingbo = req.companies.find(c => c.companyId === "47");
  const bet365 = req.companies.find(c => c.companyId === "8");
  
  const defaultCompanies = [crown, yinghe, bet18, pingbo, bet365].filter(Boolean) as CompanyOddsForAnalysis[];
  const isFuture = req.scheduleMode === "future";
  const isHistory = req.scheduleMode === "history";

  const refHandicap = isFuture ? req.crownLiveHandicap : req.crown12Handicap;
  const refTotal = isFuture ? req.crownLiveTotal : req.crown12Total;
  const refLabel = isFuture ? "皇冠即时" : "皇冠新数据";

  // === Indicator 1: 盘口变化 → 水位方向 ===
  // 比较各公司亚盘初盘 vs 参照盘口(crown12/crownLive)
  // 升盘=让球方优势扩大→让球方降水，降盘=让球方优势缩小→受让方降水
  {
    let homeWaterDropCount = 0;   // 指向主降水的信号数
    let awayWaterDropCount = 0;   // 指向客降水的信号数
    let neutralCount = 0;
    let total = 0;
    const detailLines: string[] = [];

    if (refHandicap?.line) {
      const refLine = handicapLineToNumber(refHandicap.line);
      if (!isNaN(refLine)) {
        for (const comp of defaultCompanies) {
          const initLine = handicapLineToNumber(comp.asianLineInit);
          if (isNaN(initLine)) continue;
          total++;

          let lineChange: "up" | "down" | "same" | "cross_to_receiving" | "cross_to_favoring";
          
          if (initLine > 0 && refLine < 0) {
            lineChange = "cross_to_receiving"; // 让→受
            detailLines.push(`${comp.companyName}:${comp.asianLineInit}→${refHandicap.line}(让→受)`);
          } else if (initLine < 0 && refLine > 0) {
            lineChange = "cross_to_favoring"; // 受→让
            detailLines.push(`${comp.companyName}:${comp.asianLineInit}→${refHandicap.line}(受→让)`);
          } else {
            const absDiff = parseFloat((Math.abs(refLine) - Math.abs(initLine)).toFixed(2));
            if (absDiff > 0.01) {
              lineChange = "up"; // 升盘
              detailLines.push(`${comp.companyName}:${comp.asianLineInit}→${refHandicap.line}(升盘)`);
            } else if (absDiff < -0.01) {
              lineChange = "down"; // 降盘
              detailLines.push(`${comp.companyName}:${comp.asianLineInit}→${refHandicap.line}(降盘)`);
            } else {
              lineChange = "same";
              detailLines.push(`${comp.companyName}:${comp.asianLineInit}→${refHandicap.line}(不变)`);
            }
          }

          const waterSignal = mapLineChangeToWaterSignal(lineChange, initLine);
          if (waterSignal === "主降水") homeWaterDropCount++;
          else if (waterSignal === "客降水") awayWaterDropCount++;
          else neutralCount++;
        }
      }
    }

    // Fallback: 公司初盘 vs 即时盘口
    if (total === 0) {
      for (const comp of defaultCompanies) {
        const initLine = handicapLineToNumber(comp.asianLineInit);
        const liveLine = handicapLineToNumber(comp.asianLineLive);
        if (isNaN(initLine) || isNaN(liveLine)) continue;
        total++;

        let lineChange: "up" | "down" | "same" | "cross_to_receiving" | "cross_to_favoring";
        if (initLine > 0 && liveLine < 0) {
          lineChange = "cross_to_receiving";
        } else if (initLine < 0 && liveLine > 0) {
          lineChange = "cross_to_favoring";
        } else {
          const absDiff = parseFloat((Math.abs(liveLine) - Math.abs(initLine)).toFixed(2));
          if (absDiff > 0.01) lineChange = "up";
          else if (absDiff < -0.01) lineChange = "down";
          else lineChange = "same";
        }

        const waterSignal = mapLineChangeToWaterSignal(lineChange, initLine);
        if (waterSignal === "主降水") homeWaterDropCount++;
        else if (waterSignal === "客降水") awayWaterDropCount++;
        else neutralCount++;
      }
    }

    let signal: WaterSignal = "不确定";
    let reasoning = "";

    if (total > 0) {
      if (homeWaterDropCount > awayWaterDropCount && homeWaterDropCount >= total * 0.5) {
        signal = "主降水";
        reasoning = `多数公司盘口变化指向主降水(${homeWaterDropCount}/${total})，资金流入主队`;
      } else if (awayWaterDropCount > homeWaterDropCount && awayWaterDropCount >= total * 0.5) {
        signal = "客降水";
        reasoning = `多数公司盘口变化指向客降水(${awayWaterDropCount}/${total})，资金流入客队`;
      } else if (homeWaterDropCount === awayWaterDropCount && homeWaterDropCount > 0) {
        signal = "中立";
        reasoning = `主降水${homeWaterDropCount}项/客降水${awayWaterDropCount}项，方向分歧`;
      } else if (neutralCount === total) {
        signal = "中立";
        reasoning = `所有公司亚盘初与${refLabel}盘口一致，无变化`;
      } else {
        signal = "中立";
        reasoning = `主降水${homeWaterDropCount}/客降水${awayWaterDropCount}/中立${neutralCount}`;
      }
      if (detailLines.length > 0) {
        reasoning += ` [${detailLines.slice(0, 4).join(", ")}]`;
      }
    } else {
      reasoning = `无${refLabel}数据可供对比`;
    }

    indicators.push({
      name: "盘口变化方向",
      value: total > 0 ? `主降水${homeWaterDropCount}/客降水${awayWaterDropCount}/中立${neutralCount}(${total}家)` : "无参照数据",
      signal,
      weight: weights.indicator_handicap_direction,
      reasoning,
    });
  }

  // === Indicator 2: 水位变化方向 → 直接映射降水方向 ===
  // 水位下降=该方被市场看好=资金流入=该方降水
  // 这是最直接的降水方向指标！权重最高
  {
    let homeOddsDrop = 0;   // 主水下降→主降水
    let awayOddsDrop = 0;   // 客水下降→客降水
    let total = 0;
    
    // Compare company init water vs company live water
    for (const comp of defaultCompanies) {
      const initHome = parseNumber(comp.asianHomeInit);
      const liveHome = parseNumber(comp.asianHomeLive);
      const initAway = parseNumber(comp.asianAwayInit);
      const liveAway = parseNumber(comp.asianAwayLive);
      if (isNaN(initHome) || isNaN(liveHome) || isNaN(initAway) || isNaN(liveAway)) continue;
      total++;
      if (liveHome < initHome) homeOddsDrop++;
      if (liveAway < initAway) awayOddsDrop++;
    }
    
    // Also compare with reference water (crown12/crownLive)
    if (refHandicap && crown) {
      const initHome = parseNumber(crown.asianHomeInit);
      const initAway = parseNumber(crown.asianAwayInit);
      const refHome = parseNumber(refHandicap.home);
      const refAway = parseNumber(refHandicap.away);
      if (!isNaN(initHome) && !isNaN(refHome) && !isNaN(initAway) && !isNaN(refAway)) {
        total++;
        if (refHome < initHome) homeOddsDrop++;
        if (refAway < initAway) awayOddsDrop++;
      }
    }
    
    let signal: WaterSignal = "不确定";
    let reasoning = "";
    
    if (total > 0) {
      if (homeOddsDrop > awayOddsDrop && homeOddsDrop >= total * 0.5) {
        signal = "主降水";
        reasoning = `主水下降${homeOddsDrop}项(共${total}项)，资金持续流入主队`;
      } else if (awayOddsDrop > homeOddsDrop && awayOddsDrop >= total * 0.5) {
        signal = "客降水";
        reasoning = `客水下降${awayOddsDrop}项(共${total}项)，资金持续流入客队`;
      } else {
        signal = "中立";
        reasoning = `主水降${homeOddsDrop}项，客水降${awayOddsDrop}项，无明显倾向`;
      }
    } else {
      signal = "不确定";
      reasoning = "无有效水位数据";
    }
    
    indicators.push({
      name: "水位变化方向",
      value: total > 0 ? `主水降${homeOddsDrop}/${total}` : "无数据",
      signal,
      weight: weights.indicator_water_direction,  // 水位方向是最直接的预测指标，提高权重
      reasoning,
    });
  }

  // === Indicator 3: 公司分歧度 ===
  {
    const lines: number[] = [];
    for (const comp of defaultCompanies) {
      const line = handicapLineToNumber(comp.asianLineInit);
      if (!isNaN(line)) lines.push(line);
    }
    
    let signal: WaterSignal = "中立";
    let reasoning = "";
    let value = "";
    
    if (lines.length >= 2) {
      const maxLine = Math.max(...lines);
      const minLine = Math.min(...lines);
      const diff = maxLine - minLine;
      value = `差值${diff.toFixed(2)}`;
      
      if (diff >= 0.5) {
        signal = "不确定";
        reasoning = `各公司盘口差异大(${minLine}~${maxLine})，市场分歧明显，降水方向不确定`;
      } else if (diff >= 0.25) {
        signal = "不确定";
        reasoning = `各公司盘口有分歧(${minLine}~${maxLine})，需关注后续调整`;
      } else {
        signal = "中立";
        reasoning = `各公司盘口基本一致，市场分歧小`;
      }
    } else {
      value = "数据不足";
      signal = "不确定";
      reasoning = "公司数据不足，无法判断分歧度";
    }
    
    indicators.push({
      name: "公司分歧度",
      value,
      signal,
      weight: weights.indicator_divergence,
      reasoning,
    });
  }

  // === Indicator 4: 欧亚偏差 → 水位方向 ===
  // 亚盘>欧转亚 → 偏主 → 主降水
  // 亚盘<欧转亚 → 偏客 → 客降水
  {
    const euroAsianData: { company: string; openTime: string; asianLine: number; euroAsianLine: number }[] = [];

    for (const comp of defaultCompanies) {
      const asianLine = handicapLineToNumber(comp.asianLineInit);
      const euroAsianLine = handicapLineToNumber(comp.euroAsianLineInit);
      if (isNaN(asianLine) || isNaN(euroAsianLine)) continue;

      if (comp.openTime) {
        euroAsianData.push({
          company: comp.companyName,
          openTime: comp.openTime,
          asianLine,
          euroAsianLine,
        });
      }
    }

    let aboveCount = 0; // 亚盘 > 欧转亚 → 偏主 → 主降水
    let belowCount = 0; // 亚盘 < 欧转亚 → 偏客 → 客降水
    let totalCount = 0;

    for (const comp of defaultCompanies) {
      const asianLine = handicapLineToNumber(comp.asianLineInit);
      const euroAsianLine = handicapLineToNumber(comp.euroAsianLineInit);
      if (isNaN(asianLine) || isNaN(euroAsianLine)) continue;
      totalCount++;
      const deviation = asianLine - euroAsianLine;
      if (deviation > 0.01) aboveCount++;
      else if (deviation < -0.01) belowCount++;
    }

    // Determine euro-asian trend by opening time
    let trendDirection: "偏主" | "偏客" | "平稳" | "不确定" = "不确定";
    let trendDetail = "";

    if (euroAsianData.length >= 2) {
      euroAsianData.sort((a, b) => {
        const na = normalizeOpenTime(a.openTime);
        const nb = normalizeOpenTime(b.openTime);
        return na.localeCompare(nb);
      });

      const earlyHalf = euroAsianData.slice(0, Math.ceil(euroAsianData.length / 2));
      const lateHalf = euroAsianData.slice(Math.ceil(euroAsianData.length / 2));

      const earlyAvgEuroAsian = earlyHalf.reduce((s, d) => s + d.euroAsianLine, 0) / earlyHalf.length;
      const lateAvgEuroAsian = lateHalf.length > 0
        ? lateHalf.reduce((s, d) => s + d.euroAsianLine, 0) / lateHalf.length
        : earlyAvgEuroAsian;

      const trendDiff = lateAvgEuroAsian - earlyAvgEuroAsian;

      // 同盘口不同水位: 亚盘主水早晚对比
      const earlyCompHomeOdds: number[] = [];
      const lateCompHomeOdds: number[] = [];
      for (const comp of defaultCompanies) {
        if (!comp.openTime) continue;
        const homeOdds = parseNumber(comp.asianHomeInit);
        if (isNaN(homeOdds)) continue;
        const earlyMaxTime = earlyHalf.length > 0 ? earlyHalf[earlyHalf.length - 1].openTime : "";
        if (normalizeOpenTime(comp.openTime) <= normalizeOpenTime(earlyMaxTime)) {
          earlyCompHomeOdds.push(homeOdds);
        } else {
          lateCompHomeOdds.push(homeOdds);
        }
      }
      const earlyHomeAvg = earlyCompHomeOdds.length > 0 ? earlyCompHomeOdds.reduce((s, v) => s + v, 0) / earlyCompHomeOdds.length : NaN;
      const lateHomeAvg = lateCompHomeOdds.length > 0 ? lateCompHomeOdds.reduce((s, v) => s + v, 0) / lateCompHomeOdds.length : NaN;
      const euroAsianWaterNote = (!isNaN(earlyHomeAvg) && !isNaN(lateHomeAvg) && Math.abs(lateHomeAvg - earlyHomeAvg) > 0.02)
        ? `，亚盘晚开主水${lateHomeAvg < earlyHomeAvg ? "更低" : "更高"}(${lateHomeAvg.toFixed(2)} vs ${earlyHomeAvg.toFixed(2)})`
        : "";

      if (trendDiff < -0.05) {
        trendDirection = "偏客"; // 欧转亚下降→市场看淡主队
        trendDetail = `晚开(${lateHalf.map(d => d.company).join("/")})欧转亚均${lateAvgEuroAsian.toFixed(2)} < 早开均${earlyAvgEuroAsian.toFixed(2)}${euroAsianWaterNote}`;
      } else if (trendDiff > 0.05) {
        trendDirection = "偏主"; // 欧转亚上升→市场看好主队
        trendDetail = `晚开(${lateHalf.map(d => d.company).join("/")})欧转亚均${lateAvgEuroAsian.toFixed(2)} > 早开均${earlyAvgEuroAsian.toFixed(2)}${euroAsianWaterNote}`;
      } else {
        trendDirection = "平稳";
        trendDetail = `欧转亚盘从早到晚变化不大(${earlyAvgEuroAsian.toFixed(2)}→${lateAvgEuroAsian.toFixed(2)})${euroAsianWaterNote}`;
      }
    }

    // Combine trend + deviation for signal
    let signal: WaterSignal = "中立";
    let reasoning = "";
    let value = "";

    if (totalCount > 0) {
      const asianAboveEuro = aboveCount > belowCount;
      value = `亚盘>欧转亚${aboveCount}家,亚盘<欧转亚${belowCount}家,趋势${trendDirection}`;

      if (trendDirection === "偏客" && asianAboveEuro) {
        // 欧转亚趋势偏客 + 亚盘高于欧转亚 → 庄家亚盘坚挺看主，但欧赔方向偏客
        signal = "主降水";
        reasoning = `欧转亚趋势偏客(${trendDetail})，但亚盘普遍高于欧转亚(${aboveCount}/${totalCount})，庄家亚盘态度坚挺看主，主水可能继续下降`;
      } else if (trendDirection === "偏客" && !asianAboveEuro) {
        signal = "客降水";
        reasoning = `欧转亚趋势偏客(${trendDetail})，亚盘低于欧转亚(${belowCount}/${totalCount})，欧赔和亚盘都指向客队，客水可能继续下降`;
      } else if (trendDirection === "偏主" && asianAboveEuro) {
        signal = "主降水";
        reasoning = `欧转亚趋势偏主(${trendDetail})，亚盘仍高于欧转亚(${aboveCount}/${totalCount})，欧赔也在支持主队，主水可能继续下降`;
      } else if (trendDirection === "偏主" && !asianAboveEuro) {
        signal = "客降水";
        reasoning = `欧转亚趋势偏主(${trendDetail})，但亚盘低于欧转亚(${belowCount}/${totalCount})，庄家不认可主队优势，客水可能下降`;
      } else if (trendDirection === "平稳" && asianAboveEuro) {
        signal = "主降水";
        reasoning = `欧转亚趋势平稳(${trendDetail})，亚盘高于欧转亚(${aboveCount}/${totalCount})，庄家亚盘态度偏主，主水可能下降`;
      } else if (trendDirection === "平稳" && !asianAboveEuro) {
        signal = "客降水";
        reasoning = `欧转亚趋势平稳(${trendDetail})，亚盘低于欧转亚(${belowCount}/${totalCount})，庄家亚盘态度偏客，客水可能下降`;
      } else {
        if (aboveCount > belowCount && aboveCount >= totalCount * 0.5) {
          signal = "主降水";
          reasoning = `无开盘时间趋势数据，亚盘普遍高于欧转亚(${aboveCount}/${totalCount})，偏主方向`;
        } else if (belowCount > aboveCount && belowCount >= totalCount * 0.5) {
          signal = "客降水";
          reasoning = `无开盘时间趋势数据，亚盘普遍低于欧转亚(${belowCount}/${totalCount})，偏客方向`;
        } else {
          signal = "中立";
          reasoning = `亚盘与欧转亚偏差不明显(高${aboveCount}家低${belowCount}家)`;
        }
      }
    } else {
      value = "无数据";
      signal = "不确定";
      reasoning = "无有效欧亚对比数据";
    }

    indicators.push({
      name: "欧亚偏差",
      value,
      signal,
      weight: weights.indicator_euro_asian,
      reasoning,
    });
  }

  // === Indicator 5: 开盘时间早晚 → 水位方向 ===
  // 晚开主水更低=资金流入主队=主降水，晚开客水更低=客降水
  {
    const openTimes: { company: string; time: string; line: number; homeOdds: number; awayOdds: number }[] = [];
    
    for (const comp of defaultCompanies) {
      if (!comp.openTime) continue;
      const line = handicapLineToNumber(comp.asianLineInit);
      if (isNaN(line)) continue;
      const homeOdds = parseNumber(comp.asianHomeInit);
      const awayOdds = parseNumber(comp.asianAwayInit);
      openTimes.push({ company: comp.companyName, time: comp.openTime, line, homeOdds, awayOdds });
    }
    
    let signal: WaterSignal = "中立";
    let reasoning = "";
    let value = "";
    
    if (openTimes.length >= 2) {
      openTimes.sort((a, b) => {
        const na = normalizeOpenTime(a.time);
        const nb = normalizeOpenTime(b.time);
        return na.localeCompare(nb);
      });
      
      const early = openTimes.slice(0, Math.ceil(openTimes.length / 2));
      const late = openTimes.slice(Math.ceil(openTimes.length / 2));
      
      // 同盘口不同水位: 比较早开 vs 晚开的主水/客水均值
      const earlyHomeOdds = early.filter(o => !isNaN(o.homeOdds));
      const lateHomeOdds = late.filter(o => !isNaN(o.homeOdds));
      const earlyAwayOdds = early.filter(o => !isNaN(o.awayOdds));
      const lateAwayOdds = late.filter(o => !isNaN(o.awayOdds));
      
      let waterSignal = "";
      if (earlyHomeOdds.length > 0 && lateHomeOdds.length > 0) {
        const earlyHomeAvg = earlyHomeOdds.reduce((s, o) => s + o.homeOdds, 0) / earlyHomeOdds.length;
        const lateHomeAvg = lateHomeOdds.reduce((s, o) => s + o.homeOdds, 0) / lateHomeOdds.length;
        const earlyAwayAvg = earlyAwayOdds.length > 0 ? earlyAwayOdds.reduce((s, o) => s + o.awayOdds, 0) / earlyAwayOdds.length : NaN;
        const lateAwayAvg = lateAwayOdds.length > 0 ? lateAwayOdds.reduce((s, o) => s + o.awayOdds, 0) / lateAwayOdds.length : NaN;
        
        const homeWaterDrop = earlyHomeAvg - lateHomeAvg; // 正值=晚开主水更低
        const awayWaterDrop = !isNaN(earlyAwayAvg) && !isNaN(lateAwayAvg) ? earlyAwayAvg - lateAwayAvg : NaN;

        // 盘口绝对值变化
        const earlyAvgAbs = early.reduce((s, o) => s + Math.abs(o.line), 0) / early.length;
        const lateAvgAbs = late.length > 0 ? late.reduce((s, o) => s + Math.abs(o.line), 0) / late.length : earlyAvgAbs;
        const lineDiff = lateAvgAbs - earlyAvgAbs;
        
        value = `早${earlyAvgAbs.toFixed(2)}/晚${lateAvgAbs.toFixed(2)}`;

        // 盘口相同/接近时，水位信号为主
        if (Math.abs(lineDiff) < 0.1) {
          if (homeWaterDrop > 0.03 && (isNaN(awayWaterDrop) || homeWaterDrop > awayWaterDrop)) {
            waterSignal = "同盘晚开主水更低，资金流入主队，主降水";
          } else if (!isNaN(awayWaterDrop) && awayWaterDrop > 0.03 && awayWaterDrop > homeWaterDrop) {
            waterSignal = "同盘晚开客水更低，资金流入客队，客降水";
          } else {
            waterSignal = "同盘水位变化不明显";
          }
        } else {
          // 盘口有变化时，水位作为辅助信号
          if (homeWaterDrop > 0.03) {
            waterSignal = "晚开主水更低，辅助主降水";
          } else if (!isNaN(awayWaterDrop) && awayWaterDrop > 0.03) {
            waterSignal = "晚开客水更低，辅助客降水";
          }
        }
      }
      
      if (waterSignal.includes("主降水")) {
        signal = "主降水";
        reasoning = `开盘时间分析: ${waterSignal}`;
      } else if (waterSignal.includes("客降水")) {
        signal = "客降水";
        reasoning = `开盘时间分析: ${waterSignal}`;
      } else {
        signal = "中立";
        reasoning = `早晚开盘公司盘口接近${waterSignal ? "，" + waterSignal : ""}`;
      }
    } else {
      value = "数据不足";
      signal = "不确定";
      reasoning = "开盘时间数据不足";
    }
    
    indicators.push({
      name: "开盘时间早晚",
      value,
      signal,
      weight: weights.indicator_open_time,
      reasoning,
    });
  }

  // === Indicator 6: 大小球趋势 → 大/小球降水 ===
  {
    let lineUp = 0;
    let lineDown = 0;
    let overOddsDrop = 0;
    let underOddsDrop = 0;
    let total = 0;
    
    for (const comp of defaultCompanies) {
      const initLine = parseNumber(comp.totalLineInit);
      if (isNaN(initLine)) continue;
      total++;
      const initOver = parseNumber(comp.totalOverInit);
      const initUnder = parseNumber(comp.totalUnderInit);
      if (!isNaN(initOver) && initOver < 0.85) overOddsDrop++;
      if (!isNaN(initUnder) && initUnder < 0.85) underOddsDrop++;
    }
    
    if (refTotal?.line && crown) {
      const initLine = parseNumber(crown.totalLineInit);
      const refLine = parseNumber(refTotal.line);
      if (!isNaN(initLine) && !isNaN(refLine)) {
        if (refLine > initLine) lineUp++;
        else if (refLine < initLine) lineDown++;
      }
      const initOver = parseNumber(crown.totalOverInit);
      const refOver = parseNumber(refTotal.over);
      const initUnder = parseNumber(crown.totalUnderInit);
      const refUnder = parseNumber(refTotal.under);
      if (!isNaN(initOver) && !isNaN(refOver) && refOver < initOver) overOddsDrop++;
      if (!isNaN(initUnder) && !isNaN(refUnder) && refUnder < initUnder) underOddsDrop++;
    }
    
    let signal: WaterSignal = "中立";
    let reasoning = "";
    let value = "";
    
    if (total > 0) {
      if (lineUp > lineDown && lineUp >= 1) {
        // 大小球盘口上调 → 大球受热 → 大水可能下降
        signal = "主降水"; // 大球升=进球预期增加=通常对主队进攻端有利
        reasoning = `大小球盘口上调${lineUp}项，大水下降${overOddsDrop}项，进球预期增加`;
        value = `大球升${lineUp}/大水降${overOddsDrop}`;
      } else if (lineDown > lineUp && lineDown >= 1) {
        signal = "客降水"; // 小球方向=防守导向
        reasoning = `大小球盘口下调${lineDown}项，小水下降${underOddsDrop}项，进球预期减少`;
        value = `小球升${lineDown}/小水降${underOddsDrop}`;
      } else {
        signal = "中立";
        reasoning = "大小球盘口无明显趋势";
        value = "无明显趋势";
      }
    } else {
      value = "无数据";
      signal = "不确定";
      reasoning = "无大小球数据";
    }
    
    indicators.push({
      name: "大小球趋势",
      value,
      signal,
      weight: weights.indicator_total_goals,
      reasoning,
    });
  }

  // History mode: mark all indicators as less reliable
  if (isHistory) {
    for (const ind of indicators) {
      ind.reasoning = `[历史数据] ${ind.reasoning}`;
    }
  }

  return indicators;
}

// Pad month/day for proper string comparison
function normalizeOpenTime(time: string): string {
  return time.replace(/(\d{1,2})-(\d{1,2})\s/, (_, m, d) => `${m.padStart(2, "0")}-${d.padStart(2, "0")} `);
}

// --- Priority Rule Engine (水位方向版本) ---
// 信号类型: 主降水/客降水/中立/不确定

type IndicatorKey = "handicap" | "water" | "divergence" | "euroAsian" | "openTime" | "totalGoals";

const INDICATOR_KEY_MAP: Record<string, IndicatorKey> = {
  "盘口变化方向": "handicap",
  "水位变化方向": "water",
  "公司分歧度": "divergence",
  "欧亚偏差": "euroAsian",
  "开盘时间早晚": "openTime",
  "大小球趋势": "totalGoals",
};

interface PriorityRule {
  id: string;
  priority: "P0" | "P1" | "P2" | "P3" | "RED";
  description: string;
  conditions: Partial<Record<IndicatorKey, WaterSignal>>;
  implication: string;
  hitRate: number;
  samples: number;
}

// 优先级规则已清空（基于旧升盘/降盘信号的规则不再适用）
const MIN_LEARNED_PATTERN_SAMPLES_FOR_AI = 20;

// 新规则将由 learn API 基于水位方向验证数据自动生成
const PRIORITY_RULES: PriorityRule[] = [];

interface RuleMatch {
  rule: PriorityRule;
  matched: boolean;
}

function matchPriorityRules(indicators: RuleIndicator[]): RuleMatch[] {
  const signalMap: Partial<Record<IndicatorKey, WaterSignal>> = {};
  for (const ind of indicators) {
    const key = INDICATOR_KEY_MAP[ind.name];
    if (key) {
      signalMap[key] = ind.signal as WaterSignal;
    }
  }

  const matches: RuleMatch[] = [];
  for (const rule of PRIORITY_RULES) {
    let allConditionsMet = true;
    for (const [key, requiredSignal] of Object.entries(rule.conditions)) {
      const actualSignal = signalMap[key as IndicatorKey];
      if (actualSignal !== requiredSignal) {
        allConditionsMet = false;
        break;
      }
    }
    if (allConditionsMet) {
      matches.push({ rule, matched: true });
    }
  }

  return matches;
}

function buildPriorityContext(indicators: RuleIndicator[]): string {
  const matches = matchPriorityRules(indicators);
  if (matches.length === 0) return "";

  const p0 = matches.filter(m => m.rule.priority === "P0");
  const p1 = matches.filter(m => m.rule.priority === "P1");
  const p2 = matches.filter(m => m.rule.priority === "P2");
  const p3 = matches.filter(m => m.rule.priority === "P3");
  const red = matches.filter(m => m.rule.priority === "RED");

  const lines: string[] = [];

  if (p0.length > 0) {
    lines.push("【P0核心规则 - 必须遵循】");
    for (const m of p0) {
      lines.push(`  ✓ ${m.rule.description} (命中${(m.rule.hitRate*100).toFixed(0)}%, ${m.rule.samples}场) → ${m.rule.implication}`);
    }
  }
  if (p1.length > 0) {
    lines.push("【P1强信号 - 高度参考】");
    for (const m of p1) {
      lines.push(`  ✓ ${m.rule.description} (命中${(m.rule.hitRate*100).toFixed(0)}%, ${m.rule.samples}场) → ${m.rule.implication}`);
    }
  }
  if (p2.length > 0) {
    lines.push("【P2辅助确认 - 方向参考】");
    for (const m of p2) {
      lines.push(`  ○ ${m.rule.description} (命中${(m.rule.hitRate*100).toFixed(0)}%, ${m.rule.samples}场) → ${m.rule.implication}`);
    }
  }
  if (p3.length > 0) {
    lines.push("【P3弱势信号 - 仅作补充】");
    for (const m of p3) {
      lines.push(`  △ ${m.rule.description} (命中${(m.rule.hitRate*100).toFixed(0)}%, ${m.rule.samples}场) → ${m.rule.implication}`);
    }
  }
  if (red.length > 0) {
    lines.push("【RED负面警示 - 需警惕】");
    for (const m of red) {
      lines.push(`  ✗ ${m.rule.description} (命中${(m.rule.hitRate*100).toFixed(0)}%, ${m.rule.samples}场) → ${m.rule.implication}`);
    }
  }

  if (p0.length > 0) {
    lines.push("→ 有P0核心规则匹配，应以P0方向为主，置信度可提升一级");
  } else if (p1.length > 0) {
    lines.push("→ 有P1强信号匹配，方向可信度高");
  } else if (red.length > 0 && p0.length === 0 && p1.length === 0) {
    lines.push("→ 仅有RED负面警示匹配，无核心规则支撑，应降低置信度，考虑反向可能");
  } else if (p2.length > 0) {
    lines.push("→ 有P2辅助规则匹配，方向有参考价值但不强烈");
  }

  return lines.join("\n");
}

// --- Web Search for News ---

async function searchMatchNews(
  homeTeam: string,
  awayTeam: string,
): Promise<string> {
  try {
    const query = `${homeTeam} ${awayTeam} 伤停 阵容 赛前分析`;
    const results = await webSearch(query, 5);

    if (!results) return "新闻搜索未配置";

    const newsItems: string[] = [];
    for (const item of results.slice(0, 5)) {
      newsItems.push(`- ${item.title}: ${item.snippet || ""}`);
    }

    return newsItems.length > 0 ? newsItems.join("\n") : "未搜到相关新闻";
  } catch {
    return "新闻搜索失败";
  }
}

// --- LLM Analysis ---

async function llmAnalyze(
  req: AnalysisRequest,
  indicators: RuleIndicator[],
  newsSummary: string,
  learnedContext?: string,
  probabilityContext?: string,
): Promise<AnalysisResult["llmPrediction"]> {

  const crown = req.companies.find(c => c.companyId === "3");
  const yinghe = req.companies.find(c => c.companyId === "35");
  let whoOpenLater = "未知";
  if (crown?.openTime && yinghe?.openTime) {
    const cn = normalizeOpenTime(crown.openTime);
    const yn = normalizeOpenTime(yinghe.openTime);
    if (cn > yn) whoOpenLater = "盈禾先开";
    else if (yn > cn) whoOpenLater = "皇冠先开";
    else whoOpenLater = "同时开盘";
  }

  const crownHandicap = crown?.asianLineInit || "未知";
  const yingheHandicap = yinghe?.asianLineInit || "未知";

  // Build indicators summary
  const indicatorsText = indicators.map(ind => 
    `${ind.name}: ${ind.value} → 信号: ${ind.signal} (权重${(ind.weight * 100).toFixed(0)}%) — ${ind.reasoning}`
  ).join("\n");

  // Compute weighted score for water direction
  let homeWaterScore = 0, awayWaterScore = 0;
  for (const ind of indicators) {
    if (ind.signal === "主降水") homeWaterScore += ind.weight;
    else if (ind.signal === "客降水") awayWaterScore += ind.weight;
  }

  const isFuture = req.scheduleMode === "future";
  const refLabel = isFuture ? "皇冠即时数据" : "皇冠新数据(开盘赔率)";
  const refHandicap = isFuture ? req.crownLiveHandicap : req.crown12Handicap;
  const refTotal = isFuture ? req.crownLiveTotal : req.crown12Total;

  const priorityContext = buildPriorityContext(indicators);

  const systemPrompt = `你是一位专业的足球赔率分析师。你的核心任务是：**预测亚盘水位哪一边会下降（降水）**。

## 核心预测目标
- **主降水**：主队水位下降 → 资金流入主队 → 市场看好主队
- **客降水**：客队水位下降 → 资金流入客队 → 市场看好客队
- **不变**：水位无明显变化趋势

## 分析规则
1. **降水方向是唯一核心判断目标**。水位下降=该方被市场看好=资金流入=该方值得投注
2. 水位变化是最直接的信号：
   - 主水已经在下降 → 主降水信号
   - 客水已经在下降 → 客降水信号
   - 水位下降趋势通常会延续（庄家调整水位是渐进的，不会突然反转）
3. 盘口变化是辅助信号：
   - 升盘（让球方优势扩大）→ 让球方水位可能继续下降
   - 降盘（让球方优势缩小）→ 受让方水位可能继续下降
4. 分析基于公司初盘赔率和${refLabel}，不使用实时变动的即时赔率
5. 综合考虑规则指标(权重60%)和新闻情报(权重40%)
6. 置信度分三级：高(>75%)、中(60-75%)、低(<60%)
7. 大小球分析：大水下降=大球受热，小水下降=小球受热
8. 同盘口不同水位规则（CRITICAL）：当晚开公司与早开公司盘口相同时，水位变化是关键信号——晚开主水更低=资金持续流入主队=强烈主降水信号
9. 欧转亚盘同盘口水位规则：欧转亚晚开公司与早开盘口相同但主水更低，说明市场在欧赔和亚盘两个维度都看好主队，信号更强

## 优先级规则体系
${priorityContext ? `当前赛事匹配的优先级规则：\n${priorityContext}\n` : "暂无匹配的优先级规则，请根据指标信号和新闻综合判断。"}
${learnedContext ? `## 历史学习经验\n${learnedContext}\n` : ""}
${probabilityContext ? "## 概率约束\n服务端概率、五档赛果与EV为只读计算结果。你只能解释，不得生成、修改或在JSON中返回任何概率、EV或模型字段。\n" : ""}
## 输出格式（严格JSON，不要markdown代码块）
{
  "waterDirection": "主降水/客降水/不变",
  "prediction": "主/客/中立",
  "totalTrend": "大球降水/小球降水/不变",
  "totalPrediction": "大/小/中立",
  "confidenceLevel": "高/中/低",
  "accuracy": "XX%",
  "strategy": "一句话策略说明(如: 主水持续下降，资金流入主队)",
  "action": "盘口值 低水方 方向(如: 0/0.5 主水 主, 或: 0.5 客水 客)",
  "totalAction": "大小球盘口 大/小(如: 2.5 大, 或: 3 小)",
  "reasoning": "详细推理过程(100字以内，重点说明为什么预测某方降水)"
}`;

  const userPrompt = `## 赛事信息
联赛: ${req.league}
时间: ${req.matchTime}
主队: ${req.homeTeam}
客队: ${req.awayTeam}
${refHandicap ? `${refLabel}: ${refHandicap.line} (主${refHandicap.home}/客${refHandicap.away})` : ""}
${refTotal ? `${refLabel}大小球: ${refTotal.line} (大${refTotal.over}/小${refTotal.under})` : ""}

## 规则指标分析（加权得分: 主降水${(homeWaterScore * 100).toFixed(0)}% / 客降水${(awayWaterScore * 100).toFixed(0)}%）
${indicatorsText}

## 服务端只读概率结果
${probabilityContext || "概率不可用；不得自行补齐或假设50%"}

## 新闻情报
${newsSummary}

## 各公司赔率明细
${req.companies.map(c => `${c.companyName}(${c.openTime || "无开盘时间"}): 亚盘初${c.asianLineInit}(${c.asianHomeInit}/${c.asianAwayInit}) 亚盘即时${c.asianLineLive}(${c.asianHomeLive}/${c.asianAwayLive}) 欧转亚初${c.euroAsianLineInit} 大小球初${c.totalLineInit}(${c.totalOverInit}/${c.totalUnderInit})`).join("\n")}

谁先开盘: ${whoOpenLater}
皇冠初盘: ${crownHandicap}
盈禾初盘: ${yingheHandicap}

请基于以上信息，预测哪边水位会下降（主降水/客降水/不变），以及大小球水位方向。重点分析水位变化趋势，盘口变化仅作辅助参考。`;

  try {
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ];

    const response = await llmInvoke(messages, {
      temperature: 0.3,
    });

    const content = response.content.trim();
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
    const jsonStr = jsonMatch[1] || content;
    
    try {
      const parsed = JSON.parse(jsonStr.trim());
      const waterDirection = parsed.waterDirection || "不变";
      
      // Derive prediction from waterDirection
      let prediction: string;
      if (waterDirection === "主降水") prediction = "主";
      else if (waterDirection === "客降水") prediction = "客";
      else prediction = "中立";

      // Derive handicap trend for backward compatibility
      let handicapTrend = "不变";
      if (waterDirection === "主降水") {
        // 主降水不一定=升盘，但保持兼容性
        handicapTrend = "升盘";
      } else if (waterDirection === "客降水") {
        handicapTrend = "降盘";
      }

      return {
        waterDirection,
        handicapTrend,
        prediction,
        totalTrend: parsed.totalTrend || "不变",
        totalPrediction: parsed.totalPrediction || "中立",
        confidenceLevel: parsed.confidenceLevel || "低",
        accuracy: parsed.accuracy || "50%",
        strategy: parsed.strategy || "",
        action: parsed.action || "",
        totalAction: parsed.totalAction || "",
        reasoning: parsed.reasoning || "",
      };
    } catch {
      // JSON parse failed, return a basic result based on rule engine
      const homeWater = homeWaterScore > awayWaterScore;
      const waterDirection = homeWater ? "主降水" : awayWaterScore > homeWaterScore ? "客降水" : "不变";
      const prediction = homeWater ? "主" : awayWaterScore > homeWaterScore ? "客" : "中立";
      return {
        waterDirection,
        handicapTrend: homeWater ? "升盘" : awayWaterScore > homeWaterScore ? "降盘" : "不变",
        prediction,
        totalTrend: "不变",
        totalPrediction: "中立",
        confidenceLevel: "低",
        accuracy: "50%",
        strategy: "LLM返回格式异常，使用规则引擎兜底",
        action: `${crown?.asianLineInit || "未知"} ${crown?.asianHomeInit || "?"}/${crown?.asianAwayInit || "?"} ${prediction}`,
        totalAction: `${crown?.totalLineInit || "未知"} 中立`,
        reasoning: `规则引擎: 主降水${(homeWaterScore * 100).toFixed(0)}% 客降水${(awayWaterScore * 100).toFixed(0)}%`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "LLM调用失败";
    console.error("[Analysis] LLM error:", msg);
    const homeWater = homeWaterScore > awayWaterScore;
    const waterDirection = homeWater ? "主降水" : awayWaterScore > homeWaterScore ? "客降水" : "不变";
    const prediction = homeWater ? "主" : awayWaterScore > homeWaterScore ? "客" : "中立";
    return {
      waterDirection,
      handicapTrend: homeWater ? "升盘" : awayWaterScore > homeWaterScore ? "降盘" : "不变",
      prediction,
      totalTrend: "不变",
      totalPrediction: "中立",
      confidenceLevel: "低",
      accuracy: "50%",
      strategy: `LLM调用失败(${msg.slice(0, 30)})，规则引擎兜底`,
      action: `${crown?.asianLineInit || "未知"} ${crown?.asianHomeInit || "?"}/${crown?.asianAwayInit || "?"} ${prediction}`,
      totalAction: `${crown?.totalLineInit || "未知"} 中立`,
      reasoning: `规则引擎: 主降水${(homeWaterScore * 100).toFixed(0)}% 客降水${(awayWaterScore * 100).toFixed(0)}%`,
    };
  }
}

// --- Main Handler ---

export async function POST(request: NextRequest) {
  try {
    const body: AnalysisRequest = await request.json();

    if (body.source === "backtest" && !isInternalRequest(request)) {
      return NextResponse.json({ success: false, error: "回测分析仅允许内部任务调用" }, { status: 403 });
    }

    if (!body.matchId || !body.homeTeam || !body.awayTeam) {
      return NextResponse.json({ success: false, error: "缺少必要参数" }, { status: 400 });
    }

    // Step 0: resolve the strategy that had actually been published at prediction time.
    const asOf = predictionAsOf(body);
    let activeStrategy: StrategySnapshot | null = null;
    let learnedContext = "";
    let learnedWeights: IndicatorWeights = { ...DEFAULT_INDICATOR_WEIGHTS };
    try {
      const supabase = getSupabaseClient();
      activeStrategy = await loadPublishedStrategy(supabase, asOf);
      if (activeStrategy) {
        learnedWeights = normalizeIndicatorWeights(activeStrategy.weights);
        const weightNames: Record<string, string> = {
          indicator_handicap_direction: "盘口变化方向",
          indicator_water_direction: "水位变化方向",
          indicator_divergence: "公司分歧度",
          indicator_euro_asian: "欧亚偏差",
          indicator_open_time: "开盘时间早晚",
          indicator_total_goals: "大小球趋势",
        };
        const weightStr = Object.entries(learnedWeights)
          .map(([key, value]) => `${weightNames[key] || key}: ${(value * 100).toFixed(1)}%`)
          .join(", ");
        learnedContext += `已发布策略 ${activeStrategy.strategyVersion}，动态权重: ${weightStr}\n`;

        if (body.league && body.league !== "ALL") {
          const { data: leaguePatterns } = await supabase
            .from("learned_patterns")
            .select("market, pattern_description, hit_rate, total_predictions")
            .eq("league", body.league)
            .in("status", ["published", "retired"])
            .eq("strategy_version", activeStrategy.strategyVersion)
            .lte("published_at", asOf)
            .or(`retired_at.is.null,retired_at.gt.${asOf}`)
            .gte("hit_rate", 0.6)
            .gte("total_predictions", MIN_LEARNED_PATTERN_SAMPLES_FOR_AI)
            .order("hit_rate", { ascending: false })
            .limit(5);
          for (const pattern of leaguePatterns || []) {
            const marketLabel = pattern.market === "total" ? "进球" : "让球";
            learnedContext += `- [${marketLabel}] ${pattern.pattern_description}: 加权准确率${(pattern.hit_rate * 100).toFixed(0)}% (加权样本${pattern.total_predictions})\n`;
          }
        }
      }
    } catch {
      // Strategy storage is optional during bootstrap; default weights remain explicit.
      activeStrategy = null;
      learnedWeights = { ...DEFAULT_INDICATOR_WEIGHTS };
    }

    const indicators = computeRuleIndicators(body, learnedWeights);
    const preparedProbability = prepareAnalysisProbability(body);
    const probabilityContext = probabilityPromptContext(preparedProbability);

    const newsSummary = await searchMatchNews(body.homeTeam, body.awayTeam);
    const llmPrediction = await llmAnalyze(body, indicators, newsSummary, learnedContext, probabilityContext);
    const probability = finalizeAnalysisProbability(preparedProbability, {
      handicap: llmPrediction.prediction,
      total: llmPrediction.totalPrediction,
    });

    // Determine who opened later
    const crown = body.companies.find(c => c.companyId === "3");
    const yinghe = body.companies.find(c => c.companyId === "35");
    let whoOpenLater = "未知";
    if (crown?.openTime && yinghe?.openTime) {
      const cn = normalizeOpenTime(crown.openTime);
      const yn = normalizeOpenTime(yinghe.openTime);
      if (cn > yn) whoOpenLater = "盈禾先开";
      else if (yn > cn) whoOpenLater = "皇冠先开";
      else whoOpenLater = "同时开盘";
    }

    // Compute weighted scores
    let homeWaterScore = 0, awayWaterScore = 0;
    for (const ind of indicators) {
      if (ind.signal === "主降水") homeWaterScore += ind.weight;
      else if (ind.signal === "客降水") awayWaterScore += ind.weight;
    }

    // Compute priority rule matches
    const priorityMatches = matchPriorityRules(indicators);
    const matchedRules = priorityMatches.map(m => ({
      id: m.rule.id,
      priority: m.rule.priority,
      description: m.rule.description,
      implication: m.rule.implication,
      hitRate: m.rule.hitRate,
      samples: m.rule.samples,
    }));
    const priorityOrder = ["P0", "P1", "P2", "P3", "RED"];
    const topPriority = matchedRules.length > 0
      ? matchedRules.reduce((best, r) => priorityOrder.indexOf(r.priority) < priorityOrder.indexOf(best) ? r.priority : best, "RED")
      : null;

    // Auto-boost confidence based on priority rules
    let finalConfidenceLevel = llmPrediction.confidenceLevel;
    if (topPriority === "P0") {
      finalConfidenceLevel = "高";
    } else if (topPriority === "P1") {
      if (finalConfidenceLevel !== "高") finalConfidenceLevel = "高";
    } else if (topPriority === "RED") {
      if (finalConfidenceLevel === "高") finalConfidenceLevel = "中";
      else if (finalConfidenceLevel === "中") finalConfidenceLevel = "低";
    }

    const analyzedAt = new Date().toISOString();
    const result: AnalysisResult = {
      matchId: body.matchId,
      homeTeam: body.homeTeam,
      awayTeam: body.awayTeam,
      league: body.league,
      matchTime: body.matchTime,
      analyzedAt,
      indicators,
      newsSummary,
      llmPrediction,
      priorityRules: { matched: matchedRules, topPriority },
      crown_handicap: crown?.asianLineInit || "",
      yinghe_handicap: yinghe?.asianLineInit || "",
      who_open_later: whoOpenLater,
      strategy: llmPrediction.strategy,
      prediction: llmPrediction.prediction,
      water_direction: llmPrediction.waterDirection,
      accuracy: llmPrediction.accuracy,
      confidence_level: finalConfidenceLevel,
      action: llmPrediction.action,
      total_prediction: llmPrediction.totalPrediction,
      total_trend: llmPrediction.totalTrend,
      total_action: llmPrediction.totalAction,
      probability,
    };

    // Step 4: Save prediction to DB
    try {
      const supabase = getSupabaseClient();
      const matchDate = body.matchDate || (() => {
        const today = new Date();
        return `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
      })();
      const source = body.source === "backtest" ? "backtest" : "production";
      const predictionTable = source === "backtest" ? "prediction_results_backtest" : "prediction_results";
      const { data: previousPrediction } = await supabase.from(predictionTable)
        .select("prediction_revision")
        .eq("match_id", body.matchId)
        .eq("match_date", matchDate)
        .maybeSingle();
      const predictionRevision = Number(previousPrediction?.prediction_revision || 0) + 1;
      const settlementBasis = body.scheduleMode === "future" ? "analysis_crown_live" : "analysis_crown_12";
      const handicapSettlement = body.scheduleMode === "future" ? body.crownLiveHandicap : body.crown12Handicap;
      const totalSettlement = body.scheduleMode === "future" ? body.crownLiveTotal : body.crown12Total;

      const indicatorSignals: Record<string, string> = {};
      for (const ind of indicators) {
        const key = ind.name === "盘口变化方向" ? "indicator_handicap_direction"
          : ind.name === "水位变化方向" ? "indicator_water_direction"
          : ind.name === "公司分歧度" ? "indicator_divergence"
          : ind.name === "欧亚偏差" ? "indicator_euro_asian"
          : ind.name === "开盘时间早晚" ? "indicator_open_time"
          : ind.name === "大小球趋势" ? "indicator_total_goals"
          : "";
        if (key) indicatorSignals[key] = ind.signal;
      }

      const predictionPayload = {
        match_id: body.matchId,
        match_date: matchDate,
        source,
        run_id: body.runId || null,
        home_team: body.homeTeam,
        away_team: body.awayTeam,
        league: body.league,
        match_time: body.matchTime,
        analyzed_at: analyzedAt,
        water_direction: llmPrediction.waterDirection,
        handicap_trend: llmPrediction.handicapTrend,
        prediction: llmPrediction.prediction,
        total_trend: llmPrediction.totalTrend,
        total_prediction: llmPrediction.totalPrediction,
        confidence_level: finalConfidenceLevel,
        accuracy: llmPrediction.accuracy,
        strategy: llmPrediction.strategy,
        action: llmPrediction.action,
        total_action: llmPrediction.totalAction,
        indicator_handicap_direction: indicatorSignals.indicator_handicap_direction || null,
        indicator_water_direction: indicatorSignals.indicator_water_direction || null,
        indicator_divergence: indicatorSignals.indicator_divergence || null,
        indicator_euro_asian: indicatorSignals.indicator_euro_asian || null,
        indicator_open_time: indicatorSignals.indicator_open_time || null,
        indicator_total_goals: indicatorSignals.indicator_total_goals || null,
        up_score: homeWaterScore,
        down_score: awayWaterScore,
        crown_handicap: crown?.asianLineInit || null,
        yinghe_handicap: yinghe?.asianLineInit || null,
        who_open_later: whoOpenLater,
        indicators_json: indicators,
        news_summary: newsSummary,
        llm_reasoning: llmPrediction.reasoning,
        priority_rules_json: { matched: matchedRules, topPriority },
        strategy_version: activeStrategy?.strategyVersion || null,
        weights_version: activeStrategy?.weightsVersion || "default-v1",
        model_version: activeStrategy?.modelVersion || "analysis-v1",
        weights_snapshot: learnedWeights,
        probability_output: probability,
        probability_model_version: probability.modelVersion || null,
        probability_calibration_version: probability.calibrationVersion,
        probability_source_observed_at: probability.sourceObservedAt,
        probability_quality_status: probability.quality,
        prediction_revision: predictionRevision,
        handicap_settlement_line: handicapSettlement?.line ? handicapLineToNumber(handicapSettlement.line) : null,
        handicap_selection: llmPrediction.prediction,
        handicap_settlement_basis: handicapSettlement?.line ? settlementBasis : null,
        handicap_snapshot_id: null,
        total_settlement_line: totalSettlement?.line ? parseNumber(totalSettlement.line) : null,
        total_selection: llmPrediction.totalPrediction,
        total_settlement_basis: totalSettlement?.line ? settlementBasis : null,
        total_snapshot_id: null,
        actual_score_margin: null,
        actual_total_goals: null,
        handicap_auto_outcome: null,
        handicap_auto_is_correct: null,
        handicap_manual_is_correct: null,
        handicap_effective_is_correct: null,
        handicap_automatic_status: "pending",
        handicap_effective_status: "unverified",
        handicap_settlement_reason: null,
        handicap_auto_verified_at: null,
        handicap_manual_verified_at: null,
        handicap_final_verified_at: null,
        handicap_verified_by: null,
        total_auto_outcome: null,
        total_auto_is_correct: null,
        total_manual_is_correct: null,
        total_effective_is_correct: null,
        total_automatic_status: "pending",
        total_effective_status: "unverified",
        total_settlement_reason: null,
        total_auto_verified_at: null,
        total_manual_verified_at: null,
        total_final_verified_at: null,
        total_verified_by: null,
        // Reset legacy handicap verification mirrors when re-analyzing
        is_correct: null,
        auto_is_correct: null,
        manual_is_correct: null,
        verification_status: "pending",
        water_verification_status: "pending",
        total_verification_status: "pending",
        actual_handicap_trend: null,
        actual_water_direction: null,
        verified_at: null,
      };

      const { error: saveError } = await supabase.from(predictionTable).upsert(predictionPayload, { onConflict: "match_id,match_date" });

      if (saveError) {
        console.error("[Analysis] Save prediction error:", saveError.message);
        return NextResponse.json({ success: false, error: `分析完成但保存预测失败: ${saveError.message}` }, { status: 500 });
      }

      const { data: matchResult } = await supabase.from("match_results")
        .select("home_score,away_score,status")
        .eq("match_id", body.matchId)
        .eq("match_date", matchDate)
        .maybeSingle();
      if (matchResult?.status === "finished") {
        const now = new Date().toISOString();
        const settledRow = { ...predictionPayload };
        const settlementUpdate = {
          actual_score_margin: Number(matchResult.home_score) - Number(matchResult.away_score),
          actual_total_goals: Number(matchResult.home_score) + Number(matchResult.away_score),
          ...settleMarket(settledRow, "handicap", matchResult, undefined, now),
          ...settleMarket(settledRow, "total", matchResult, undefined, now),
        };
        const { data: settledRows, error: settleError } = await supabase.from(predictionTable)
          .update(settlementUpdate)
          .eq("match_id", body.matchId)
          .eq("match_date", matchDate)
          .select("*");
        if (settleError) {
          console.error("[Analysis] Immediate settlement error:", settleError.message);
        } else {
          const settled = settledRows?.[0] ? { ...settledRow, ...settledRows[0] } : { ...settledRow, ...settlementUpdate };
          result.verification = serializeVerification(settled);
          result.settlementEvidence = {
            actualScoreMargin: settled.actual_score_margin,
            actualTotalGoals: settled.actual_total_goals,
          };
        }
      }

      if (source === "production") {
        try {
          await upsertMatchT30Task(new SupabaseAutomationRepository(), {
            matchId: body.matchId,
            matchDate,
            matchTime: body.matchTime,
            homeTeam: body.homeTeam,
            awayTeam: body.awayTeam,
            league: body.league,
            scheduleMode: body.scheduleMode,
          });
        } catch (taskError) {
          console.error("[Analysis] T-30 task enqueue failed:", {
            matchId: body.matchId,
            matchDate,
            error: taskError instanceof Error ? taskError.message : String(taskError),
          });
        }
      }
    } catch (saveErr) {
      const msg = saveErr instanceof Error ? saveErr.message : "保存预测失败";
      console.error("[Analysis] Save prediction exception:", msg);
      return NextResponse.json({ success: false, error: `分析完成但保存预测失败: ${msg}` }, { status: 500 });
    }

    // Send Feishu notification (non-blocking)
    sendFeishuAIAnalysis({
      homeTeam: result.homeTeam,
      awayTeam: result.awayTeam,
      league: result.league,
      matchTime: result.matchTime,
      waterDirection: result.water_direction,
      prediction: result.prediction,
      confidenceLevel: result.llmPrediction?.confidenceLevel || "低",
      strategy: result.llmPrediction?.strategy || "",
      reasoning: result.llmPrediction?.reasoning || "",
    }).catch(() => {/* Don't block */});

    return NextResponse.json({ success: true, data: result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "分析失败";
    console.error("[Analysis] Error:", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

// GET: Load existing predictions for a date
export async function GET(req: NextRequest) {
  try {
    const date = req.nextUrl.searchParams.get("date");
    if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });

    const detail = req.nextUrl.searchParams.get("detail");
    const matchId = req.nextUrl.searchParams.get("matchId");

    const supabase = getSupabaseClient();

    // Detail mode: return full data for a single match
    if (detail === "1" && matchId) {
      const { data, error } = await supabase
        .from("prediction_results")
        .select("*,analyzed_at")
        .eq("match_date", date)
        .eq("match_id", matchId)
        .single();

      if (error || !data) return NextResponse.json({ success: true, prediction: null });

      const p = data;
      return NextResponse.json({
        success: true,
        prediction: {
          matchId: p.match_id,
          homeTeam: p.home_team,
          awayTeam: p.away_team,
          league: p.league,
          matchTime: p.match_time,
          analyzedAt: p.analyzed_at,
          indicators: parseDbJsonArray<AnalysisResultData["indicators"][number]>(p.indicators_json),
          newsSummary: p.news_summary || "",
          handicapTrend: p.handicap_trend || "不确定",
          waterDirection: p.water_direction || "不变",
          prediction: p.prediction || "中立",
          totalTrend: p.total_trend || "不变",
          totalPrediction: p.total_prediction || "中立",
          totalAction: p.total_action || "",
          confidenceLevel: p.confidence_level || "低",
          accuracy: p.accuracy || "50%",
          strategy: p.strategy || "",
          action: p.action || "",
          reasoning: p.llm_reasoning || "",
          crown_handicap: p.crown_handicap || "",
          yinghe_handicap: p.yinghe_handicap || "",
          who_open_later: p.who_open_later || "",
          isCorrect: p.is_correct,
          manualIsCorrect: p.manual_is_correct,
          verification: serializeVerification(p),
          settlementEvidence: {
            handicap: { line: p.handicap_settlement_line, selection: p.handicap_selection, basis: p.handicap_settlement_basis, snapshotId: p.handicap_snapshot_id },
            total: { line: p.total_settlement_line, selection: p.total_selection, basis: p.total_settlement_basis, snapshotId: p.total_snapshot_id },
            actualScoreMargin: p.actual_score_margin,
            actualTotalGoals: p.actual_total_goals,
          },
          probability: parseDbJsonObject<AnalysisProbabilityOutput>(p.probability_output),
          matchDate: p.match_date || date,
        },
      });
    }

    // List mode: return light-weight fields only
    const { data, error } = await supabase
      .from("prediction_results")
        .select("*,analyzed_at")
      .eq("match_date", date);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const predictions: Record<string, AnalysisResultData> = {};
    for (const row of data || []) {
      predictions[row.match_id] = {
        matchId: row.match_id,
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        league: row.league,
        matchTime: row.match_time,
        matchDate: row.match_date || date,
        analyzedAt: row.analyzed_at,
        indicators: [],
        newsSummary: "",
        waterDirection: row.water_direction || "不变",
        handicapTrend: row.handicap_trend || "不确定",
        prediction: row.prediction || "中立",
        totalTrend: row.total_trend || "不变",
        totalPrediction: row.total_prediction || "中立",
        totalAction: row.total_action || "",
        confidenceLevel: row.confidence_level || "低",
        accuracy: row.accuracy || "50%",
        strategy: row.strategy || "",
        action: row.action || "",
        reasoning: "",
        crown_handicap: row.crown_handicap || "",
        yinghe_handicap: row.yinghe_handicap || "",
        who_open_later: row.who_open_later || "",
        isCorrect: row.is_correct,
        manualIsCorrect: row.manual_is_correct,
        verification: serializeVerification(row),
        settlementEvidence: {
          handicap: { line: row.handicap_settlement_line, selection: row.handicap_selection, basis: row.handicap_settlement_basis, snapshotId: row.handicap_snapshot_id },
          total: { line: row.total_settlement_line, selection: row.total_selection, basis: row.total_settlement_basis, snapshotId: row.total_snapshot_id },
          actualScoreMargin: row.actual_score_margin,
          actualTotalGoals: row.actual_total_goals,
        },
        probability: parseDbJsonObject<AnalysisProbabilityOutput>(row.probability_output),
      };
    }
    return NextResponse.json({ success: true, predictions });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "加载失败";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
