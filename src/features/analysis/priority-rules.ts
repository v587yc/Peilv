import type { IndicatorKey, PriorityRule, RuleIndicator, RuleMatch, WaterSignal } from "./contracts";

const INDICATOR_KEY_MAP: Record<string, IndicatorKey> = {
  "盘口变化方向": "handicap",
  "水位变化方向": "water",
  "公司分歧度": "divergence",
  "欧亚偏差": "euroAsian",
  "开盘时间早晚": "openTime",
  "大小球趋势": "totalGoals",
};

// 优先级规则已清空（基于旧升盘/降盘信号的规则不再适用）
export const MIN_LEARNED_PATTERN_SAMPLES_FOR_AI = 20;

// 新规则将由 learn API 基于水位方向验证数据自动生成
const PRIORITY_RULES: PriorityRule[] = [];

export function matchPriorityRules(indicators: RuleIndicator[]): RuleMatch[] {
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

export function buildPriorityContext(indicators: RuleIndicator[]): string {
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

