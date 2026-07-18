import { DEFAULT_INDICATOR_WEIGHTS, type IndicatorWeights } from "@/lib/analysis/strategy";
import type { AnalysisRequest, CompanyOddsForAnalysis, RuleIndicator, WaterSignal } from "./contracts";

export function parseNumber(s: string | undefined | null): number {
  if (!s) return NaN;
  const cleaned = s.replace(/[*受让球手半]/g, "").replace("一", "1").replace("两", "2").replace("三", "3").replace("四", "4").replace("五", "5");
  const n = parseFloat(cleaned);
  return n;
}

// Convert Chinese handicap line to numeric value
export function handicapLineToNumber(line: string): number {
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

export function computeRuleIndicators(req: AnalysisRequest, weights: IndicatorWeights = DEFAULT_INDICATOR_WEIGHTS): RuleIndicator[] {
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
export function normalizeOpenTime(time: string): string {
  return time.replace(/(\d{1,2})-(\d{1,2})\s/, (_, m, d) => `${m.padStart(2, "0")}-${d.padStart(2, "0")} `);
}
