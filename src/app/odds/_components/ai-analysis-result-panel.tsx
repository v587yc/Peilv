"use client";

import { useState } from "react";
import {
  Activity,
  Check,
  ChevronDown,
  Clock3,
  Loader2,
  MessageSquare,
  Send,
  ShieldCheck,
  Target,
  Undo2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AnalysisProbabilityOutput, EvRecommendation, OutcomeProbabilities } from "@/lib/probability";
import type { PredictionMarket } from "@/lib/verification";
import type { MarketVerification } from "@/lib/verification/market-service";

type AnalysisIndicator = {
  name: string;
  value: string;
  signal: string;
  weight: number;
  reasoning: string;
};

type AnalysisViewData = {
  prediction: string;
  waterDirection: string;
  totalPrediction: string;
  totalTrend: string;
  totalAction: string;
  confidenceLevel: string;
  accuracy: string;
  strategy: string;
  action: string;
  indicators: AnalysisIndicator[];
  newsSummary: string;
  reasoning: string;
  analyzedAt?: string | null;
  manualIsCorrect?: boolean | null;
  verification?: {
    handicap: MarketVerification;
    total: MarketVerification;
  };
  probability?: AnalysisProbabilityOutput | null;
};

type PurchaseAdvice = {
  handicap: string;
  total: string;
};

