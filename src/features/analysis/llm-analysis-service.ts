import type { AnalysisRequest, RuleIndicator } from "./contracts";
import { buildPriorityContext } from "./priority-rules";
import { normalizeOpenTime } from "./indicator-rules";

export interface LlmPrediction {
  waterDirection: string;
  handicapTrend: string;
  prediction: string;
  totalTrend: string;
  totalPrediction: string;
  confidenceLevel: string;
  accuracy: string;
  strategy: string;
  action: string;
  totalAction: string;
  reasoning: string;
}

export interface LlmAnalysisInput {
  request: AnalysisRequest;
  indicators: RuleIndicator[];
  newsSummary: string;
  learnedContext: string;
  probabilityContext: string;
}

export type LlmInvoke = (
  messages: Array<{ role: "system" | "user"; content: string }>,
  options: { temperature: number },
) => Promise<{ content: string }>;

function fallback(request: AnalysisRequest, indicators: RuleIndicator[], strategy: string): LlmPrediction {
  const crown = request.companies.find(company => company.companyId === "3");
  let home = 0;
  let away = 0;
  for (const indicator of indicators) {
    if (indicator.signal === "主降水") home += indicator.weight;
    if (indicator.signal === "客降水") away += indicator.weight;
  }
  const prediction = home > away ? "主" : away > home ? "客" : "中立";
  return {
    waterDirection: prediction === "主" ? "主降水" : prediction === "客" ? "客降水" : "不变",
    handicapTrend: prediction === "主" ? "升盘" : prediction === "客" ? "降盘" : "不变",
    prediction,
    totalTrend: "不变",
    totalPrediction: "中立",
    confidenceLevel: "低",
    accuracy: "50%",
    strategy,
    action: `${crown?.asianLineInit || "未知"} ${crown?.asianHomeInit || "?"}/${crown?.asianAwayInit || "?"} ${prediction}`,
    totalAction: `${crown?.totalLineInit || "未知"} 中立`,
    reasoning: `规则引擎: 主降水${(home * 100).toFixed(0)}% 客降水${(away * 100).toFixed(0)}%`,
  };
}

export function createLlmAnalyzer(invoke: LlmInvoke, logError: (message: string) => void = console.error) {
  return async ({ request, indicators, newsSummary, learnedContext, probabilityContext }: LlmAnalysisInput): Promise<LlmPrediction> => {
    const crown = request.companies.find(company => company.companyId === "3");
    const yinghe = request.companies.find(company => company.companyId === "35");
    let whoOpenLater = "未知";
    if (crown?.openTime && yinghe?.openTime) {
      const crownTime = normalizeOpenTime(crown.openTime);
      const yingheTime = normalizeOpenTime(yinghe.openTime);
      whoOpenLater = crownTime > yingheTime ? "盈禾先开" : yingheTime > crownTime ? "皇冠先开" : "同时开盘";
    }
    let home = 0;
    let away = 0;
    for (const indicator of indicators) {
      if (indicator.signal === "主降水") home += indicator.weight;
      if (indicator.signal === "客降水") away += indicator.weight;
    }
    const refLabel = request.scheduleMode === "future" ? "皇冠即时数据" : "皇冠新数据(开盘赔率)";
    const refHandicap = request.scheduleMode === "future" ? request.crownLiveHandicap : request.crown12Handicap;
    const refTotal = request.scheduleMode === "future" ? request.crownLiveTotal : request.crown12Total;
    const priorityContext = buildPriorityContext(indicators);
    const systemPrompt = `你是一位专业的足球赔率分析师。你的核心任务是：**预测亚盘水位哪一边会下降（降水）**。\n\n## 核心预测目标\n- **主降水**：主队水位下降 → 资金流入主队 → 市场看好主队\n- **客降水**：客队水位下降 → 资金流入客队 → 市场看好客队\n- **不变**：水位无明显变化趋势\n\n## 分析规则\n1. **降水方向是唯一核心判断目标**。水位下降=该方被市场看好=资金流入=该方值得投注\n2. 水位变化是最直接的信号，盘口变化是辅助信号\n3. 分析基于公司初盘赔率和${refLabel}\n4. 综合考虑规则指标(权重60%)和新闻情报(权重40%)\n5. 置信度分三级：高(>75%)、中(60-75%)、低(<60%)\n\n## 优先级规则体系\n${priorityContext ? `当前赛事匹配的优先级规则：\n${priorityContext}\n` : "暂无匹配的优先级规则，请根据指标信号和新闻综合判断。"}\n${learnedContext ? `## 历史学习经验\n${learnedContext}\n` : ""}${probabilityContext ? "## 概率约束\n服务端概率、五档赛果与EV为只读计算结果。你只能解释，不得生成、修改或在JSON中返回任何概率、EV或模型字段。\n" : ""}## 输出格式（严格JSON，不要markdown代码块）\n{\n  "waterDirection": "主降水/客降水/不变",\n  "prediction": "主/客/中立",\n  "totalTrend": "大球降水/小球降水/不变",\n  "totalPrediction": "大/小/中立",\n  "confidenceLevel": "高/中/低",\n  "accuracy": "XX%",\n  "strategy": "一句话策略说明",\n  "action": "盘口值 低水方 方向",\n  "totalAction": "大小球盘口 大/小",\n  "reasoning": "详细推理过程(100字以内)"\n}`;
    const indicatorText = indicators.map(item => `${item.name}: ${item.value} → 信号: ${item.signal} (权重${(item.weight * 100).toFixed(0)}%) — ${item.reasoning}`).join("\n");
    const userPrompt = `## 赛事信息\n联赛: ${request.league}\n时间: ${request.matchTime}\n主队: ${request.homeTeam}\n客队: ${request.awayTeam}\n${refHandicap ? `${refLabel}: ${refHandicap.line} (主${refHandicap.home}/客${refHandicap.away})` : ""}\n${refTotal ? `${refLabel}大小球: ${refTotal.line} (大${refTotal.over}/小${refTotal.under})` : ""}\n\n## 规则指标分析（加权得分: 主降水${(home * 100).toFixed(0)}% / 客降水${(away * 100).toFixed(0)}%）\n${indicatorText}\n\n## 服务端只读概率结果\n${probabilityContext || "概率不可用；不得自行补齐或假设50%"}\n\n## 新闻情报\n${newsSummary}\n\n## 各公司赔率明细\n${request.companies.map(company => `${company.companyName}(${company.openTime || "无开盘时间"}): 亚盘初${company.asianLineInit}(${company.asianHomeInit}/${company.asianAwayInit}) 亚盘即时${company.asianLineLive}(${company.asianHomeLive}/${company.asianAwayLive}) 欧转亚初${company.euroAsianLineInit} 大小球初${company.totalLineInit}(${company.totalOverInit}/${company.totalUnderInit})`).join("\n")}\n\n谁先开盘: ${whoOpenLater}\n皇冠初盘: ${crown?.asianLineInit || "未知"}\n盈禾初盘: ${yinghe?.asianLineInit || "未知"}`;
    try {
      const response = await invoke([{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], { temperature: 0.3 });
      const content = response.content.trim();
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const parsed = JSON.parse((match?.[1] || content).trim()) as Record<string, unknown>;
      const waterDirection = String(parsed.waterDirection || "不变");
      const prediction = waterDirection === "主降水" ? "主" : waterDirection === "客降水" ? "客" : "中立";
      return {
        waterDirection,
        handicapTrend: waterDirection === "主降水" ? "升盘" : waterDirection === "客降水" ? "降盘" : "不变",
        prediction,
        totalTrend: String(parsed.totalTrend || "不变"),
        totalPrediction: String(parsed.totalPrediction || "中立"),
        confidenceLevel: String(parsed.confidenceLevel || "低"),
        accuracy: String(parsed.accuracy || "50%"),
        strategy: String(parsed.strategy || ""), action: String(parsed.action || ""),
        totalAction: String(parsed.totalAction || ""), reasoning: String(parsed.reasoning || ""),
      };
    } catch (error) {
      if (error instanceof SyntaxError) return fallback(request, indicators, "LLM返回格式异常，使用规则引擎兜底");
      const message = error instanceof Error ? error.message : "LLM调用失败";
      logError(`[Analysis] LLM error: ${message}`);
      return fallback(request, indicators, `LLM调用失败(${message.slice(0, 30)})，规则引擎兜底`);
    }
  };
}