type LearningPattern = {
  key: string;
  description: string;
  hitRate: string;
  total: number;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type AIAnalysisResultPanelProps = {
  panelId: string;
  analysis: AnalysisViewData;
  analyzedAtLabel: string;
  purchaseAdvice?: PurchaseAdvice;
  patterns?: LearningPattern[];
  messages: ChatMessage[];
  isDetailExpanded: boolean;
  isChatOpen: boolean;
  chatInput: string;
  chatStreaming: boolean;
  showVerification?: boolean;
  verifyingMarket?: PredictionMarket | null;
  onToggleDetail: () => void;
  onToggleChat: () => void;
  onChatInputChange: (value: string) => void;
  onSendChat: () => void;
  onVerify?: (market: PredictionMarket, isCorrect: boolean | null) => void;
};

function directionTone(value: string): string {
  if (/主|大|升/.test(value)) return "ai-analysis-panel--home";
  if (/客|小|降/.test(value)) return "ai-analysis-panel--away";
  return "ai-analysis-panel--neutral";
}

const OUTCOME_LABELS: Array<[keyof OutcomeProbabilities, string]> = [
  ["win", "赢盘"],
  ["half_win", "赢半"],
  ["push", "走盘"],
  ["half_loss", "输半"],
  ["loss", "输盘"],
];

function qualityLabel(quality: AnalysisProbabilityOutput["quality"]): string {
  if (quality === "available") return "已校准概率";
  if (quality === "uncalibrated") return "市场隐含估计 · 未校准";
  if (quality === "invalid_odds") return "赔率无效";
  if (quality === "insufficient_data") return "数据不足";
  return "概率不可用";
}

function selectionLabel(selection: string): string {
  if (selection === "home") return "主";
  if (selection === "away") return "客";
  if (selection === "over") return "大";
  if (selection === "under") return "小";
  return selection;
}

function splitLineLabel(market: PredictionMarket, line: number, selection: string): string | null {
  const quarterUnits = Math.round(line * 4);
  if (Math.abs(line * 4 - quarterUnits) > 1e-7 || Math.abs(quarterUnits) % 2 === 0) return null;
  const lower = Math.floor(quarterUnits / 2) / 2;
  const upper = Math.ceil(quarterUnits / 2) / 2;
  const side = selectionLabel(selection);
  return `${market === "handicap" ? `${side}方` : side} ${line} = ${lower} / ${upper} 各半`;
}

function ProbabilityStrip({
  market,
  probability,
}: {
  market: PredictionMarket;
  probability?: AnalysisProbabilityOutput | null;
}) {
  if (!probability) return <p className="ai-analysis-panel__probability-empty">暂无可信概率</p>;
  const result = probability.markets[market];
  if (!result) {
    return (
      <p className="ai-analysis-panel__probability-empty" title={probability.reason || undefined}>
        {qualityLabel(probability.quality)}
      </p>
    );
  }
  const isQuarter = Math.abs(Math.round(result.line * 4)) % 2 === 1;
  const outcomes = OUTCOME_LABELS.filter(([key]) => isQuarter || result.probabilities[key] > 1e-8);
  const split = splitLineLabel(market, result.line, result.selection);
  return (
    <div className="ai-analysis-panel__probability">
      <div className="ai-analysis-panel__probability-head">
        <span>{qualityLabel(probability.quality)}</span>
        <strong>{selectionLabel(result.selection)} {result.line}</strong>
      </div>
      {split && <small>{split}</small>}
      <div className="ai-analysis-panel__probability-grid">
        {outcomes.map(([key, label]) => (
          <span key={key}>
            {label}
            <strong>{(result.probabilities[key] * 100).toFixed(1)}%</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function recommendationText(recommendation: EvRecommendation): string {
  const candidate = recommendation.recommended;
  if (!candidate) return "当前真实盘口无正期望建议";
  return `${selectionLabel(candidate.selection)} ${candidate.line} · EV ${(candidate.expectedValue * 100).toFixed(1)}%${candidate.provisional ? "（未校准）" : ""}`;
}

function VerificationControl({
  market,
  verification,
  legacyManual,
  loading,
  onVerify,
}: {
  market: PredictionMarket;
  verification?: MarketVerification;
  legacyManual?: boolean | null;
  loading: boolean;
  onVerify: (market: PredictionMarket, isCorrect: boolean | null) => void;
}) {
  const manual = verification?.manualIsCorrect ?? (market === "handicap" ? legacyManual : null);
  const outcomeLabels: Record<string, string> = {
    win: "赢盘",
    half_win: "赢半",
    push: "走盘",
    half_loss: "输半",
    loss: "输盘",
    pending: "待赛果",
    invalid: "无效",
    void: "作废",
    legacy_unknown: "历史证据不足",
  };
  const automatic = verification ? outcomeLabels[verification.autoOutcome] || verification.effectiveStatus : "尚未自动结算";
  return (
    <div className="ai-analysis-panel__market-verification" aria-live="polite">
      <div>
        <span>{market === "handicap" ? "让球验证" : "进球验证"}</span>
        <strong className={cn(manual === true && "text-emerald-300", manual === false && "text-red-300")}>
          {manual === true ? "人工：正确" : manual === false ? "人工：错误" : `自动：${automatic}`}
        </strong>
      </div>
      {manual === null || manual === undefined ? (
        <div>
          <button type="button" className="ai-analysis-panel__verify-positive" disabled={loading} onClick={() => onVerify(market, true)}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            正确
          </button>
          <button type="button" className="ai-analysis-panel__verify-negative" disabled={loading} onClick={() => onVerify(market, false)}>
            <X className="size-4" />
            错误
          </button>
        </div>
      ) : (
        <button type="button" disabled={loading} onClick={() => onVerify(market, null)}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Undo2 className="size-4" />}
          撤回
        </button>
      )}
    </div>
  );
}

export function AIAnalysisResultPanel({
  panelId,
  analysis,
  analyzedAtLabel,
  purchaseAdvice,
  patterns = [],
  messages,
  isDetailExpanded,
  isChatOpen,
  chatInput,
  chatStreaming,
  showVerification = false,
  verifyingMarket = null,
  onToggleDetail,
  onToggleChat,
  onChatInputChange,
  onSendChat,
  onVerify,
}: AIAnalysisResultPanelProps) {
  const detailId = `${panelId}-details`;
  const chatId = `${panelId}-chat`;
  const [showIndicatorDetails, setShowIndicatorDetails] = useState(false);
  const sortedIndicators = analysis.indicators
    .slice()
    .sort((a, b) => b.weight - a.weight);
  const primaryIndicators = sortedIndicators.slice(0, 3);
  const handicapAdvice = purchaseAdvice?.handicap || analysis.action || "暂无明确建议";
  const totalAdvice = purchaseAdvice?.total || analysis.totalAction || "暂无明确建议";
  const hasNews = analysis.newsSummary && analysis.newsSummary !== "未搜到相关新闻" && analysis.newsSummary !== "新闻搜索失败";

  return (
    <section className="ai-analysis-panel" aria-label="AI 分析结果">
      <div className="ai-analysis-panel__toolbar">
        <div className="ai-analysis-panel__eyebrow">
          <Activity className="size-3.5" />
          AI 决策摘要
        </div>
        <div className="ai-analysis-panel__meta-strip">
          <span>置信 <strong>{analysis.confidenceLevel || "未评估"}</strong></span>
          <span>模型自评 <strong>{analysis.accuracy || "--"}</strong></span>
          {analysis.probability && <span>概率 <strong>{qualityLabel(analysis.probability.quality)}</strong></span>}
          <span><Clock3 className="size-3.5" /> {analyzedAtLabel}</span>
        </div>
        <div className="ai-analysis-panel__actions">
          <button
            type="button"
            aria-expanded={showIndicatorDetails}
            aria-controls={detailId}
            onClick={() => {
              if (!showIndicatorDetails && !isDetailExpanded) onToggleDetail();
              setShowIndicatorDetails(current => !current);
            }}
          >
            <ChevronDown className={cn("size-4 transition-transform", showIndicatorDetails && "rotate-180")} />
            {showIndicatorDetails ? "收起指标" : "更多指标"}
          </button>
          <button type="button" aria-expanded={isChatOpen} aria-controls={chatId} onClick={onToggleChat}>
            <MessageSquare className="size-4" />
            {isChatOpen ? "收起对话" : "追问 AI"}
          </button>
        </div>
      </div>

      <div className="ai-analysis-panel__decision-grid">
        <article className="ai-analysis-panel__decision-card">
          <Target className="size-4 text-primary" />
          <div className="ai-analysis-panel__decision-content">
            <div className="ai-analysis-panel__decision-fields">
              <div>
                <span>让球结论</span>
                <strong className={directionTone(analysis.prediction)}>{analysis.prediction || "观望"}</strong>
              </div>
              <div>
                <span>水位方向</span>
                <strong className={directionTone(analysis.waterDirection)}>{analysis.waterDirection || "不明"}</strong>
              </div>
            </div>
            <div className="ai-analysis-panel__decision-advice">
              <span>让球建议</span>
              <strong>{handicapAdvice}</strong>
            </div>
          </div>
          <ProbabilityStrip market="handicap" probability={analysis.probability} />
          {analysis.probability && (
            <p className="ai-analysis-panel__recommendation">{recommendationText(analysis.probability.recommendations.handicap)}</p>
          )}
          {showVerification && onVerify && (
            <VerificationControl
              market="handicap"
              verification={analysis.verification?.handicap}
              legacyManual={analysis.manualIsCorrect}
              loading={verifyingMarket === "handicap"}
              onVerify={onVerify}
            />
          )}
        </article>

        <article className="ai-analysis-panel__decision-card">
          <ShieldCheck className="size-4 text-amber-300" />
          <div className="ai-analysis-panel__decision-content">
            <div className="ai-analysis-panel__decision-fields">
              <div>
                <span>进球结论</span>
                <strong className={directionTone(analysis.totalPrediction)}>
                  {analysis.totalPrediction && analysis.totalPrediction !== "中立" ? `${analysis.totalPrediction}球` : "观望"}
                </strong>
              </div>
              <div>
                <span>盘口趋势</span>
                <strong className={directionTone(analysis.totalTrend)}>{analysis.totalTrend || "不明"}</strong>
              </div>
            </div>
            <div className="ai-analysis-panel__decision-advice">
              <span>进球建议</span>
              <strong>{totalAdvice}</strong>
            </div>
          </div>
          <ProbabilityStrip market="total" probability={analysis.probability} />
          {analysis.probability && (
            <p className="ai-analysis-panel__recommendation">{recommendationText(analysis.probability.recommendations.total)}</p>
          )}
          {showVerification && onVerify && (
            <VerificationControl
              market="total"
              verification={analysis.verification?.total}
              loading={verifyingMarket === "total"}
              onVerify={onVerify}
            />
          )}
        </article>
      </div>

      <div className="ai-analysis-panel__strategy">
        <div>
          <span>策略判断</span>
          <strong>{analysis.strategy || "暂无策略摘要"}</strong>
        </div>
        <p>{analysis.action || handicapAdvice}</p>
      </div>

      {primaryIndicators.length > 0 && (
        <div className="ai-analysis-panel__evidence" aria-label="核心依据">
          {primaryIndicators.map((indicator) => (
            <div key={`${indicator.name}-${indicator.signal}`} className="ai-analysis-panel__evidence-item">
              <span>{indicator.name}</span>
              <strong className={directionTone(indicator.signal)}>{indicator.signal || "中立"}</strong>
              {indicator.value && <small>{indicator.value}</small>}
            </div>
          ))}
        </div>
      )}

      {analysis.reasoning && (
        <div className="ai-analysis-panel__insights">
          <div>
            <h4>分析摘要</h4>
            <p>{analysis.reasoning}</p>
          </div>
        </div>
      )}

      {showIndicatorDetails && (
        <div id={detailId} className="ai-analysis-panel__details">
          {analysis.indicators.length > 0 && (
            <div>
              <h4>全部分析指标</h4>
              <div className="ai-analysis-panel__indicator-list">
                {analysis.indicators.map((indicator) => (
                  <div key={`${indicator.name}-${indicator.signal}-${indicator.weight}`}>
                    <span>{indicator.name}</span>
                    <strong className={directionTone(indicator.signal)}>{indicator.signal || indicator.value || "中立"}</strong>
                    <small>权重 {indicator.weight}</small>
                    {indicator.reasoning && <p>{indicator.reasoning}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {analysis.reasoning && (
            <div>
              <h4>完整推理</h4>
              <p>{analysis.reasoning}</p>
            </div>
          )}
          {hasNews && (
            <div>
              <h4>新闻与外部信息</h4>
              <p>{analysis.newsSummary}</p>
            </div>
          )}
          {patterns.length > 0 && (
            <div>
              <h4>历史学习经验</h4>
              <div className="ai-analysis-panel__patterns">
                {patterns.slice(0, 5).map((pattern) => (
                  <span key={pattern.key}>
                    {pattern.description}
                    <strong>{pattern.hitRate}</strong>
                    <small>{pattern.total} 场</small>
                  </span>
                ))}
              </div>
            </div>
          )}
          {analysis.probability && (
            <div>
              <h4>概率模型与真实盘口候选</h4>
              <div className="ai-analysis-panel__probability-detail">
                <span>质量 <strong>{qualityLabel(analysis.probability.quality)}</strong></span>
                <span>模型 <strong>{analysis.probability.modelVersion || "未生成"}</strong></span>
                <span>公司 <strong>{analysis.probability.companyCount}</strong></span>
                <span>数据时间 <strong>{analysis.probability.sourceObservedAt || "未记录"}</strong></span>
                {analysis.probability.model && (
                  <span>预期进球 <strong>{analysis.probability.model.lambdaHome.toFixed(2)} / {analysis.probability.model.lambdaAway.toFixed(2)}</strong></span>
                )}
              </div>
              <div className="ai-analysis-panel__candidate-list">
                {(["handicap", "total"] as const).map(market => (
                  <div key={market}>
                    <span>{market === "handicap" ? "让球" : "进球"}</span>
                    <strong>{recommendationText(analysis.probability!.recommendations[market])}</strong>
                    <small>
                      {analysis.probability!.recommendations[market].evaluated.map(candidate => (
                        `${selectionLabel(candidate.selection)} ${candidate.line} EV ${(candidate.expectedValue * 100).toFixed(1)}%`
                      )).join(" · ") || "没有可评估的真实报价"}
                    </small>
                  </div>
                ))}
              </div>
            </div>
          )}
          {analysis.indicators.length === 0 && !analysis.reasoning && !hasNews && patterns.length === 0 && !analysis.probability && (
            <p className="ai-analysis-panel__empty">当前结果暂无更多指标明细。</p>
          )}
        </div>
      )}

      {isChatOpen && (
        <div id={chatId} className="ai-analysis-panel__chat">
          <div className="ai-analysis-panel__messages" aria-live="polite">
            {messages.length === 0 && <p className="ai-analysis-panel__empty">还没有对话，可补充信息或质疑本次判断。</p>}
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={cn("ai-analysis-panel__message", message.role === "user" && "ai-analysis-panel__message--user")}>
                <span>{message.role === "user" ? "你" : "AI"}</span>
                <p>{message.content}</p>
              </div>
            ))}
            {chatStreaming && <p className="ai-analysis-panel__empty">AI 正在整理回答…</p>}
          </div>
          <label className="ai-analysis-panel__composer">
            <span className="sr-only">追问 AI</span>
            <input
              type="text"
              value={chatInput}
              placeholder="补充信息、质疑分析或追问细节…"
              disabled={chatStreaming}
              onChange={(event) => onChatInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && chatInput.trim()) {
                  event.preventDefault();
                  onSendChat();
                }
              }}
            />
            <button type="button" disabled={chatStreaming || !chatInput.trim()} onClick={onSendChat}>
              <Send className="size-4" />
              发送
            </button>
          </label>
        </div>
      )}
    </section>
  );
}
