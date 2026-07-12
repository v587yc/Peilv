"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import {
  Pin,
  PinOff,
  RefreshCw,
  Settings,
  Bell,
  BellRing,
  Filter,
  AlertTriangle,
  X,
  Volume2,
  VolumeX,
  StickyNote,
  ClipboardPaste,
  FileBarChart,
  Calendar,
  Zap,
  Link,
  Building2,
  ChevronDown,
  CalendarDays,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import "./odds.css";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { AIAnalysisResultPanel } from "./_components/ai-analysis-result-panel";
import { MatchSituation, MatchStatusBadge, getMatchRowClass } from "./_components/match-status";
import { canApplyDatabaseOdds, mergeAiCompanyOdds } from "@/lib/odds-client-merge";
import type { AnalysisProbabilityOutput } from "@/lib/probability";
import type { SettlementSummary, PredictionMarket } from "@/lib/verification";
import type { MarketVerification } from "@/lib/verification/market-service";
import {
  ODDS_STALE_AFTER_MS,
  canApplyDatabaseObservation,
  enqueueRefreshItem,
  isLatestRefreshResponse,
  isOddsStale,
  type RefreshQueueItem,
  type SourceTimestamp,
} from "@/lib/odds-refresh";

// --- Types ---
interface MatchData {
  id: string;
  league: string;
  leagueColor: string;
  time: string;
  homeTeam: string;
  awayTeam: string;
  homeRank: string;
  awayRank: string;
  state: string;
  handicap: string;
  handicapRaw: number;
  homeOdds: string;
  awayOdds: string;
  totalLine: string;
  totalLineRaw: number;
  overOdds: string;
  underOdds: string;
  initialHandicap: string;
  initialTotalLine: string;
  sclassId: string;
  matchDate: string;
  orderIndex: number;
  isHot?: boolean; // A[i][62] == "1" = hot match
  homeScore?: string; // 全场主队比分
  awayScore?: string; // 全场客队比分
  halfHomeScore?: string; // 半场主队比分
  halfAwayScore?: string; // 半场客队比分
}

interface LeagueData {
  id: string;
  name: string;
  color: string;
  count: number;
  isHot?: boolean; // B[j][10] != "0" = important/hot league from website data
}

interface AlertConfig {
  matchId: string;
  handicapUp: string;
  handicapDown: string;
  totalLineUp: string;
  totalLineDown: string;
  homeOddsUp: string;
  homeOddsDown: string;
  awayOddsUp: string;
  awayOddsDown: string;
  overOddsUp: string;
  overOddsDown: string;
  underOddsUp: string;
  underOddsDown: string;
}

interface AlertItem {
  id: string;
  message: string;
  time: number;
}

interface OddsSnapshot {
  handicapRaw: number;
  totalLineRaw: number;
  homeOdds: string;
  awayOdds: string;
  overOdds: string;
  underOdds: string;
}

interface MatchNotes {
  handicapNote: string;
  totalNote: string;
  handicapAmount?: string;
  totalAmount?: string;
  handicapSettled?: boolean;
  totalSettled?: boolean;
}

interface PinnedMatchInfo {
  id: string;
  league: string;
  leagueColor: string;
  time: string;
  homeTeam: string;
  awayTeam: string;
  handicap: string;
  homeOdds: string;
  awayOdds: string;
  totalLine: string;
  overOdds: string;
  underOdds: string;
}

interface PredictionData {
  match_time: string;
  league: string;
  home: string;
  away: string;
  crown_handicap: string;
  yinghe_handicap: string;
  who_open_later: string;
  strategy: string;
  prediction: string;
  accuracy: string;
  confidence_level: string;
  action: string;
}

interface ReportRowData {
  matchId: string;
  league: string;
  time: string;
  homeTeam: string;
  awayTeam: string;
  state: string;
  homeScore: string;
  awayScore: string;
  // 亚盘
  crownHandicap?: string;
  initHandicap: string;
  liveHandicap: string;
  handicapChange: string;
  isReceiving: boolean;
  result?: "+" | "-" | null;
  handicapResult?: "+" | "-" | null;
  // 水位方向(核心验证)
  waterDirection: string;         // 预测: 主降水/客降水/不变
  actualWaterDirection: string;   // 实际: 主降水/客降水/不变
  waterResult?: "+" | "-" | null;        // + = 错, - = 对
  prediction: string;
  action: string;
  accuracy: string;
  confidence_level: string;
  confidenceLevel?: string;
  // 大小球
  initTotal: string;
  liveTotal: string;
  totalChange: string;
  totalResult?: "+" | "-" | null;
  totalPrediction: string;
  totalAction: string;
  // 验证
  verified: boolean;
  manualIsCorrect?: boolean | null;
  verification?: {
    handicap: MarketVerification;
    total: MarketVerification;
  };
  handicapOutcome?: string;
  totalOutcome?: string;
  waterTolerance?: boolean;
}

interface ParsedCrownHandicap {
  homeOdds: number;
  awayOdds: number;
  handicapValue: number;
}

// --- Company odds types ---
interface CompanyOddsItem {
  companyId: string;       // e.g. "1" = Crown, "3" = Yinghe, "8" = 18bet, "12" = Pingbo
  companyName: string;     // e.g. "皇冠", "盈禾", "18博", "平博"
  openTime: string;        // e.g. "04-13 21:06"
  // Full-time handicap (初盘)
  ftHandicapHome: string;  // e.g. "0.92"
  ftHandicapLine: string;  // e.g. "-0.5"
  ftHandicapAway: string;  // e.g. "0.92"
  // Full-time handicap live (即时)
  ftHandicapHomeLive: string;
  ftHandicapLineLive: string;
  ftHandicapAwayLive: string;
  // Euro odds (初盘)
  euroHome: string;        // e.g. "1.25"
  euroDraw: string;        // e.g. "4.90"
  euroAway: string;        // e.g. "8.80"
  // Euro odds live (即时)
  euroHomeLive: string;
  euroDrawLive: string;
  euroAwayLive: string;
  // Euro-to-Asian handicap (初盘, converted from euro)
  euroAsianHome: string;   // e.g. "1.00"
  euroAsianLine: string;   // e.g. "-0.5"
  euroAsianAway: string;   // e.g. "1.00"
  // Full-time total (初盘)
  ftTotalOver: string;     // e.g. "0.89"
  ftTotalLine: string;     // e.g. "2.75"
  ftTotalUnder: string;    // e.g. "0.83"
  // Full-time total live (即时)
  ftTotalOverLive: string;
  ftTotalLineLive: string;
  ftTotalUnderLive: string;
  // Half-time (reserved for future)
  htHandicapHome?: string;
  htHandicapLine?: string;
  htHandicapAway?: string;
  htTotalOver?: string;
  htTotalLine?: string;
  htTotalUnder?: string;
}

interface CompanyOddsData {
  matchId: string;
  openTime: string;        // Crown's opening time, shown at match level
  companies: CompanyOddsItem[];
}

interface CrownStoredOdds {
  handicapHome?: string | null;
  handicapLine?: string | null;
  handicapAway?: string | null;
  totalOver?: string | null;
  totalLine?: string | null;
  totalUnder?: string | null;
  euroHome?: string | null;
  euroDraw?: string | null;
  euroAway?: string | null;
  handicapObservedAt?: string | null;
  totalObservedAt?: string | null;
  euroObservedAt?: string | null;
  source?: "3in1" | "legacy-fallback" | string;
}

// Pre-computed row data for Data Tab rendering (avoids recalculation in render)
interface DataMatchRow {
  match: MatchData;
  isFetched: boolean;
  isFetching: boolean;
  openTime: string;
  companies: CompanyOddsItem[];
  crownFinal: { handicapHome?: string | null; handicapLine?: string | null; handicapAway?: string | null; totalOver?: string | null; totalLine?: string | null; totalUnder?: string | null } | undefined;
  crown12: { handicapHome?: string | null; handicapLine?: string | null; handicapAway?: string | null; totalOver?: string | null; totalLine?: string | null; totalUnder?: string | null } | undefined;
}

interface LatestOddsDisplay {
  handicapHome: string;
  handicapLine: string;
  handicapAway: string;
  totalOver: string;
  totalLine: string;
  totalUnder: string;
  source: string;
  isCrownLatest: boolean;
  handicapObservedAt?: string;
  totalObservedAt?: string;
}

// AI analysis result data (from /api/analysis)
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
  handicapTrend: string;       // 保留作参考(升盘/降盘/不变)
  waterDirection: string;      // 核心预测: 主降水/客降水/不变
  prediction: string;
  totalTrend: string;
  totalPrediction: string;
  totalAction: string;
  confidenceLevel: string;
  accuracy: string;
  strategy: string;
  action: string;
  reasoning: string;
  isCorrect?: boolean | null;
  manualIsCorrect?: boolean | null;
  verification?: {
    handicap: MarketVerification;
    total: MarketVerification;
  };
  probability?: AnalysisProbabilityOutput | null;
  settlementEvidence?: Record<string, unknown>;
  // PredictionData compatible fields
  crown_handicap: string;
  yinghe_handicap: string;
  who_open_later: string;
}

function formatAnalysisTime(value?: string | null): string {
  if (!value) return "未知（历史数据）";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "未知（历史数据）"
    : date.toLocaleString("zh-CN", { hour12: false });
}

interface AutomationTaskStepStatusData {
  stepKey: string;
  status: "pending" | "running" | "retrying" | "completed" | "failed";
  lastError: string | null;
}

interface AutomationTaskStatusData {
  id: string;
  taskType: "odds-fetch" | "crown-snapshot" | "analysis" | "verify-learn-report";
  status: "pending" | "running" | "retrying" | "completed" | "failed";
  currentStep: string | null;
  lastError: string | null;
  updatedAt: string;
  steps?: AutomationTaskStepStatusData[];
}

// Default company IDs
const DEFAULT_COMPANY_IDS = ["3", "35", "42", "47", "8"]; // 皇冠(Crow*), 盈禾(盈*), 18博(18*), 平博(平*), 36bet(36*)

// 用户关注联赛白名单：从DB动态加载（user_focused_leagues表）
// 今日赛程保留全部联赛；历史/未来赛程严格按此列表过滤
// 不在此列表的联赛：不显示、不抓取赔率、不做AI分析
// 初始为空Set，页面mount时从API加载；如加载失败则用DEFAULT_FOCUSED_LEAGUES兜底
const DEFAULT_FOCUSED_LEAGUES = new Set([
  "英超","英冠","英甲","苏超","西甲","西乙","意甲","意乙","德甲","德乙",
  "法甲","法乙","葡超","葡甲","荷甲","荷乙","比甲","瑞典超","瑞典甲","挪威超",
  "挪威甲","丹麦超","芬兰超","冰岛超","爱尔兰超","威尔士超","波兰超","捷甲","罗马甲","匈甲",
  "奥甲","瑞士超","希腊超","土超","以超","俄超","乌超","日职","日乙","日联杯",
  "天皇杯","韩职","韩乙","澳超","美职业","美乙","墨超","墨甲","阿甲","巴甲",
  "巴乙","智利甲","哥伦甲","秘鲁甲","中超","亚冠","欧冠","欧罗巴","欧协联","世亚预",
  "世欧预","世南美预","国际赛"
]);

// API response types for odds data
interface ApiCompanyOdds {
  companyId: string;
  companyName: string;
  openTime: string;
  ftHandicapHome: string;
  ftHandicapLine: string;
  ftHandicapAway: string;
  ftHandicapHomeLive: string;
  ftHandicapLineLive: string;
  ftHandicapAwayLive: string;
  euroHome: string;
  euroDraw: string;
  euroAway: string;
  euroHomeLive: string;
  euroDrawLive: string;
  euroAwayLive: string;
  euroAsianHome: string;
  euroAsianLine: string;
  euroAsianAway: string;
  ftTotalOver: string;
  ftTotalLine: string;
  ftTotalUnder: string;
  ftTotalOverLive: string;
  ftTotalLineLive: string;
  ftTotalUnderLive: string;
}

interface ApiMatchOddsResponse {
  matchId: string;
  openTime: string;
  companies: ApiCompanyOdds[];
}

interface ApiOpenTimeEntry {
  companyId: string;
  openTime: string;
}

interface OddsSourceMeta {
  source: string | null;
  sourceObservedAt: SourceTimestamp;
  writeToken?: string | null;
}

interface OddsRefreshJob {
  matchId: string;
  generation: number;
  automatic: boolean;
  resolvers: Array<(success: boolean) => void>;
}

// Pinyin initial mapping for Chinese characters (first letter grouping)
// We'll use a simple approach: compute from league name at runtime
function getLeagueInitial(name: string): string {
  // Common Chinese league name to pinyin first letter mapping
  const pinyinMap: Record<string, string> = {
    "阿": "A", "埃": "A", "爱": "A", "安": "A", "澳": "A",
    "巴": "B", "比": "B", "冰": "B", "波": "B", "玻": "B",
    "朝": "C", "哥": "G", "丹": "D", "德": "D",
    "俄": "E", "芬": "F", "法": "F", "荷": "H", "韩": "H",
    "黑": "H", "洪": "H", "加": "J", "捷": "J", "柬": "J",
    "卡": "K", "喀": "K", "科": "K", "克": "K", "肯": "K",
    "拉": "L", "罗": "L", "黎": "L", "立": "L", "卢": "L",
    "墨": "M", "马": "M", "缅": "M", "摩": "M", "美": "M",
    "挪": "N", "南": "N", "尼": "N", "宁": "N",
    "欧": "O",
    "葡": "P", "秘": "P",
    "日": "R", "瑞": "S", "塞": "S", "沙": "S", "斯": "S", "叙": "S",
    "土": "T", "泰": "T", "突": "T",
    "乌": "W", "委": "W", "维": "W",
    "西": "X", "希": "X", "匈": "X",
    "亚": "Y", "伊": "Y", "印": "Y", "英": "Y", "意": "Y", "越": "Y",
    "中": "Z", "智": "Z",
  };
  const firstChar = name.charAt(0);
  if (pinyinMap[firstChar]) return pinyinMap[firstChar];
  if (/[A-Z]/.test(firstChar)) return firstChar.toUpperCase();
  if (/[a-z]/.test(firstChar)) return firstChar.toUpperCase();
  return "#";
}

// Chinese handicap text → numeric value
const HANDICAP_MAP: Record<string, number> = {
  "平手": 0, "0": 0,
  "平手/半球": 0.25, "0/0.5": 0.25,
  "半球": 0.5, "0.5": 0.5,
  "半球/一球": 0.75, "0.5/1": 0.75,
  "一球": 1, "1": 1,
  "一球/球半": 1.25, "1/1.5": 1.25,
  "球半": 1.5, "1.5": 1.5,
  "球半/两球": 1.75, "1.5/2": 1.75,
  "两球": 2, "2": 2,
  "两球/两球半": 2.25, "2/2.5": 2.25,
  "两球半": 2.5, "2.5": 2.5,
  "两球半/三球": 2.75, "2.5/3": 2.75,
  "三球": 3, "3": 3,
};

function parseCrownHandicap(str: string): ParsedCrownHandicap | null {
  if (!str) return null;
  const trimmed = str.trim();
  const match = trimmed.match(/^([\d.]+)\s+(受让)?(.+?)\s+([\d.]+)$/);
  if (!match) return null;
  const homeOdds = parseFloat(match[1]);
  const isReceiving = !!match[2];
  const handicapText = match[3].trim();
  const awayOdds = parseFloat(match[4]);
  let handicapValue = HANDICAP_MAP[handicapText];
  if (handicapValue === undefined) {
    handicapValue = parseFloat(handicapText);
    if (isNaN(handicapValue)) return null;
  }
  if (isReceiving) handicapValue = -handicapValue;
  return { homeOdds, awayOdds, handicapValue };
}

interface PredictionComparison {
  oddsDiff: number | null;
  handicapChange: "升" | "降" | null;
  predictedSide: "home" | "away";
  action: string;
}

function oddsValue(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized) return normalized;
  }
  return "";
}

function getCompanyLatestOdds(company: CompanyOddsItem) {
  return {
    handicapHome: oddsValue(company.ftHandicapHomeLive, company.ftHandicapHome),
    handicapLine: oddsValue(company.ftHandicapLineLive, company.ftHandicapLine),
    handicapAway: oddsValue(company.ftHandicapAwayLive, company.ftHandicapAway),
    totalOver: oddsValue(company.ftTotalOverLive, company.ftTotalOver),
    totalLine: oddsValue(company.ftTotalLineLive, company.ftTotalLine),
    totalUnder: oddsValue(company.ftTotalUnderLive, company.ftTotalUnder),
    hasLive: Boolean(company.ftHandicapLineLive || company.ftTotalLineLive),
  };
}

function getMatchLatestOdds(match: MatchData, crownCompany?: CompanyOddsItem): LatestOddsDisplay {
  if (crownCompany) {
    const latest = getCompanyLatestOdds(crownCompany);
    if (latest.handicapLine || latest.totalLine) {
      return {
        handicapHome: oddsValue(latest.handicapHome, match.homeOdds),
        handicapLine: oddsValue(latest.handicapLine, match.handicap),
        handicapAway: oddsValue(latest.handicapAway, match.awayOdds),
        totalOver: oddsValue(latest.totalOver, match.overOdds),
        totalLine: oddsValue(latest.totalLine, match.totalLine),
        totalUnder: oddsValue(latest.totalUnder, match.underOdds),
        source: latest.hasLive ? "旧页即时" : "旧页初盘",
        isCrownLatest: true,
      };
    }
  }

  return {
    handicapHome: match.homeOdds,
    handicapLine: match.handicap,
    handicapAway: match.awayOdds,
    totalOver: match.overOdds,
    totalLine: match.totalLine,
    totalUnder: match.underOdds,
    source: "即时",
    isCrownLatest: false,
  };
}

function buildPurchaseAdvice(analysis: AnalysisResultData, odds: LatestOddsDisplay): { handicap: string; total: string; title: string } {
  const handicapOdds = analysis.prediction === "主"
    ? odds.handicapHome
    : analysis.prediction === "客"
      ? odds.handicapAway
      : "";
  const handicap = analysis.prediction === "主" || analysis.prediction === "客"
    ? `建议买${analysis.prediction}${odds.handicapLine ? `（${odds.handicapLine}${handicapOdds ? ` @ ${handicapOdds}` : ""}）` : ""}`
    : "建议观望";

  const totalOdds = analysis.totalPrediction === "大"
    ? odds.totalOver
    : analysis.totalPrediction === "小"
      ? odds.totalUnder
      : "";
  const total = analysis.totalPrediction === "大" || analysis.totalPrediction === "小"
    ? `大小球买${analysis.totalPrediction}${odds.totalLine ? `（${odds.totalLine}${totalOdds ? ` @ ${totalOdds}` : ""}）` : ""}`
    : "大小球观望";

  return {
    handicap,
    total,
    title: `${handicap}；${total}；信心${analysis.confidenceLevel} ${analysis.accuracy}`,
  };
}

function computePredictionComparison(
  pred: PredictionData,
  liveHomeOdds: string,
  liveAwayOdds: string,
  liveHandicapRaw: number
): PredictionComparison | null {
  // Try crown_handicap first (old format: "0.85 半球 1.01"), then fallback to handicap + home_odds/away_odds
  let crown = parseCrownHandicap(pred.crown_handicap);
  if (!crown) {
    // New format: handicap is text like "半球", home_odds/away_odds are separate fields
    const predAny = pred as unknown as Record<string, unknown>;
    const handicapText = pred.crown_handicap || predAny.handicap as string || "";
    const homeOdds = predAny.home_odds as number || 0;
    const awayOdds = predAny.away_odds as number || 0;

    if (!handicapText || (!homeOdds && !awayOdds)) return null;

    let handicapValue = HANDICAP_MAP[handicapText];
    if (handicapValue === undefined) {
      handicapValue = parseFloat(handicapText);
      if (isNaN(handicapValue)) return null;
    }

    // Detect "受让" prefix in handicap text
    const isReceiving = /受让/.test(handicapText);
    if (isReceiving) handicapValue = -handicapValue;

    crown = { homeOdds, awayOdds, handicapValue };
  }

  const predText = pred.prediction || "";
  const predictedSide: "home" | "away" = predText.includes("主") ? "home" : "away";

  let oddsDiff: number | null = null;
  const liveHome = parseFloat(liveHomeOdds);
  const liveAway = parseFloat(liveAwayOdds);
  if (predictedSide === "home" && !isNaN(liveHome) && crown.homeOdds) {
    oddsDiff = parseFloat((liveHome - crown.homeOdds).toFixed(2));
  } else if (predictedSide === "away" && !isNaN(liveAway) && crown.awayOdds) {
    oddsDiff = parseFloat((liveAway - crown.awayOdds).toFixed(2));
  }

  let handicapChange: "升" | "降" | null = null;
  if (!isNaN(liveHandicapRaw)) {
    const diff = parseFloat((liveHandicapRaw - crown.handicapValue).toFixed(2));
    if (diff !== 0) {
      if (crown.handicapValue < 0) {
        handicapChange = diff < 0 ? "升" : "降";
      } else {
        handicapChange = diff > 0 ? "升" : "降";
      }
    }
  }

  return { oddsDiff, handicapChange, predictedSide, action: pred.action || (pred as unknown as Record<string, unknown>).action as string || "" };
}

function parsePredictions(json: string): Map<string, PredictionData> {
  const map = new Map<string, PredictionData>();
  if (!json) return map;
  try {
    const parsed = JSON.parse(json);
    let arr: PredictionData[];
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.matches)) {
      arr = parsed.matches;
    } else if (parsed && typeof parsed === "object" && parsed.home && parsed.away) {
      arr = [parsed as PredictionData];
    } else {
      return map;
    }
    for (const item of arr) {
      if (item.home && item.away) {
        const key = `${item.home}_${item.away}`;
        map.set(key, item);
      }
    }
  } catch {
    // ignore invalid JSON
  }
  return map;
}

const LS_PINNED_IDS_KEY = "odds_monitor_pinned_ids";
const LS_PINNED_INFO_KEY = "odds_monitor_pinned_info";
const LS_NOTES_KEY = "odds_monitor_notes";

// --- Odds comparison logic ---
// Note format: "盘口 主赔/客赔 方向" e.g. "0/0.5 0.83/1.05 客" or "受0.5/1 1.11/0.78 主"
// When side is selected, compare that side's predicted odds vs current odds
// diff = predicted odds - current odds (positive = odds dropped = good for bettor)

interface OddsComparison {
  predictedOdds: number;   // the odds value from the note for selected side
  currentOdds: number;     // current real-time odds for OPPOSITE side
  sumTotal: number;        // predictedOdds + currentOdds (note selected + live opposite)
  diff: number;            // sumTotal - baseTotal (positive = over-value)
}

// Extract home/away odds pair from note text (format: "盘口 主赔/客赔 方向")
function extractOddsPairFromNote(note: string): { homeOdds: number; awayOdds: number } | null {
  if (!note) return null;
  // Find pattern like "0.83/1.05" or "1.11/0.78" (two decimal numbers separated by /)
  const match = note.match(/(\d+\.\d+)\s*\/\s*(\d+\.\d+)/);
  if (match) {
    const homeOdds = parseFloat(match[1]);
    const awayOdds = parseFloat(match[2]);
    if (!isNaN(homeOdds) && !isNaN(awayOdds)) {
      return { homeOdds, awayOdds };
    }
  }
  return null;
}

// Detect which side the note refers to from keywords
// Returns: "home" if note has 主/受让, "away" if note has 客/让, null if indeterminate
function detectHandicapSide(note: string): "home" | "away" | null {
  if (/主|受让|受/.test(note) && !/客/.test(note)) return "home";
  if (/客|让球|让$|^[让]/.test(note) && !/主/.test(note)) return "away";
  return null;
}

// Detect which side the total note refers to
// Returns: "over" if note has 大, "under" if note has 小, null if indeterminate
function detectTotalSide(note: string): "over" | "under" | null {
  if (/大/.test(note) && !/小/.test(note)) return "over";
  if (/小/.test(note) && !/大/.test(note)) return "under";
  return null;
}

// Extract the line/handicap value from the note (everything before the odds pair)
// Note format: "盘口 主赔/客赔 方向", e.g. "0/0.5 0.83/1.05 客", "受0.5 1.11/0.78 主"
function extractLineFromNote(note: string): string {
  if (!note) return "";
  // Find the odds pair pattern (two decimal numbers with /)
  const oddsMatch = note.match(/(\d+\.\d+)\s*\/\s*(\d+\.\d+)/);
  if (!oddsMatch) return "";
  // Everything before the odds pair is the line value
  const beforeOdds = note.substring(0, oddsMatch.index).trim();
  // Remove any trailing spaces or separators
  return beforeOdds.replace(/\s+$/, "");
}

// 升降盘判定：基于让球方优势方向（盘口绝对值变化）
// 升盘 = 让球方优势扩大（盘口绝对值增大），降盘 = 让球方优势缩小（盘口绝对值减小）
// 让球(正数): diff>0=升盘, diff<0=降盘
// 受让(负数): diff<0=升盘(绝对值增大), diff>0=降盘(绝对值减小)
// 例: 让0.5(+0.5)→让0.75(+0.75): diff=+0.25 → 升盘 ✓
//     受0.5(-0.5)→受0.25(-0.25): diff=+0.25 → 降盘(受让减少=让球方优势缩小) ✓
//     受0/0.5(-0.25)→受0.5(-0.5): diff=-0.25 → 升盘(受让增多=让球方优势扩大) ✓
function getHandicapTrendLabel(initLine: number, liveLine: number): "升" | "降" | null {
  const diff = liveLine - initLine;
  if (Math.abs(diff) < 0.01) return null;
  // 受让盘(负数): 绝对值增大=升盘, 让球盘(正数): 值增大=升盘
  // 统一: 当initLine和diff同号时=升盘, 异号时=降盘
  // 让球: diff>0(initLine>0) → 同号 → 升; diff<0 → 异号 → 降
  // 受让: diff<0(initLine<0) → 同号 → 升; diff>0 → 异号 → 降
  if (initLine >= 0) {
    return diff > 0 ? "升" : "降";
  } else {
    return diff < 0 ? "升" : "降";
  }
}

// Compute diff between crown12 (opening) odds and live odds
// lineChange = liveLine - initLine (raw numeric diff, sign depends on 让/受 direction)
function computeCrown12VsLiveDiff(
  crown12: { handicapHome?: string | null; handicapLine?: string | null; handicapAway?: string | null },
  liveHomeOdds: string,
  liveAwayOdds: string,
  liveHandicapRaw: number
): { homeDiff: number; awayDiff: number; lineChange: number } | null {
  if (!crown12?.handicapHome || !crown12?.handicapAway || !crown12?.handicapLine) return null;
  const c12Home = parseFloat(crown12.handicapHome);
  const c12Away = parseFloat(crown12.handicapAway);
  const liveHome = parseFloat(liveHomeOdds);
  const liveAway = parseFloat(liveAwayOdds);
  if (isNaN(c12Home) || isNaN(c12Away) || isNaN(liveHome) || isNaN(liveAway)) return null;
  // Convert crown12 line to number
  const c12Line = lineTextToNumber(crown12.handicapLine);
  if (c12Line === null) return null;
  // 升降盘: 用原始值比较 — live > c12 = 升盘（盘口向主队方向移动）
  const lineChange = parseFloat((liveHandicapRaw - c12Line).toFixed(2));
  return {
    homeDiff: parseFloat((liveHome - c12Home).toFixed(2)),
    awayDiff: parseFloat((liveAway - c12Away).toFixed(2)),
    lineChange,
  };
}

// Convert Chinese/mixed handicap line text to number (for diff calculation)
function lineTextToNumber(text: string): number | null {
  if (!text) return null;
  const t = text.trim();
  // 让=正, 受=负; diff>0=升盘(主队方向)
  const num = parseFloat(t);
  if (!isNaN(num)) return num; // pure number = 让球 = 正数
  const isReceiving = t.startsWith("受") || t.startsWith("*");
  const body = isReceiving ? t.slice(1) : t;
  // After stripping prefix, try numeric parse first (e.g. "受0.5" → body="0.5")
  const bodyNum = parseFloat(body);
  if (!isNaN(bodyNum)) return isReceiving ? -bodyNum : bodyNum;
  const partMap: Record<string, number> = { "零": 0, "平": 0, "半": 0.5, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6 };
  const chineseMap: Record<string, number> = { "平手": 0, "半球": 0.5, "一球": 1, "一球半": 1.5, "两球": 2, "两球半": 2.5, "三球": 3, "三球半": 3.5, "四球": 4, "四球半": 4.5 };
  const parts = body.split("/");
  if (parts.length === 2) {
    const low = chineseMap[parts[0]] ?? parseFloat(parts[0]);
    const high = chineseMap[parts[1]] ?? parseFloat(parts[1]);
    if (!isNaN(low) && !isNaN(high)) {
      const result = (low + high) / 2;
      return isReceiving ? -result : result;
    }
    // Fallback: character-by-character
    const vals = parts.map(p => {
      let val = 0;
      for (const ch of p) {
        if (partMap[ch] !== undefined) val += partMap[ch];
      }
      return val;
    });
    const fallbackResult = (vals[0] + vals[1]) / 2;
    return isReceiving ? -fallbackResult : fallbackResult;
  }
  // Single part: try Chinese word map first, then character-by-character
  if (chineseMap[body] !== undefined) return isReceiving ? -chineseMap[body] : chineseMap[body];
  let val = 0;
  for (const ch of body) {
    if (partMap[ch] !== undefined) val += partMap[ch];
  }
  return isReceiving ? -val : val; // 受让=负数，让球=正数
}

// Parse handicap note into aligned parts: line, homeOdds, awayOdds, side label
function parseHandicapNote(note: string): { line: string; homeOdds: string; awayOdds: string; side: string } | null {
  if (!note) return null;
  const oddsPair = extractOddsPairFromNote(note);
  if (!oddsPair) return null;
  const side = detectHandicapSide(note) === "home" ? "主" : detectHandicapSide(note) === "away" ? "客" : "";
  const line = extractLineFromNote(note);
  return {
    line,
    homeOdds: oddsPair.homeOdds.toFixed(2),
    awayOdds: oddsPair.awayOdds.toFixed(2),
    side,
  };
}

// Parse total note into aligned parts
function parseTotalNote(note: string): { line: string; overOdds: string; underOdds: string; side: string } | null {
  if (!note) return null;
  const oddsPair = extractOddsPairFromNote(note);
  if (!oddsPair) return null;
  const side = detectTotalSide(note) === "over" ? "大" : detectTotalSide(note) === "under" ? "小" : "";
  const line = extractLineFromNote(note);
  return {
    line,
    overOdds: oddsPair.homeOdds.toFixed(2),
    underOdds: oddsPair.awayOdds.toFixed(2),
    side,
  };
}

// Compute handicap odds comparison
// Note format: "盘口 主赔/客赔 方向"
// When side is "主", compare predicted home odds vs current home odds
// When side is "客", compare predicted away odds vs current away odds
// diff = predicted - current (positive = odds dropped = good)
function computeHandicapComparison(
  noteText: string,
  homeOdds: string,
  awayOdds: string,
  baseTotal: number = 1.90
): OddsComparison | null {
  const oddsPair = extractOddsPairFromNote(noteText);
  if (oddsPair === null) return null;
  const home = parseFloat(homeOdds);
  const away = parseFloat(awayOdds);
  if (isNaN(home) || isNaN(away)) return null;

  const side = detectHandicapSide(noteText);
  if (side === "home") {
    // Selected home: noteHomeOdds + liveAwayOdds vs baseTotal
    const sumTotal = oddsPair.homeOdds + away;
    return {
      predictedOdds: oddsPair.homeOdds,
      currentOdds: away,
      sumTotal,
      diff: sumTotal - baseTotal,
    };
  } else if (side === "away") {
    // Selected away: noteAwayOdds + liveHomeOdds vs baseTotal
    const sumTotal = oddsPair.awayOdds + home;
    return {
      predictedOdds: oddsPair.awayOdds,
      currentOdds: home,
      sumTotal,
      diff: sumTotal - baseTotal,
    };
  }
  return null;
}

// Compute total line odds comparison
// Note format: "盘口 大赔/小赔 方向"
// When side is "大", compare noteOverOdds + liveUnderOdds vs baseTotal
// When side is "小", compare noteUnderOdds + liveOverOdds vs baseTotal
function computeTotalComparison(
  noteText: string,
  overOdds: string,
  underOdds: string,
  baseTotal: number = 1.90
): OddsComparison | null {
  const oddsPair = extractOddsPairFromNote(noteText);
  if (oddsPair === null) return null;
  const over = parseFloat(overOdds);
  const under = parseFloat(underOdds);
  if (isNaN(over) || isNaN(under)) return null;

  const side = detectTotalSide(noteText);
  if (side === "over") {
    const sumTotal = oddsPair.homeOdds + under;
    return {
      predictedOdds: oddsPair.homeOdds,
      currentOdds: under,
      sumTotal,
      diff: sumTotal - baseTotal,
    };
  } else if (side === "under") {
    const sumTotal = oddsPair.awayOdds + over;
    return {
      predictedOdds: oddsPair.awayOdds,
      currentOdds: over,
      sumTotal,
      diff: sumTotal - baseTotal,
    };
  }
  return null;
}

function loadFromLS<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveToLS(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

// --- Sound utility ---
function playAlertSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "square";
    osc.frequency.value = 800;
    gain.gain.value = 0.15;
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, 200);
  } catch {
    // ignore
  }
}

// --- Main Component ---
// Normalize open time format for correct sorting (e.g. "4-6 17:19" → "04-06 17:19")
// Must be defined outside component to avoid hoisting issues with useMemo
/**
 * Check if a league name matches any league in the selected set.
 * Uses "core name" matching: strip common suffixes to get the base league name,
 * then compare. Suffixes are stripped in two passes:
 *   1. Qualifier suffixes: 冠/降/升/附/春/秋/杯/级/保 (赛制后缀)
 *   2. League-level suffixes: 超/甲/联 + trailing digits like 2 (联赛级别)
 * Also strips: U数字, 女...
 */
function getLeagueCoreName(name: string, stripLevel = false): string {
  let core = name
    .replace(/U\d+$/g, '')       // Remove U19, U21 etc
    .replace(/女.+$/g, '')       // Remove 女... suffix
    .replace(/(冠|降|升|附|春|秋|杯|级|保)$/g, '')  // Remove qualifier suffix
    .replace(/(冠|降|升|附|春|秋|杯|级|保)$/g, ''); // Repeat for double qualifiers
  if (stripLevel) {
    core = core.replace(/(超|甲|联|乙|丙|丁|\d+)$/g, '');  // Remove league-level suffix + trailing digits
  }
  return core;
}

function isLeagueSelected(leagueName: string, selectedLeagues: Set<string>): boolean {
  if (selectedLeagues.has(leagueName)) return true;
  const leagueWithLevel = getLeagueCoreName(leagueName, false);
  const leagueNoLevel = getLeagueCoreName(leagueName, true);
  for (const sel of selectedLeagues) {
    if (sel === "__NONE__") continue;
    if (sel === leagueName) return true;
    const selWithLevel = getLeagueCoreName(sel, false);
    const selNoLevel = getLeagueCoreName(sel, true);
    // Pass 1: match with level suffix kept (more precise)
    // e.g. "丹麦甲升" core="丹麦甲" matches "丹麦甲降" core="丹麦甲"
    if (selWithLevel === leagueWithLevel && selWithLevel.length > 0) return true;
    // Pass 2: match with level suffix stripped (cross-level matching)
    // e.g. "巴林超" core="巴林" matches "巴林甲" core="巴林"
    // e.g. "韩K联" core="韩K" matches "韩K2" core="韩K"
    if (selNoLevel === leagueNoLevel && selNoLevel.length >= 1) return true;
  }
  return false;
}

function normalizeOpenTime(t: string): string {
  if (!t) return "zzz";
  const m = t.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  return `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")} ${m[3].padStart(2, "0")}:${m[4]}`;
}

// Convert abbreviated handicap line format to full format (same as crown12/新数据 format)
// e.g. "*平/半" → "受让平手/半球", "*半/一" → "受让半球/一球", "一球" → "一球"
function formatHandicapLine(line: string): string {
  if (!line) return line;
  const isReceive = line.startsWith("*");
  let val = isReceive ? line.slice(1) : line;

  // Expand single-char parts in split lines (e.g. "平/半" → "平手/半球")
  if (val.includes("/")) {
    const parts = val.split("/");
    val = parts.map(p => {
      if (p === "平") return "平手";
      if (p === "半") return "半球";
      if (p === "一") return "一球";
      if (p === "两") return "两球";
      return p; // "球半", "两球半", etc. stay as-is
    }).join("/");
  }

  return isReceive ? `受让${val}` : val;
}

// Get pinyin initials for Chinese characters (first letter of each char)
// e.g. "英超" → "yc", "西甲" → "xj", "意甲" → "yj"
// Uses a compact lookup table covering common league name characters
const _PI: Record<string, string> = {"阿":"a","埃":"a","爱":"a","安":"a","奥":"a","澳":"a","巴":"b","白":"b","保":"b","北":"b","贝":"b","比":"b","玻":"b","勃":"b","布":"b","采":"b","成":"c","赤":"c","楚":"c","川":"c","春":"c","超":"c","达":"d","大":"d","丹":"d","德":"d","丁":"d","东":"d","典":"d","岛":"d","地":"d","度":"d","俄":"e","恩":"e","尔":"e","厄":"e","法":"f","芬":"f","佛":"f","弗":"f","伐":"f","菲":"f","附":"f","非":"f","冈":"g","哥":"g","格":"g","瓜":"g","冠":"g","广":"g","国":"g","港":"g","干":"g","戈":"g","哈":"h","海":"h","荷":"h","赫":"h","黑":"h","洪":"h","后":"h","华":"h","黄":"h","惠":"h","霍":"h","韩":"h","及":"j","吉":"j","加":"j","甲":"j","贾":"j","柬":"j","捷":"j","金":"j","京":"j","精":"j","九":"j","俱":"j","降":"j","锦":"j","季":"j","卡":"k","开":"k","科":"k","克":"k","库":"k","昆":"k","拉":"l","莱":"l","兰":"l","勒":"l","雷":"l","里":"l","利":"l","联":"l","立":"l","伦":"l","罗":"l","洛":"l","鲁":"l","腊":"l","律":"l","马":"m","麦":"m","曼":"m","梅":"m","美":"m","孟":"m","秘":"m","摩":"m","墨":"m","木":"m","南":"n","内":"n","尼":"n","宁":"n","纽":"n","挪":"n","拿":"n","欧":"o","帕":"p","皮":"p","平":"p","葡":"p","普":"p","浦":"p","奇":"q","齐":"q","青":"q","清":"q","秋":"q","区":"q","全":"q","然":"r","人":"r","日":"r","荣":"r","瑞":"r","壬":"r","萨":"s","塞":"s","沙":"s","山":"s","上":"s","升":"s","圣":"s","士":"s","斯":"s","苏":"s","索":"s","塔":"t","泰":"t","特":"t","天":"t","突":"t","土":"t","托":"t","台":"t","陶":"t","瓦":"w","维":"w","沃":"w","乌":"w","武":"w","委":"w","威":"w","西":"x","希":"x","香":"x","协":"x","新":"x","匈":"x","亚":"y","延":"y","伊":"y","以":"y","意":"y","印":"y","英":"y","营":"y","约":"y","越":"y","云":"y","业":"y","乙":"y","余":"y","议":"y","泽":"z","占":"z","智":"z","中":"z","总":"z","职":"z","足":"z","女":"n","戊":"w"};

function getPinyinInitials(text: string): string {
  let result = "";
  for (const char of text) {
    const initial = _PI[char];
    if (initial) {
      result += initial;
    } else if (/[a-zA-Z]/.test(char)) {
      result += char.toLowerCase();
    }
  }
  return result;
}

function isAutomationCompensationAvailable(now = new Date()): boolean {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const hour = beijing.getUTCHours();
  const minute = beijing.getUTCMinutes();
  return hour > 12 || (hour === 12 && minute >= 2);
}

function automationTaskLabel(type: AutomationTaskStatusData["taskType"]): string {
  return {
    "odds-fetch": "赔率抓取",
    "crown-snapshot": "皇冠快照",
    analysis: "AI分析",
    "verify-learn-report": "验证学习报表",
  }[type];
}

function automationStatusText(tasks: AutomationTaskStatusData[]): string {
  if (tasks.length === 0) {
    return isAutomationCompensationAvailable() ? "服务端任务未创建" : "服务端任务待北京时间12:02后执行";
  }

  const completed = tasks.filter(task => task.status === "completed").length;
  const running = tasks.filter(task => task.status === "running" || task.status === "retrying").length;
  const failed = tasks.find(task => task.status === "failed");
  if (failed) {
    const stepError = failed.steps?.find(step => step.status === "failed" && step.lastError)?.lastError;
    const reason = failed.lastError || stepError || "未知错误";
    return `服务端任务 ${completed}/${tasks.length} 完成，${automationTaskLabel(failed.taskType)}失败：${reason}`;
  }
  if (running > 0) return `服务端任务 ${completed}/${tasks.length} 完成，${running} 个执行中/重试中`;
  return `服务端任务 ${completed}/${tasks.length} 完成`;
}

// Match league name against search text (Chinese name contains + pinyin initials)
function matchLeague(leagueName: string, searchText: string): boolean {
  if (!searchText) return false;
  const lower = searchText.toLowerCase().trim();
  if (!lower) return false;

  // Direct Chinese name match (contains)
  if (leagueName.toLowerCase().includes(lower)) return true;

  // Pinyin initials match (e.g. "yc" matches "英超")
  const pinyin = getPinyinInitials(leagueName);
  if (pinyin.includes(lower)) return true;

  return false;
}

export default function OddsMonitorPage() {
  const [matches, setMatches] = useState<MatchData[]>([]);
  const matchesRef = useRef<MatchData[]>([]);
  matchesRef.current = matches;
  const [leagues, setLeagues] = useState<LeagueData[]>([]);
  const [hotMatchCount, setHotMatchCount] = useState(0); // Total hot matches across ALL states
  const [selectedLeagues, setSelectedLeagues] = useState<Set<string>>(new Set());
  const [pinnedMatches, setPinnedMatches] = useState<Set<string>>(new Set());
  const [pinnedMatchInfo, setPinnedMatchInfo] = useState<Map<string, PinnedMatchInfo>>(new Map());
  const [minOddsSum, setMinOddsSum] = useState("1.84");
  const [refreshInterval, setRefreshInterval] = useState(10);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<number>(0);
  const [matchDate, setMatchDate] = useState("");
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertConfigs, setAlertConfigs] = useState<Map<string, AlertConfig>>(
    new Map()
  );
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [oddsSnapshots, setOddsSnapshots] = useState<Map<string, OddsSnapshot>>(
    new Map()
  );
  const [leagueFilterOpen, setLeagueFilterOpen] = useState(false);
  const [alertDialogOpen, setAlertDialogOpen] = useState(false);
  const [currentAlertMatchId, setCurrentAlertMatchId] = useState<string>("");
  const [error, setError] = useState("");

  // Notes state
  const [notes, setNotes] = useState<Map<string, MatchNotes>>(new Map());
  const [noteDialogOpen, setNoteDialogOpen] = useState(false);
  const [noteMatchId, setNoteMatchId] = useState<string>("");
  const [editHandicapNote, setEditHandicapNote] = useState("");
  const [editTotalNote, setEditTotalNote] = useState("");
  const [editHandicapAmount, setEditHandicapAmount] = useState("");
  const [editTotalAmount, setEditTotalAmount] = useState("");
  const [editHandicapSettled, setEditHandicapSettled] = useState(false);
  const [editTotalSettled, setEditTotalSettled] = useState(false);

  // Paste JSON state
  const [pasteDialogOpen, setPasteDialogOpen] = useState(false);
  const [pastedJson, setPastedJson] = useState("");
  const [savedJson, setSavedJson] = useState("");
  const [expandedCrown, setExpandedCrown] = useState<Set<string>>(new Set());
  const [expandedCompanies, setExpandedCompanies] = useState<Set<string>>(new Set()); // matches with company odds expanded (monitor tab)
  const [monitorCompanyIds, setMonitorCompanyIds] = useState<string[]>(DEFAULT_COMPANY_IDS); // monitor tab company filter
  const [dataCompanyIds, setDataCompanyIds] = useState<string[]>(DEFAULT_COMPANY_IDS); // data tab company filter (independent)
  // Company odds data - from database (data tab + monitor tab expand)
  const [dbCompanyOddsMap, setDbCompanyOddsMap] = useState<Map<string, CompanyOddsData>>(new Map());
  const dbCompanyOddsMapRef = useRef(dbCompanyOddsMap);
  const oddsRefreshSequenceRef = useRef(0);
  const matchRefreshVersionRef = useRef<Map<string, number>>(new Map());
  const matchPersistedVersionRef = useRef<Map<string, number>>(new Map());
  const oddsGenerationRef = useRef(0);
  const oddsSourceMetaRef = useRef<Map<string, OddsSourceMeta>>(new Map());
  const latestOddsRequestRef = useRef<Map<string, number>>(new Map());
  const oddsRefreshQueueRef = useRef<RefreshQueueItem<OddsRefreshJob>[]>([]);
  const oddsRefreshWorkerRunningRef = useRef(false);
  const oddsSourceTaskTailRef = useRef<Promise<void>>(Promise.resolve());
  const oddsSingleFlightRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const oddsRefreshCoreRef = useRef<(matchId: string, generation: number) => Promise<boolean>>(async () => false);
  const detailedScheduleRef = useRef<() => void>(() => {});
  const [oddsQueueStatus, setOddsQueueStatus] = useState({ queued: 0, inFlight: 0, lastSuccessAt: 0 });
  const [oddsStatusNow, setOddsStatusNow] = useState(Date.now());
  useEffect(() => {
    dbCompanyOddsMapRef.current = dbCompanyOddsMap;
  }, [dbCompanyOddsMap]);

  const runSerializedOddsSourceTask = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = oddsSourceTaskTailRef.current.then(task, task);
    oddsSourceTaskTailRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const runOddsRefreshWorker = useCallback(async () => {
    if (oddsRefreshWorkerRunningRef.current) return;
    oddsRefreshWorkerRunningRef.current = true;
    try {
      while (oddsRefreshQueueRef.current.length > 0) {
        const queued = oddsRefreshQueueRef.current.shift()!;
        setOddsQueueStatus(previous => ({ ...previous, queued: oddsRefreshQueueRef.current.length, inFlight: 1 }));
        const { matchId, generation, resolvers } = queued.value;
        let flight = oddsSingleFlightRef.current.get(matchId);
        if (!flight) {
          flight = runSerializedOddsSourceTask(() => oddsRefreshCoreRef.current(matchId, generation)).finally(() => {
            oddsSingleFlightRef.current.delete(matchId);
          });
          oddsSingleFlightRef.current.set(matchId, flight);
        }
        const success = await flight;
        resolvers.forEach(resolve => resolve(success));
        if (success && generation === oddsGenerationRef.current) {
          setOddsQueueStatus(previous => ({ ...previous, lastSuccessAt: Date.now() }));
        }
        if (oddsRefreshQueueRef.current.length > 0) {
          await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
        }
      }
    } finally {
      oddsRefreshWorkerRunningRef.current = false;
      setOddsQueueStatus(previous => ({ ...previous, queued: oddsRefreshQueueRef.current.length, inFlight: 0 }));
    }
  }, [runSerializedOddsSourceTask]);

  const enqueueOddsRefresh = useCallback((matchId: string, priority = 0, automatic = false): Promise<boolean> => {
    const generation = oddsGenerationRef.current;
    const existingFlight = oddsSingleFlightRef.current.get(matchId);
    if (existingFlight) return existingFlight;
    return new Promise<boolean>(resolve => {
      const existingQueued = oddsRefreshQueueRef.current.find(item => item.key === matchId);
      const value: OddsRefreshJob = existingQueued
        ? { ...existingQueued.value, automatic: existingQueued.value.automatic && automatic, resolvers: [...existingQueued.value.resolvers, resolve] }
        : { matchId, generation, automatic, resolvers: [resolve] };
      const nextQueue = enqueueRefreshItem(oddsRefreshQueueRef.current, {
        key: matchId,
        priority,
        value,
      });
      const retained = nextQueue.slice(0, 200);
      nextQueue.slice(200).forEach(item => item.value.resolvers.forEach(droppedResolve => droppedResolve(false)));
      oddsRefreshQueueRef.current = retained;
      setOddsQueueStatus(previous => ({ ...previous, queued: oddsRefreshQueueRef.current.length }));
      void runOddsRefreshWorker();
    });
  }, [runOddsRefreshWorker]);

  useEffect(() => {
    const timer = setInterval(() => setOddsStatusNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [crownLiveOddsFromDb, setCrownLiveOddsFromDb] = useState<Map<string, CrownStoredOdds>>(new Map());
  const [crown12OddsFromDb, setCrown12OddsFromDb] = useState<Map<string, CrownStoredOdds>>(new Map());
  // Data tab schedule mode & filters
  const [dataScheduleMode, setDataScheduleMode] = useState<"today" | "history" | "future">("today");
  const [dataDate, setDataDate] = useState(""); // selected date for history/future
  const [dataDateEnd, setDataDateEnd] = useState(""); // end date for history range
  // Schedule-specific data (separate from today's live data)
  const [scheduleMatches, setScheduleMatches] = useState<MatchData[]>([]);
  const [scheduleLeagues, setScheduleLeagues] = useState<LeagueData[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const [scheduleHotMatchCount, setScheduleHotMatchCount] = useState(0);
  const [dataLeagueFilterOpen, setDataLeagueFilterOpen] = useState(false);
  const [dataSelectedLeagues, setDataSelectedLeagues] = useState<Set<string>>(new Set()); // data tab: empty=all, non-empty=only selected
  const [dataCurrentPage, setDataCurrentPage] = useState(1); // pagination for Data Tab
  const [leagueInputText, setLeagueInputText] = useState(""); // league name input for quick filter
  // League filter modes
  const [dataFilterCategory, setDataFilterCategory] = useState<"all" | "zucai" | "jingzu" | "danchang">("all");
  const [dataFilterStatus, setDataFilterStatus] = useState<"all" | "rolling" | "upcoming" | "finished" | "playing">("all");
  const [dataFilterLetter, setDataFilterLetter] = useState<string>("热"); // "热" for hot, or "A"-"Z"
  const [predictionDates, setPredictionDates] = useState<string[]>([]);
  const [selectedPredDate, setSelectedPredDate] = useState("");
  const [fetchUrlInput, setFetchUrlInput] = useState("");
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [oddsAlertThreshold, setOddsAlertThreshold] = useState(0.5);
  const [oddsBaseTotal, setOddsBaseTotal] = useState(1.90); // configurable total odds threshold
  // User focused leagues whitelist (dynamic, from DB)
  const [userFocusedLeagues, setUserFocusedLeagues] = useState<Set<string>>(DEFAULT_FOCUSED_LEAGUES);
  const [focusedLeagueDialogOpen, setFocusedLeagueDialogOpen] = useState(false);
  const [focusedLeagueEditing, setFocusedLeagueEditing] = useState<Set<string>>(new Set()); // working copy
  const [focusedLeagueSaving, setFocusedLeagueSaving] = useState(false);
  const [focusedLeagueSearch, setFocusedLeagueSearch] = useState("");
  // Feishu settings
  const [feishuDialogOpen, setFeishuDialogOpen] = useState(false);
  const [feishuWebhookUrl, setFeishuWebhookUrl] = useState("");
  const [feishuSaving, setFeishuSaving] = useState(false);
  const [feishuTesting, setFeishuTesting] = useState(false);
  const [feishuTestResult, setFeishuTestResult] = useState<string | null>(null);
  // Server-side automation status
  const [automationTasks, setAutomationTasks] = useState<AutomationTaskStatusData[]>([]);
  const previousAutomationStatusRef = useRef<Map<string, AutomationTaskStatusData["status"]>>(new Map());
  const [automationCompensating, setAutomationCompensating] = useState(false);
  const [automationMessage, setAutomationMessage] = useState("");
  const [automationCompensationAvailable, setAutomationCompensationAvailable] = useState(() => isAutomationCompensationAvailable());
  // All leagues ever seen (for the picker UI) - union of DB whitelist + schedule leagues
  const [allKnownLeagues, setAllKnownLeagues] = useState<string[]>([]);

  // Report state
  const [activeTab, setActiveTab] = useState<"odds" | "data" | "comparison" | "report">("odds");
  const [reportData, setReportData] = useState<{
    date: string;
    mode?: string;
    latestAnalysisAt?: string | null;
    rows: ReportRowData[];
    summary: {
      total: number; correct: number; wrong: number; accuracy: string;
      totalTotal?: number; totalCorrect?: number; totalWrong?: number; totalAccuracy?: string;
      markets?: {
        handicap: SettlementSummary;
        total: SettlementSummary;
      };
      highConf?: { total: number; correct: number; accuracy: string };
      midConf?: { total: number; correct: number; accuracy: string };
      lowConf?: { total: number; correct: number; accuracy: string };
      unverified?: number;
    };
  } | null>(null);
  const [reportDates, setReportDates] = useState<string[]>([]);
  const [selectedReportDate, setSelectedReportDate] = useState("");
  const [reportTrend, setReportTrend] = useState<Array<{ date: string; total: number; correct: number; accuracy: number; totalCorrect: number; totalAccuracy: string }>>([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportExpandedCompanies, setReportExpandedCompanies] = useState<Set<string>>(new Set());
  const [reportExpandedCrown, setReportExpandedCrown] = useState<Set<string>>(new Set());

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const alertsEndRef = useRef<HTMLDivElement>(null);
  const alertConfigsRef = useRef(alertConfigs);
  const oddsSnapshotsRef = useRef(oddsSnapshots);
  const soundEnabledRef = useRef(soundEnabled);
  const pinnedMatchesRef = useRef(pinnedMatches);

  // Keep refs in sync
  useEffect(() => {
    alertConfigsRef.current = alertConfigs;
  }, [alertConfigs]);
  useEffect(() => {
    oddsSnapshotsRef.current = oddsSnapshots;
  }, [oddsSnapshots]);
  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);
  useEffect(() => {
    pinnedMatchesRef.current = pinnedMatches;
  }, [pinnedMatches]);

  // --- Load pinned & notes from localStorage on mount ---
  const [lsLoaded, setLsLoaded] = useState(false);

  // --- Load pasted JSON from server on mount ---
  useEffect(() => {
    const ids = loadFromLS<string[]>(LS_PINNED_IDS_KEY, []);
    setPinnedMatches(new Set(ids));
    const infoArr = loadFromLS<[string, PinnedMatchInfo][]>(LS_PINNED_INFO_KEY, []);
    setPinnedMatchInfo(new Map(infoArr));
    const notesArr = loadFromLS<[string, MatchNotes][]>(LS_NOTES_KEY, []);
    setNotes(new Map(notesArr));
    setLsLoaded(true);

    // Load prediction JSON from server
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    setSelectedPredDate(today);
    fetch(`/api/prediction?date=${today}`)
      .then((res) => res.json())
      .then((json) => {
        if (json.data) setSavedJson(json.data);
      })
      .catch(() => {});
    fetch("/api/prediction")
      .then((res) => res.json())
      .then((json) => {
        if (json.dates) setPredictionDates(json.dates.map((d: { date_key: string }) => d.date_key));
      })
      .catch(() => {});

    // Load user focused leagues whitelist from DB
    fetch("/api/user-focused-leagues")
      .then((res) => res.json())
      .then((json) => {
        if (json.success && json.leagues && json.leagues.length > 0) {
          setUserFocusedLeagues(new Set(json.leagues));
        }
      })
      .catch(() => {});
  }, []);

  // --- Auto-load prediction data when selected date changes ---
  const loadPredictionByDate = useCallback(async (dateKey: string) => {
    if (!dateKey || dateKey.length !== 8) return;
    try {
      const res = await fetch(`/api/prediction?date=${dateKey}`);
      const json = await res.json();
      if (json.data) {
        setSavedJson(json.data);
      } else {
        setSavedJson("");
      }
    } catch {
      // ignore
    }
  }, []);

  // --- Save pinned IDs & info to localStorage (only after initial load) ---
  useEffect(() => {
    if (lsLoaded) {
      saveToLS(LS_PINNED_IDS_KEY, [...pinnedMatches]);
    }
  }, [pinnedMatches, lsLoaded]);
  useEffect(() => {
    if (lsLoaded) {
      saveToLS(LS_PINNED_INFO_KEY, [...pinnedMatchInfo.entries()]);
    }
  }, [pinnedMatchInfo, lsLoaded]);

  // --- Save notes to localStorage ---
  useEffect(() => {
    if (lsLoaded) {
      saveToLS(LS_NOTES_KEY, [...notes.entries()]);
    }
  }, [notes, lsLoaded]);

  // --- Save prediction JSON to server (only on explicit user action, not auto-load) ---
  const savePredictionToServer = useCallback(async (data: string, dateKey: string) => {
    try {
      await fetch("/api/prediction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, date: dateKey }),
      });
      // Refresh date list after save
      const res = await fetch("/api/prediction");
      const json = await res.json();
      if (json.dates) setPredictionDates(json.dates.map((d: { date_key: string }) => d.date_key));
    } catch {
      // ignore
    }
  }, []);

  // --- Fetch URL and extract JSON ---
  const fetchUrlAndExtract = useCallback(async () => {
    if (!fetchUrlInput.trim()) return;
    setFetchLoading(true);
    setFetchError("");
    try {
      const res = await fetch("/api/fetch-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: fetchUrlInput.trim() }),
      });
      const json = await res.json();
      // Auto-detect date from URL (available in both success and error responses)
      if (json.detectedDate && !selectedPredDate) {
        setSelectedPredDate(json.detectedDate);
      }
      if (json.success && json.extractedJson) {
        setPastedJson(json.extractedJson);
      } else {
        // No JSON found
        if (json.error) {
          setFetchError(json.error);
        } else if (/coze\.cn\/s\//.test(fetchUrlInput)) {
          setFetchError("Coze分享链接的签名已过期，服务端无法直接获取。请在浏览器中打开链接，复制JSON内容后粘贴到下方。");
        } else {
          setFetchError("未能从页面中提取到 JSON 数据，请检查链接内容");
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "网络错误";
      setFetchError(msg);
    } finally {
      setFetchLoading(false);
    }
  }, [fetchUrlInput, selectedPredDate]);

  // --- Check alerts (uses refs to avoid dependency cycles) ---
  const checkAlerts = useCallback((newMatches: MatchData[]) => {
    const currentConfigs = alertConfigsRef.current;
    const currentSnapshots = oddsSnapshotsRef.current;
    const currentSound = soundEnabledRef.current;
    const newAlerts: AlertItem[] = [];

    for (const config of currentConfigs.values()) {
      const match = newMatches.find((m) => m.id === config.matchId);
      const snapshot = currentSnapshots.get(config.matchId);
      if (!match || !snapshot) continue;

      const handicapChange = match.handicapRaw - snapshot.handicapRaw;
      const totalLineChange = match.totalLineRaw - snapshot.totalLineRaw;
      const homeOddsChange =
        parseFloat(match.homeOdds) - parseFloat(snapshot.homeOdds);
      const awayOddsChange =
        parseFloat(match.awayOdds) - parseFloat(snapshot.awayOdds);
      const overOddsChange =
        parseFloat(match.overOdds) - parseFloat(snapshot.overOdds);
      const underOddsChange =
        parseFloat(match.underOdds) - parseFloat(snapshot.underOdds);

      const thresholds: {
        value: number;
        up: string;
        down: string;
        label: string;
      }[] = [
        { value: handicapChange, up: config.handicapUp, down: config.handicapDown, label: "让球" },
        { value: totalLineChange, up: config.totalLineUp, down: config.totalLineDown, label: "大小球" },
        { value: homeOddsChange, up: config.homeOddsUp, down: config.homeOddsDown, label: "主队赔率" },
        { value: awayOddsChange, up: config.awayOddsUp, down: config.awayOddsDown, label: "客队赔率" },
        { value: overOddsChange, up: config.overOddsUp, down: config.overOddsDown, label: "大球赔率" },
        { value: underOddsChange, up: config.underOddsUp, down: config.underOddsDown, label: "小球赔率" },
      ];

      for (const t of thresholds) {
        const upVal = parseFloat(t.up);
        const downVal = parseFloat(t.down);
        if (!isNaN(upVal) && upVal > 0 && t.value >= upVal) {
          newAlerts.push({
            id: `${config.matchId}-${t.label}-up-${Date.now()}`,
            message: `${match.homeTeam} vs ${match.awayTeam} ${t.label} 升了 ${t.value.toFixed(2)}`,
            time: Date.now(),
          });
        }
        if (!isNaN(downVal) && downVal > 0 && t.value <= -downVal) {
          newAlerts.push({
            id: `${config.matchId}-${t.label}-down-${Date.now()}`,
            message: `${match.homeTeam} vs ${match.awayTeam} ${t.label} 降了 ${Math.abs(t.value).toFixed(2)}`,
            time: Date.now(),
          });
        }
      }
    }

    if (newAlerts.length > 0) {
      setAlerts((prev) => [...prev, ...newAlerts]);
      if (currentSound) {
        playAlertSound();
      }
    }
  }, []);

  // --- Fetch data ---
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/odds");
      const json = await res.json();
      if (json.success) {
        const newMatches: MatchData[] = json.data.matches || [];
        const newLeagues: LeagueData[] = json.data.leagues || [];

        checkAlerts(newMatches);

        setOddsSnapshots((prev) => {
          const next = new Map(prev);
          for (const m of newMatches) {
            next.set(m.id, {
              handicapRaw: m.handicapRaw,
              totalLineRaw: m.totalLineRaw,
              homeOdds: m.homeOdds,
              awayOdds: m.awayOdds,
              overOdds: m.overOdds,
              underOdds: m.underOdds,
            });
          }
          return next;
        });

        setMatches(newMatches);
        setLeagues(newLeagues);
        setHotMatchCount(json.data.hotMatchCount || 0);
        setMatchDate(json.data.matchDate || "");
        setLastRefresh(Date.now());
        detailedScheduleRef.current();

        // Update pinned match info for matches still in data
        const currentPinned = pinnedMatchesRef.current;
        setPinnedMatchInfo((prev) => {
          const next = new Map(prev);
          for (const m of newMatches) {
            if (currentPinned.has(m.id)) {
              next.set(m.id, {
                id: m.id,
                league: m.league,
                leagueColor: m.leagueColor,
                time: m.time,
                homeTeam: m.homeTeam,
                awayTeam: m.awayTeam,
                handicap: m.handicap,
                homeOdds: m.homeOdds,
                awayOdds: m.awayOdds,
                totalLine: m.totalLine,
                overOdds: m.overOdds,
                underOdds: m.underOdds,
              });
            }
          }
          return next;
        });
      } else {
        setError(json.error || "获取数据失败");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "网络错误";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [checkAlerts]);

  // --- Auto refresh ---
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    timerRef.current = setInterval(fetchData, refreshInterval * 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refreshInterval, fetchData]);

  // --- Data tab: league filter computed values ---
  // Effective matches & leagues for the data tab based on schedule mode
  // RULE: History/future schedules ONLY show matches from userFocusedLeagues (dynamic from DB)
  // Today's schedule keeps all leagues (user can filter manually)
  const dataTabMatches = useMemo(() => {
    if (dataScheduleMode === "today") return Array.isArray(matches) ? matches : [];
    const sourceMatches = Array.isArray(scheduleMatches) ? scheduleMatches : [];
    // History/future: filter to userFocusedLeagues only
    return sourceMatches.filter(m => userFocusedLeagues.has(m.league));
  }, [dataScheduleMode, matches, scheduleMatches, userFocusedLeagues]);

  const dataTabLeagues = useMemo(() => {
    if (dataScheduleMode === "today") return Array.isArray(leagues) ? leagues : [];
    const sourceLeagues = Array.isArray(scheduleLeagues) ? scheduleLeagues : [];
    // History/future: filter to userFocusedLeagues only
    return sourceLeagues.filter(l => userFocusedLeagues.has(l.name));
  }, [dataScheduleMode, leagues, scheduleLeagues, userFocusedLeagues]);

  // Group leagues by initial letter
  const leagueLetterGroups = useMemo(() => {
    const groups: Record<string, LeagueData[]> = {};
    for (const league of dataTabLeagues) {
      const initial = getLeagueInitial(league.name);
      if (!groups[initial]) groups[initial] = [];
      groups[initial].push(league);
    }
    // Sort each group by count desc
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => b.count - a.count);
    }
    return groups;
  }, [dataTabLeagues]);

  // Hot leagues: based on B[j][10] flag from website data (same logic as original site)
  const hotLeagues = useMemo(() => {
    return dataTabLeagues.filter(l => l.isHot);
  }, [dataTabLeagues]);

  // Total hot match count (from API, includes all match states)
  const totalHotMatchCount = dataScheduleMode === "today" ? hotMatchCount : scheduleHotMatchCount;

  // Available letters for the index bar
  const availableLetters = useMemo(() => {
    const letters = new Set<string>();
    for (const league of dataTabLeagues) {
      letters.add(getLeagueInitial(league.name));
    }
    return Array.from(letters).sort();
  }, [dataTabLeagues]);

  // Count of selected matches (sum of counts for selected leagues)
  const dataSelectedMatchCount = useMemo(() => {
    if (dataSelectedLeagues.size === 0) {
      // All selected = sum of all league counts
      return dataTabLeagues.reduce((sum, l) => sum + l.count, 0);
    }
    if (dataSelectedLeagues.has("__NONE__")) return 0;
    return dataTabLeagues.filter(l => isLeagueSelected(l.name, dataSelectedLeagues)).reduce((sum, l) => sum + l.count, 0);
  }, [dataSelectedLeagues, dataTabLeagues]);

  // Total match count
  const dataTotalMatchCount = useMemo(() => {
    return dataTabLeagues.reduce((sum, l) => sum + l.count, 0);
  }, [dataTabLeagues]);

  // --- Data tab: fetch company odds from API ---
  const [dataLoading, setDataLoading] = useState(false);
  // Track which matches are being fetched (matchId -> true)
  const [fetchingMatches, setFetchingMatches] = useState<Set<string>>(new Set());
  // Track which matches have been fetched (have odds data)
  const [fetchedMatches, setFetchedMatches] = useState<Set<string>>(new Set());
  // Track which matches failed to fetch
  const [failedMatches, setFailedMatches] = useState<Map<string, string>>(new Map());
  // Track auto-fetch state
  const [autoFetchRunning, setAutoFetchRunning] = useState(false);
  const autoFetchAbortRef = useRef(false);
  // Batch fetch progress
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; phase: string } | null>(null);
  // Supplement fetch missing counts (refreshed on demand)
  const [missingCounts, setMissingCounts] = useState({ odds: 0, opentimes: 0, crownOpen: 0, crownFinal: 0 });
  // AI analysis state
  const [analyzingMatchId, setAnalyzingMatchId] = useState<string | null>(null);
  const [aiConcurrency, setAiConcurrency] = useState(3);
  const [analysisResults, setAnalysisResults] = useState<Map<string, AnalysisResultData>>(new Map());
  const [analysisExpanded, setAnalysisExpanded] = useState<string | null>(null);
  const [verifyingMarketKey, setVerifyingMarketKey] = useState<string | null>(null);
  // Ref for currentDbDate to avoid ordering issues with useCallback
  const currentDbDateRef = useRef("");
  // Load analysis detail on-demand when user expands
  const loadAnalysisDetail = useCallback(async (matchId: string) => {
    const current = analysisResults.get(matchId);
    // Only fetch if indicators are empty (light list mode data)
    if (!current || current.indicators.length > 0) return;
    try {
      const date = currentDbDateRef.current;
      if (!date) return;
      const res = await fetch(`/api/analysis?date=${date}&detail=1&matchId=${matchId}`);
      const json = await res.json();
      if (json.success && json.prediction) {
        setAnalysisResults(prev => {
          const next = new Map(prev);
          next.set(matchId, json.prediction as AnalysisResultData);
          return next;
        });
      }
    } catch {
      // Non-critical
    }
  }, [analysisResults]);
  // Chat state
  const [chatOpen, setChatOpen] = useState<string | null>(null); // matchId of open chat
  const [chatMessages, setChatMessages] = useState<Map<string, { role: "user" | "assistant"; content: string }[]>>(new Map());
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);
  // Evolution stats
  const [evolutionStats, setEvolutionStats] = useState<{ totalPredictions: number; correctPredictions: number; overallAccuracy: string; topPatterns: { key: string; description: string; hitRate: string; total: number }[] } | null>(null);

  // --- Get current effective date for DB queries (YYYYMMDD format) ---
  const currentDbDate = useMemo(() => {
    if (dataScheduleMode === "today") {
      if (!matchDate) return "";
      // matchDate is like "04月23日", convert to YYYYMMDD
      const m = matchDate.match(/(\d{1,2})月(\d{1,2})日/);
      if (m) {
        const now = new Date();
        const month = m[1].padStart(2, "0");
        const day = m[2].padStart(2, "0");
        return `${now.getFullYear()}${month}${day}`;
      }
      return matchDate;
    }
    if (dataDate) return dataDate.replace(/-/g, "");
    return "";
  }, [dataScheduleMode, matchDate, dataDate]);
  useEffect(() => { currentDbDateRef.current = currentDbDate; }, [currentDbDate]);

  useEffect(() => {
    oddsGenerationRef.current += 1;
    for (const queued of oddsRefreshQueueRef.current) queued.value.resolvers.forEach(resolve => resolve(false));
    oddsRefreshQueueRef.current = [];
    latestOddsRequestRef.current = new Map();
    oddsSourceMetaRef.current = new Map();
    matchRefreshVersionRef.current = new Map();
    matchPersistedVersionRef.current = new Map();
    dbCompanyOddsMapRef.current = new Map();
    setDbCompanyOddsMap(new Map());
    setFetchedMatches(new Set());
    setOddsQueueStatus(previous => ({ ...previous, queued: 0 }));
  }, [dataScheduleMode, currentDbDate]);

  // --- DB load readiness tracking ---
  // All automated tasks must wait for DB loads to complete before running,
  // otherwise they may duplicate work (e.g., re-analyzing matches already in DB)
  const dbOddsLoadedRef = useRef<Set<string>>(new Set()); // dates whose odds have been loaded
  const dbPredictionsLoadedRef = useRef<Set<string>>(new Set()); // dates whose predictions have been loaded

  // Check if DB data is ready for a given date
  const isDbLoadReady = useCallback((date: string) => {
    return dbOddsLoadedRef.current.has(date) && dbPredictionsLoadedRef.current.has(date);
  }, []);

  // --- Load odds from DB for a given date ---
  const loadOddsFromDb = useCallback(async (date: string) => {
    if (!date) return;
    const requestStartVersion = oddsRefreshSequenceRef.current;
    const loadGeneration = oddsGenerationRef.current;
    try {
      const res = await fetch(`/api/data/odds-db?date=${date}&slim=1`);
      const json = await res.json();
      if (json.success && json.data) {
        const { matchIds, oddsMap, oddsMetaMap = {}, crownLiveOddsMap, crown12OddsMap } = json.data;
        if (loadGeneration !== oddsGenerationRef.current) return;
        const newMap = new Map<string, CompanyOddsData>();
        const newFetched = new Set<string>();
        for (const mid of matchIds) {
          const oddsData = oddsMap[mid];
          if (oddsData && canApplyDatabaseObservation(oddsMetaMap[mid]?.sourceObservedAt, oddsSourceMetaRef.current.get(mid)?.sourceObservedAt)) {
            const parsedOddsData = oddsData as CompanyOddsData;
            newMap.set(mid, parsedOddsData);
            if (Array.isArray(parsedOddsData.companies) && parsedOddsData.companies.length > 0) {
              newFetched.add(mid);
            }
          }
        }
        setDbCompanyOddsMap(prev => {
          const next = new Map(prev);
          for (const [matchId, oddsData] of newMap) {
            if (canApplyDatabaseOdds(requestStartVersion, matchRefreshVersionRef.current.get(matchId), matchPersistedVersionRef.current.get(matchId))) {
              next.set(matchId, oddsData);
              oddsSourceMetaRef.current.set(matchId, {
                source: oddsMetaMap[matchId]?.source ?? null,
                sourceObservedAt: oddsMetaMap[matchId]?.sourceObservedAt ?? null,
                writeToken: oddsMetaMap[matchId]?.writeToken ?? null,
              });
            }
          }
          dbCompanyOddsMapRef.current = next;
          return next;
        });
        setFetchedMatches(prev => {
          const next = new Set(prev);
          for (const matchId of newFetched) {
            if (canApplyDatabaseOdds(requestStartVersion, matchRefreshVersionRef.current.get(matchId), matchPersistedVersionRef.current.get(matchId))) {
              next.add(matchId);
            }
          }
          return next;
        });
        // Store crown live odds from DB
        if (crownLiveOddsMap && Object.keys(crownLiveOddsMap).length > 0) {
          setCrownLiveOddsFromDb(prev => {
            const next = new Map(prev);
            for (const [mid, data] of Object.entries(crownLiveOddsMap)) {
              if (!canApplyDatabaseOdds(requestStartVersion, matchRefreshVersionRef.current.get(mid), matchPersistedVersionRef.current.get(mid))) continue;
              next.set(mid, data as {
                handicapHome?: string | null;
                handicapLine?: string | null;
                handicapAway?: string | null;
                totalOver?: string | null;
                totalLine?: string | null;
                totalUnder?: string | null;
              });
            }
            return next;
          });
        }
        // Store crown latest odds from DB (repurposed as "新数据")
        if (crown12OddsMap && Object.keys(crown12OddsMap).length > 0) {
          setCrown12OddsFromDb(prev => {
            const next = new Map(prev);
            for (const [mid, data] of Object.entries(crown12OddsMap)) {
              if (!canApplyDatabaseOdds(requestStartVersion, matchRefreshVersionRef.current.get(mid), matchPersistedVersionRef.current.get(mid))) continue;
              next.set(mid, data as {
                handicapHome?: string | null;
                handicapLine?: string | null;
                handicapAway?: string | null;
                totalOver?: string | null;
                totalLine?: string | null;
                totalUnder?: string | null;
              });
            }
            return next;
          });
        }
        dbOddsLoadedRef.current.add(date);
      }
    } catch (err) {
      console.error("[DataTab] Load from DB error:", err);
    }
  }, []);

  // Load existing AI predictions from DB for a date
  const loadPredictionsFromDb = useCallback(async (date: string) => {
    if (!date) return;
    try {
      const res = await fetch(`/api/analysis?date=${date}`);
      const json = await res.json();
      if (json.success && json.predictions) {
        const newMap = new Map<string, AnalysisResultData>();
        for (const [mid, pred] of Object.entries(json.predictions)) {
          newMap.set(mid, pred as AnalysisResultData);
        }
        console.log(`[loadPredictionsFromDb] date=${date}, loaded ${newMap.size} predictions from DB`);
        if (newMap.size > 0) {
          // Direct set instead of merge to avoid Map clone
          setAnalysisResults(prev => {
            const next = new Map(prev);
            for (const [k, v] of newMap) next.set(k, v);
            return next;
          });
          // Also update ref immediately so automated tasks can use it
          // (state update is async, but ref is synchronous)
          analysisResultsRef.current = new Map(analysisResultsRef.current);
          for (const [k, v] of newMap) analysisResultsRef.current.set(k, v);
        }
      }
    } catch {
      // Non-critical, don't block
    } finally {
      dbPredictionsLoadedRef.current.add(date);
    }
  }, []);

  // --- League selection persistence ---
  const prevSelectedLeaguesRef = useRef<Set<string>>(new Set());

  // --- Load league selections from DB ---
  const leagueLoadingFromDbRef = useRef(false);
  const loadLeagueSelections = useCallback(async (dateKey: string, mode: string) => {
    if (!dateKey) return;
    leagueLoadingFromDbRef.current = true;
    try {
      // 1. Try to load specific selections for this date+mode
      const res = await fetch(`/api/league-selections?date=${dateKey}&mode=${mode}`);
      const json = await res.json();
      let leagues: string[] = [];

      if (json.success && json.leagues && json.leagues.length > 0) {
        // User has customized selections for this specific date+mode
        leagues = json.leagues as string[];
      } else {
        // 2. No specific selections → fall back to DEFAULT leagues
        const defaultRes = await fetch(`/api/league-selections?date=DEFAULT&mode=default`);
        const defaultJson = await defaultRes.json();
        if (defaultJson.success && defaultJson.leagues && defaultJson.leagues.length > 0) {
          leagues = defaultJson.leagues as string[];
        }
      }

      if (leagues.length > 0) {
        const loadedSet = new Set(leagues);
        setDataSelectedLeagues(loadedSet);
        // Update the prev ref so incremental fetch doesn't trigger for loaded leagues
        prevSelectedLeaguesRef.current = loadedSet;
      } else {
        // No defaults either → empty (show all)
        setDataSelectedLeagues(new Set());
        prevSelectedLeaguesRef.current = new Set();
      }
    } catch {
      // Non-critical, don't block
    } finally {
      // Delay clearing the flag so the state update settles before auto-save fires
      setTimeout(() => { leagueLoadingFromDbRef.current = false; }, 100);
    }
  }, []);

  // --- Save league selections to DB (with debounce) ---
  const saveLeagueSelectionsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // --- User focused leagues whitelist management ---
  const openFocusedLeagueDialog = useCallback(() => {
    // Build full league list: current whitelist + all leagues from schedule + all leagues from today
    const allLeagues = new Set<string>();
    userFocusedLeagues.forEach(l => allLeagues.add(l));
    leagues.forEach(l => allLeagues.add(l.name));
    scheduleLeagues.forEach(l => allLeagues.add(l.name));
    const sorted = Array.from(allLeagues).sort();
    setAllKnownLeagues(sorted);
    setFocusedLeagueEditing(new Set(userFocusedLeagues));
    setFocusedLeagueSearch("");
    setFocusedLeagueDialogOpen(true);
  }, [userFocusedLeagues, leagues, scheduleLeagues]);

  const saveFocusedLeagues = useCallback(async () => {
    setFocusedLeagueSaving(true);
    try {
      const leagueArr = Array.from(focusedLeagueEditing).sort();
      const res = await fetch("/api/user-focused-leagues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leagues: leagueArr }),
      });
      const json = await res.json();
      if (json.success) {
        setUserFocusedLeagues(new Set(leagueArr));
        setFocusedLeagueDialogOpen(false);
        // Auto-sync: dataTabMatches auto-recalculates because userFocusedLeagues changed
        // Also trigger report reload if on report tab
        if (activeTab === "report" && selectedReportDate) {
          fetch(`/api/report?date=${selectedReportDate}`)
            .then(r => r.json())
            .then(j => { if (j.success && j.data) setReportData(JSON.parse(j.data.report_content)); })
            .catch(() => {});
        }
      }
    } catch { /* ignore */ }
    setFocusedLeagueSaving(false);
  }, [focusedLeagueEditing, activeTab, selectedReportDate]);

  // Feishu settings functions
  const loadFeishuSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const json = await res.json();
      if (json.success && json.settings) {
        setFeishuWebhookUrl(json.settings.feishu_webhook_url || "");
      }
    } catch { /* ignore */ }
  }, []);

  const saveFeishuSettings = useCallback(async () => {
    setFeishuSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { feishu_webhook_url: feishuWebhookUrl } }),
      });
      const json = await res.json();
      if (json.success) {
        setFeishuDialogOpen(false);
      }
    } catch { /* ignore */ }
    setFeishuSaving(false);
  }, [feishuWebhookUrl]);

  const testFeishuNotification = useCallback(async () => {
    setFeishuTesting(true);
    setFeishuTestResult(null);
    try {
      const res = await fetch("/api/feishu/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg_type: "test" }),
      });
      const json = await res.json();
      setFeishuTestResult(json.success ? "✅ 发送成功！" : `❌ 发送失败: ${json.error || "未知错误"}`);
    } catch (err) {
      setFeishuTestResult(`❌ 请求失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
    setFeishuTesting(false);
  }, []);

  // Load feishu settings on mount
  useEffect(() => { loadFeishuSettings(); }, [loadFeishuSettings]);

  const saveLeagueSelections = useCallback((leagues: Set<string>, dateKey: string, mode: string) => {
    if (!dateKey) return;
    if (saveLeagueSelectionsTimerRef.current) {
      clearTimeout(saveLeagueSelectionsTimerRef.current);
    }
    saveLeagueSelectionsTimerRef.current = setTimeout(async () => {
      try {
        await fetch('/api/league-selections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dateKey,
            mode,
            leagues: Array.from(leagues).filter(l => l !== "__NONE__"),
          }),
        });
      } catch {
        // Non-critical
      }
    }, 800); // 800ms debounce
  }, []);

  // Auto-save league selections when they change (skip during DB load)
  // Don't save empty selections — empty means "show all / not yet loaded",
  // saving it would prevent the DEFAULT fallback from working
  useEffect(() => {
    if (leagueLoadingFromDbRef.current) return;
    if (dataSelectedLeagues.size === 0 || dataSelectedLeagues.has("__NONE__")) return;
    const dateKey = currentDbDateRef.current;
    if (!dateKey) return;
    saveLeagueSelections(dataSelectedLeagues, dateKey, dataScheduleMode);
  }, [dataSelectedLeagues, dataScheduleMode, saveLeagueSelections]);

  // Batch load DB data for a date range — fetches all dates in parallel,
  // then merges results and does a SINGLE setState to avoid cascade re-renders
  const loadOddsFromDbRange = useCallback(async (startDate: string, endDate: string) => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return;
    const requestStartVersion = oddsRefreshSequenceRef.current;
    const loadGeneration = oddsGenerationRef.current;

    const dates: string[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
    }

    // Fetch all dates in parallel (with concurrency limit to avoid overwhelming browser)
    const allResults: Array<{
      date: string;
      matchIds: string[];
      oddsMap: Record<string, CompanyOddsData>;
      oddsMetaMap: Record<string, OddsSourceMeta>;
      crownLiveOddsMap: Record<string, Record<string, unknown>>;
      crown12OddsMap: Record<string, Record<string, unknown>>;
    }> = [];

    const batchSize = 3; // 3 concurrent fetches
    for (let i = 0; i < dates.length; i += batchSize) {
      const batch = dates.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (dateStr) => {
          const res = await fetch(`/api/data/odds-db?date=${dateStr}&slim=1`);
          const json = await res.json();
          if (json.success && json.data) {
            return {
              date: dateStr,
              ...json.data,
            } as {
              date: string;
              matchIds: string[];
              oddsMap: Record<string, CompanyOddsData>;
              oddsMetaMap: Record<string, OddsSourceMeta>;
              crownLiveOddsMap: Record<string, Record<string, unknown>>;
              crown12OddsMap: Record<string, Record<string, unknown>>;
            };
          }
          return null;
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          allResults.push(r.value);
        }
      }
    }

    // Merge all results into single updates
    const mergedOddsMap = new Map<string, CompanyOddsData>();
    const mergedMetaMap = new Map<string, OddsSourceMeta>();
    const mergedFetched = new Set<string>();
    const mergedCrownLive = new Map<string, {
      handicapHome?: string | null;
      handicapLine?: string | null;
      handicapAway?: string | null;
      totalOver?: string | null;
      totalLine?: string | null;
      totalUnder?: string | null;
    }>();
    const mergedCrown12 = new Map<string, {
      handicapHome?: string | null;
      handicapLine?: string | null;
      handicapAway?: string | null;
      totalOver?: string | null;
      totalLine?: string | null;
      totalUnder?: string | null;
    }>();

    for (const result of allResults) {
      if (loadGeneration !== oddsGenerationRef.current) return;
      for (const mid of result.matchIds) {
        const oddsData = result.oddsMap[mid];
        const dbMeta = result.oddsMetaMap?.[mid];
        if (oddsData && canApplyDatabaseObservation(dbMeta?.sourceObservedAt, oddsSourceMetaRef.current.get(mid)?.sourceObservedAt)) {
          const parsedOddsData = oddsData as CompanyOddsData;
          mergedOddsMap.set(mid, parsedOddsData);
          mergedMetaMap.set(mid, dbMeta || { source: null, sourceObservedAt: null });
          if (Array.isArray(parsedOddsData.companies) && parsedOddsData.companies.length > 0) {
            mergedFetched.add(mid);
          }
        }
      }
      if (result.crownLiveOddsMap) {
        for (const [mid, data] of Object.entries(result.crownLiveOddsMap)) {
          mergedCrownLive.set(mid, data as {
            handicapHome?: string | null;
            handicapLine?: string | null;
            handicapAway?: string | null;
            totalOver?: string | null;
            totalLine?: string | null;
            totalUnder?: string | null;
          });
        }
      }
      if (result.crown12OddsMap) {
        for (const [mid, data] of Object.entries(result.crown12OddsMap)) {
          mergedCrown12.set(mid, data as {
            handicapHome?: string | null;
            handicapLine?: string | null;
            handicapAway?: string | null;
            totalOver?: string | null;
            totalLine?: string | null;
            totalUnder?: string | null;
          });
        }
      }
    }

    // Single batch setState — React batches these automatically in React 18+
    setDbCompanyOddsMap(prev => {
      const next = new Map(prev);
      for (const [matchId, oddsData] of mergedOddsMap) {
        if (canApplyDatabaseOdds(requestStartVersion, matchRefreshVersionRef.current.get(matchId), matchPersistedVersionRef.current.get(matchId))) {
          next.set(matchId, oddsData);
          oddsSourceMetaRef.current.set(matchId, mergedMetaMap.get(matchId) || { source: null, sourceObservedAt: null });
        }
      }
      dbCompanyOddsMapRef.current = next;
      return next;
    });
    setFetchedMatches(prev => {
      const next = new Set(prev);
      for (const matchId of mergedFetched) {
        if (canApplyDatabaseOdds(requestStartVersion, matchRefreshVersionRef.current.get(matchId), matchPersistedVersionRef.current.get(matchId))) {
          next.add(matchId);
        }
      }
      return next;
    });
    if (mergedCrownLive.size > 0) {
      setCrownLiveOddsFromDb(prev => {
        const next = new Map(prev);
        for (const [mid, data] of mergedCrownLive) {
          if (canApplyDatabaseOdds(requestStartVersion, matchRefreshVersionRef.current.get(mid), matchPersistedVersionRef.current.get(mid))) {
            next.set(mid, data);
          }
        }
        return next;
      });
    }
    if (mergedCrown12.size > 0) {
      setCrown12OddsFromDb(prev => {
        const next = new Map(prev);
        for (const [mid, data] of mergedCrown12) {
          if (canApplyDatabaseOdds(requestStartVersion, matchRefreshVersionRef.current.get(mid), matchPersistedVersionRef.current.get(mid))) {
            next.set(mid, data);
          }
        }
        return next;
      });
    }
    // Only successful date responses become ready.
    for (const result of allResults) {
      dbOddsLoadedRef.current.add(result.date);
    }
  }, []);

  // Fetch one match through the global serialized coordinator. Request identity is
  // assigned before I/O so a late response cannot overwrite a newer observation.
  const fetchSingleMatchOddsCore = useCallback(async (matchId: string, generation: number): Promise<boolean> => {
    const requestId = ++oddsRefreshSequenceRef.current;
    latestOddsRequestRef.current.set(matchId, requestId);
    matchRefreshVersionRef.current.set(matchId, requestId);
    setFetchingMatches(prev => new Set(prev).add(matchId));
    try {
      const res = await fetch(`/api/data/match/${matchId}`);
      const json = await res.json();
      if (!res.ok || !json.success || !json.data) {
        throw new Error(json.error || json.detail || "无赔率数据");
      }
      if (!isLatestRefreshResponse({
        request: requestId,
        latestRequest: latestOddsRequestRef.current.get(matchId) ?? -1,
        generation,
        latestGeneration: oddsGenerationRef.current,
      })) return false;

      const item = json.data as ApiMatchOddsResponse;
      const source = typeof json.source === "string" && json.source ? json.source : "titan-analysis-odds";
      const sourceObservedAt = typeof json.sourceObservedAt === "string" ? json.sourceObservedAt : new Date().toISOString();
      const existingEntry = dbCompanyOddsMapRef.current.get(matchId);
      const existingOpenTimes = new Map<string, string>();
      if (existingEntry) {
        for (const company of existingEntry.companies || []) {
          if (company.openTime) existingOpenTimes.set(company.companyId, company.openTime);
        }
        if (existingEntry.openTime) existingOpenTimes.set("3", existingEntry.openTime);
      }
      const newEntry: CompanyOddsData = {
        matchId: item.matchId,
        openTime: item.openTime || existingOpenTimes.get("3") || "",
        companies: (Array.isArray(item.companies) ? item.companies : []).map((c: ApiCompanyOdds) => ({
          companyId: String(c.companyId), companyName: c.companyName,
          openTime: c.openTime || existingOpenTimes.get(String(c.companyId)) || "",
          ftHandicapHome: c.ftHandicapHome || "", ftHandicapLine: c.ftHandicapLine || "", ftHandicapAway: c.ftHandicapAway || "",
          ftHandicapHomeLive: c.ftHandicapHomeLive || "", ftHandicapLineLive: c.ftHandicapLineLive || "", ftHandicapAwayLive: c.ftHandicapAwayLive || "",
          euroHome: c.euroHome || "", euroDraw: c.euroDraw || "", euroAway: c.euroAway || "",
          euroHomeLive: c.euroHomeLive || "", euroDrawLive: c.euroDrawLive || "", euroAwayLive: c.euroAwayLive || "",
          euroAsianHome: c.euroAsianHome || "", euroAsianLine: c.euroAsianLine || "", euroAsianAway: c.euroAsianAway || "",
          ftTotalOver: c.ftTotalOver || "", ftTotalLine: c.ftTotalLine || "", ftTotalUnder: c.ftTotalUnder || "",
          ftTotalOverLive: c.ftTotalOverLive || "", ftTotalLineLive: c.ftTotalLineLive || "", ftTotalUnderLive: c.ftTotalUnderLive || "",
        })),
      };

      oddsSourceMetaRef.current.set(matchId, { source, sourceObservedAt });
      setDbCompanyOddsMap(() => {
        const next = new Map(dbCompanyOddsMapRef.current);
        next.set(matchId, newEntry);
        dbCompanyOddsMapRef.current = next;
        return next;
      });
      setFetchedMatches(prev => new Set(prev).add(matchId));
      setFailedMatches(prev => { const next = new Map(prev); next.delete(matchId); return next; });

      const matchData = matchesRef.current.find(m => m.id === matchId);
      let matchDateForSave = matchData?.matchDate || currentDbDateRef.current;
      const cnMatch = matchDateForSave?.match(/(\d{1,2})月(\d{1,2})日/);
      if (cnMatch) {
        const now = new Date();
        matchDateForSave = `${now.getFullYear()}${cnMatch[1].padStart(2, "0")}${cnMatch[2].padStart(2, "0")}`;
      }
      if (!matchDateForSave) return true;

      const writeToken = `${generation}:${requestId}:${matchId}:${Date.now()}`;
      const saveRes = await fetch("/api/data/odds-db", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchId, matchDate: matchDateForSave, companyIds: dataCompanyIds.join(","),
          oddsData: newEntry, source, sourceObservedAt, writeToken,
        }),
      });
      const saved = await saveRes.json().catch(() => ({}));
      const stillCurrent = isLatestRefreshResponse({
        request: requestId,
        latestRequest: latestOddsRequestRef.current.get(matchId) ?? -1,
        generation,
        latestGeneration: oddsGenerationRef.current,
      });
      if (saveRes.ok && saved.success && saved.applied === true && stillCurrent) {
        matchPersistedVersionRef.current.set(matchId, requestId);
        oddsSourceMetaRef.current.set(matchId, { source, sourceObservedAt: saved.sourceObservedAt || sourceObservedAt, writeToken });
      }
      return stillCurrent;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "抓取失败";
      setFailedMatches(prev => { const next = new Map(prev); next.set(matchId, errMsg); return next; });
      return false;
    } finally {
      setFetchingMatches(prev => { const next = new Set(prev); next.delete(matchId); return next; });
    }
  }, [dataCompanyIds]);
  oddsRefreshCoreRef.current = fetchSingleMatchOddsCore;

  const fetchSingleMatchOdds = useCallback((matchId: string) => {
    const priority = pinnedMatchesRef.current.has(matchId) || expandedCrown.has(matchId) || expandedCompanies.has(matchId) ? 100 : 10;
    return enqueueOddsRefresh(matchId, priority, false);
  }, [enqueueOddsRefresh, expandedCrown, expandedCompanies]);
  const fetchSingleMatchOddsRef = useRef(fetchSingleMatchOdds);
  fetchSingleMatchOddsRef.current = fetchSingleMatchOdds;

  // Refresh missing counts for supplement fetch dropdown (must be before fetchAllVisibleOdds)
  const refreshMissingCounts = useCallback(() => {
    const matchFilter = (m: MatchData) => {
      if (dataSelectedLeagues.size > 0 && !isLeagueSelected(m.league, dataSelectedLeagues)) return false;
      if (dataScheduleMode !== "history" && m.state !== "0") return false;
      return true;
    };
    const visibleMatches = dataTabMatches.filter(matchFilter);
    const oddsMissing = visibleMatches.filter(m => !fetchedMatches.has(m.id)).length;
    const opentimesMissing = visibleMatches.filter(m => {
      const cod = dbCompanyOddsMap.get(m.id);
      const companies = Array.isArray(cod?.companies) ? cod.companies : [];
      return fetchedMatches.has(m.id) && (!cod || companies.every(c => !c.openTime));
    }).length;
    const crownOpenMissing = visibleMatches.filter(m => {
      return fetchedMatches.has(m.id) && !crown12OddsFromDb.has(m.id);
    }).length;
    // Terminal odds missing: matches that should have crownLiveOdds but don't
    const crownFinalMissing = visibleMatches.filter(m => {
      if (!fetchedMatches.has(m.id)) return false;
      // History mode: all matches should have terminal odds
      // Today mode: only in-progress/finished (state !== "0")
      if (dataScheduleMode === "history" || (dataScheduleMode === "today" && m.state !== "0")) {
        const companies = dbCompanyOddsMap.get(m.id)?.companies || [];
        const crown = companies.find(company => company.companyId === "3");
        return !(crown?.ftHandicapLineLive || crown?.ftTotalLineLive);
      }
      return false;
    }).length;
    setMissingCounts({ odds: oddsMissing, opentimes: opentimesMissing, crownOpen: crownOpenMissing, crownFinal: crownFinalMissing });
  }, [dataTabMatches, dataSelectedLeagues, dataScheduleMode, fetchedMatches, dbCompanyOddsMap, crown12OddsFromDb]);

  // Reset page when filter changes
  useEffect(() => {
    setDataCurrentPage(1);
  }, [dataSelectedLeagues, dataScheduleMode, dataDate, dataDateEnd]);

  // Convert league input text to selected leagues (Chinese name + pinyin matching)
  const leagueInputTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!leagueInputText.trim()) {
      // Empty input = no filter (show all)
      setDataSelectedLeagues(new Set());
      return;
    }

    // Debounce 500ms to avoid rapid re-computation while typing
    if (leagueInputTimeoutRef.current) clearTimeout(leagueInputTimeoutRef.current);
    leagueInputTimeoutRef.current = setTimeout(() => {
      const searchTerms = leagueInputText.split(/[,，;；\s]+/).filter(s => s.trim());
      const matchedLeagues = new Set<string>();

      for (const league of dataTabLeagues) {
        for (const term of searchTerms) {
          if (matchLeague(league.name, term)) {
            matchedLeagues.add(league.name);
            break; // no need to match same league twice
          }
        }
      }

      setDataSelectedLeagues(matchedLeagues);
    }, 500);

    return () => {
      if (leagueInputTimeoutRef.current) clearTimeout(leagueInputTimeoutRef.current);
    };
  }, [leagueInputText, dataTabLeagues]);

  // Auto-refresh missing counts when data changes
  useEffect(() => {
    refreshMissingCounts();
  }, [refreshMissingCounts]);

  // Report data is already summarized against the server-side focused-league set.
  const filteredReportData = useMemo(() => {
    if (!reportData) return null;
    if (userFocusedLeagues.size === 0) return reportData;
    return {
      ...reportData,
      rows: reportData.rows.filter(row => userFocusedLeagues.has(row.league)),
    };
  }, [reportData, userFocusedLeagues]);

  // Pre-compute Data Tab match rows — avoids recalculation on every render
  const dataMatchRows = useMemo(() => {
    const sourceMatches = Array.isArray(dataTabMatches) ? dataTabMatches : [];
    const filtered = sourceMatches.filter(m => {
      if (dataSelectedLeagues.size > 0 && !isLeagueSelected(m.league, dataSelectedLeagues)) return false;
      return true;
    });
    const notStarted: DataMatchRow[] = [];
    const otherStates: DataMatchRow[] = [];
    for (const match of filtered) {
      const oddsEntry = dbCompanyOddsMap.get(match.id);
      const oddsCompanies = Array.isArray(oddsEntry?.companies) ? oddsEntry.companies : [];
      const row: DataMatchRow = {
        match,
        isFetched: fetchedMatches.has(match.id),
        isFetching: fetchingMatches.has(match.id),
        openTime: oddsEntry?.openTime || "",
        companies: oddsCompanies
          .filter(c => dataCompanyIds.includes(c.companyId))
          .sort((a, b) => normalizeOpenTime(a.openTime).localeCompare(normalizeOpenTime(b.openTime))),
        crownFinal: (() => {
          const crown = oddsCompanies.find(c => c.companyId === "3");
          if (crown && (crown.ftHandicapLineLive || crown.ftTotalLineLive)) {
            return {
              handicapHome: crown.ftHandicapHomeLive,
              handicapLine: crown.ftHandicapLineLive,
              handicapAway: crown.ftHandicapAwayLive,
              totalOver: crown.ftTotalOverLive,
              totalLine: crown.ftTotalLineLive,
              totalUnder: crown.ftTotalUnderLive,
            };
          }
          const stored = crownLiveOddsFromDb.get(match.id);
          return stored && (stored.handicapLine || stored.totalLine) ? stored : undefined;
        })(),
        crown12: crown12OddsFromDb.get(match.id),
      };
      if (match.state === "0") {
        notStarted.push(row);
      } else {
        otherStates.push(row);
      }
    }
    // Sort both groups by original website order (orderIndex)
    notStarted.sort((a, b) => a.match.orderIndex - b.match.orderIndex);
    otherStates.sort((a, b) => a.match.orderIndex - b.match.orderIndex);
    return { notStarted, otherStates };
  }, [dataTabMatches, dataSelectedLeagues, fetchedMatches, fetchingMatches, dbCompanyOddsMap, crownLiveOddsFromDb, crown12OddsFromDb, dataCompanyIds]);

  // --- Batch AI analysis for all visible matches ---
  const [batchAIProgress, setBatchAIProgress] = useState({ current: 0, total: 0, matchName: "", succeeded: 0, failed: 0 });
  const batchAIAbortRef = useRef(false);

  // Ref to track analysis results without causing re-creation of callbacks
  const analysisResultsRef = useRef(analysisResults);
  useEffect(() => { analysisResultsRef.current = analysisResults; }, [analysisResults]);

  // Internal analyze without setState - returns null only when an existing result is skipped
  const analyzeSingleMatchCore = useCallback(async (matchId: string, forceReanalyze = false): Promise<AnalysisResultData | null> => {
    if (!forceReanalyze && analysisResultsRef.current.has(matchId)) return null;
    const match = dataTabMatches.find(m => m.id === matchId) || matches.find(m => m.id === matchId);
    if (!match) throw new Error("找不到该赛事");

    let databaseCompanies: Record<string, unknown>[] = [];
    try {
      const dbRes = await fetch(`/api/data/odds-db?date=${currentDbDate}&matchId=${matchId}`);
      const dbJson = await dbRes.json();
      const fullOdds = dbJson.success ? dbJson.data?.oddsMap?.[matchId] : undefined;
      databaseCompanies = Array.isArray(fullOdds?.companies)
        ? fullOdds.companies as Record<string, unknown>[]
        : [];
    } catch {
    }

    const currentOddsData = dbCompanyOddsMapRef.current.get(matchId);
    const memoryCompanies = Array.isArray(currentOddsData?.companies)
      ? currentOddsData.companies.map(company => ({ ...company }))
      : [];
    let companies = mergeAiCompanyOdds(memoryCompanies, databaseCompanies);

    if (companies.length === 0) {
      try {
        await fetchSingleMatchOddsRef.current(matchId);
        const refreshed = dbCompanyOddsMapRef.current.get(matchId);
        const refreshedCompanies = Array.isArray(refreshed?.companies) ? refreshed.companies : [];
        companies = mergeAiCompanyOdds(
          refreshedCompanies.map(company => ({ ...company })),
          [],
        );
      } catch (err) {
        console.warn("[AIAnalysis] Live odds fallback failed:", err);
      }
    }
    if (companies.length === 0) throw new Error("没有可用赔率数据，请先抓取赔率");

    const c12 = crown12OddsFromDb.get(matchId);
    const crown12Handicap = c12?.handicapLine ? { home: c12.handicapHome || "", line: c12.handicapLine, away: c12.handicapAway || "" } : undefined;
    const crown12Total = c12?.totalLine ? { over: c12.totalOver || "", line: c12.totalLine, under: c12.totalUnder || "" } : undefined;

    const crownDbForMatch = dbCompanyOddsMapRef.current.get(matchId);
    const crownCompaniesForMatch = Array.isArray(crownDbForMatch?.companies) ? crownDbForMatch.companies : [];
    const crownCompForMatch = crownCompaniesForMatch.find(c => c.companyId === "3");
    const crownLiveHandicap = dataScheduleMode === "future" && crownCompForMatch?.ftHandicapLineLive ? {
      home: crownCompForMatch.ftHandicapHomeLive || "",
      line: crownCompForMatch.ftHandicapLineLive,
      away: crownCompForMatch.ftHandicapAwayLive || "",
    } : undefined;
    const crownLiveTotal = dataScheduleMode === "future" && crownCompForMatch?.ftTotalLineLive ? {
      over: crownCompForMatch.ftTotalOverLive || "",
      line: crownCompForMatch.ftTotalLineLive,
      under: crownCompForMatch.ftTotalUnderLive || "",
    } : undefined;

    const res = await fetch("/api/analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        matchId,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        league: match.league,
        matchTime: match.time,
        matchDate: currentDbDate,
        scheduleMode: dataScheduleMode,
        companies,
        crown12Handicap,
        crown12Total,
        crownLiveHandicap,
        crownLiveTotal,
      }),
    });

    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error("分析服务返回格式异常");
    }
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error || `AI分析失败（${res.status}）`);
    }

    const d = json.data;
    return {
      matchId,
      homeTeam: d.homeTeam || match.homeTeam,
      awayTeam: d.awayTeam || match.awayTeam,
      league: d.league || match.league,
      matchTime: d.matchTime || match.time,
      matchDate: currentDbDate,
      analyzedAt: d.analyzedAt || null,
      indicators: d.indicators || [],
      newsSummary: d.newsSummary || "",
      handicapTrend: d.llmPrediction?.handicapTrend || d.handicap_trend || d.handicapTrend || "不确定",
      waterDirection: d.llmPrediction?.waterDirection || d.water_direction || d.waterDirection || "不变",
      prediction: d.llmPrediction?.prediction || d.prediction || "中立",
      totalTrend: d.llmPrediction?.totalTrend || d.total_trend || "不变",
      totalPrediction: d.llmPrediction?.totalPrediction || d.total_prediction || "中立",
      totalAction: d.llmPrediction?.totalAction || d.total_action || "",
      confidenceLevel: d.llmPrediction?.confidenceLevel || d.confidence_level || "低",
      accuracy: d.llmPrediction?.accuracy || d.accuracy || "50%",
      strategy: d.llmPrediction?.strategy || d.strategy || "",
      action: d.llmPrediction?.action || d.action || "",
      reasoning: d.llmPrediction?.reasoning || "",
      verification: d.verification,
      probability: d.probability || null,
      settlementEvidence: d.settlementEvidence,
      crown_handicap: d.crown_handicap || "",
      yinghe_handicap: d.yinghe_handicap || "",
      who_open_later: d.who_open_later || "",
    };
  }, [dataTabMatches, matches, crown12OddsFromDb, currentDbDate, dataScheduleMode]);

  const analyzeSingleMatch = useCallback(async (matchId: string, forceReanalyze = false) => {
    if (analyzingMatchId) return;
    const match = dataTabMatches.find(item => item.id === matchId) || matches.find(item => item.id === matchId);
    const toastId = toast.loading("AI 正在分析赛事", {
      description: match ? `${match.homeTeam} vs ${match.awayTeam}` : "正在准备赔率与赛事数据",
    });
    setAnalyzingMatchId(matchId);
    try {
      const result = await analyzeSingleMatchCore(matchId, forceReanalyze);
      if (!result) {
        toast.info("已有最新分析结果", { id: toastId, description: "无需重复分析" });
        return;
      }
      setAnalysisResults(prev => {
        const next = new Map(prev).set(matchId, result);
        analysisResultsRef.current = next;
        return next;
      });
      setAnalysisExpanded(matchId);
      toast.success("AI 分析完成", {
        id: toastId,
        description: `${result.homeTeam} vs ${result.awayTeam} · ${formatAnalysisTime(result.analyzedAt)}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "AI分析失败";
      toast.error("AI 分析失败", {
        id: toastId,
        description: `${message}。可稍后重新点击 AI 分析。`,
        duration: 8000,
      });
    } finally {
      setAnalyzingMatchId(null);
    }
  }, [analyzeSingleMatchCore, analyzingMatchId, dataTabMatches, matches]);

  const batchAnalyzeAll = useCallback(async (matchList: { id: string; homeTeam: string; awayTeam: string }[], forceReanalyze = false) => {
    if (matchList.length === 0) return;
    batchAIAbortRef.current = false;
    const batchToastId = toast.loading("批量 AI 分析进行中", {
      description: `0/${matchList.length} · 正在准备赛事数据`,
    });
    setBatchAIProgress({ current: 0, total: matchList.length, matchName: `${matchList[0].homeTeam} vs ${matchList[0].awayTeam}`, succeeded: 0, failed: 0 });

    const concurrency = Math.max(1, Math.min(8, aiConcurrency));
    const flushSize = 5;
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    let batchAccum = new Map<string, AnalysisResultData>();

    const flushBatch = () => {
      if (batchAccum.size > 0) {
        const toFlush = batchAccum;
        batchAccum = new Map();
        setAnalysisResults(prev => {
          const next = new Map(prev);
          toFlush.forEach((v, k) => next.set(k, v));
          analysisResultsRef.current = next;
          return next;
        });
      }
    };

    for (let i = 0; i < matchList.length; i += concurrency) {
      if (batchAIAbortRef.current) break;
      const batch = matchList.slice(i, i + concurrency);
      await Promise.allSettled(batch.map(async (m) => {
        if (batchAIAbortRef.current) return;
        setBatchAIProgress(prev => ({ ...prev, matchName: `${m.homeTeam} vs ${m.awayTeam}` }));
        try {
          const result = await analyzeSingleMatchCore(m.id, forceReanalyze);
          if (result) {
            succeeded++;
            batchAccum.set(m.id, result);
            if (batchAccum.size >= flushSize) flushBatch();
          }
        } catch (err) {
          failed++;
          console.error(`[AIAnalysis] ${m.homeTeam} vs ${m.awayTeam}:`, err);
        } finally {
          completed++;
          setBatchAIProgress(prev => ({ ...prev, current: completed, matchName: `${m.homeTeam} vs ${m.awayTeam}`, succeeded, failed }));
          toast.loading("批量 AI 分析进行中", {
            id: batchToastId,
            description: `${completed}/${matchList.length} · 成功 ${succeeded} · 失败 ${failed}`,
          });
        }
      }));
      flushBatch();
    }
    flushBatch();

    if (batchAIAbortRef.current) {
      toast.info("已停止批量 AI 分析", { id: batchToastId, description: `已处理 ${completed}/${matchList.length} · 成功 ${succeeded} · 失败 ${failed}` });
    } else if (failed === 0) {
      toast.success("批量 AI 分析完成", { id: batchToastId, description: `已成功分析 ${succeeded} 场赛事` });
    } else if (succeeded > 0) {
      toast.warning("批量 AI 分析部分完成", { id: batchToastId, description: `成功 ${succeeded} · 失败 ${failed}，失败赛事可稍后重试`, duration: 8000 });
    } else {
      toast.error("批量 AI 分析失败", { id: batchToastId, description: `${failed} 场赛事均未完成，请检查分析服务后重试`, duration: 8000 });
    }
    setBatchAIProgress({ current: 0, total: 0, matchName: "", succeeded: 0, failed: 0 });
  }, [analyzeSingleMatchCore, aiConcurrency]);

  const stopBatchAI = useCallback(() => {
    batchAIAbortRef.current = true;
  }, []);

  // --- Manual verification of prediction correctness ---
  const manualVerify = useCallback(async (matchId: string, market: PredictionMarket, isCorrect: boolean | null) => {
    const result = analysisResults.get(matchId);
    const matchDate = result?.matchDate || currentDbDate;
    const marketLabel = market === "handicap" ? "让球" : "进球";
    setVerifyingMarketKey(`${matchId}:${market}`);
    try {
      const res = await fetch("/api/analysis/verify", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId, matchDate, market, isCorrect }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "服务未能保存验证结果");
      }

      setAnalysisResults(prev => {
        const next = new Map(prev);
        const existing = next.get(matchId);
        if (existing) {
          next.set(matchId, {
            ...existing,
            verification: data.markets,
            manualIsCorrect: data.markets?.handicap?.manualIsCorrect ?? null,
            isCorrect: data.markets?.handicap?.effectiveIsCorrect ?? null,
          });
        }
        return next;
      });
      setReportData(prev => {
        if (!prev) return prev;
        const rows = prev.rows.map(row => row.matchId === matchId ? {
          ...row,
          verification: data.markets,
          manualIsCorrect: data.markets?.handicap?.manualIsCorrect ?? null,
          verified: Boolean(
            data.markets?.handicap?.effectiveIsCorrect !== null
            || data.markets?.total?.effectiveIsCorrect !== null,
          ),
          waterResult: data.markets?.handicap?.effectiveIsCorrect === null
            ? null
            : data.markets.handicap.effectiveIsCorrect ? "-" as const : "+" as const,
          totalResult: data.markets?.total?.effectiveIsCorrect === null
            ? null
            : data.markets.total.effectiveIsCorrect ? "-" as const : "+" as const,
        } : row);
        const marketStats = data.stats?.markets as { handicap: SettlementSummary; total: SettlementSummary } | undefined;
        if (!marketStats) return { ...prev, rows };
        const handicapAccuracy = marketStats.handicap.weightedAccuracy;
        const totalAccuracy = marketStats.total.weightedAccuracy;
        return {
          ...prev,
          rows,
          summary: {
            ...prev.summary,
            markets: marketStats,
            total: marketStats.handicap.weightedTotal,
            correct: marketStats.handicap.weightedCorrect,
            wrong: marketStats.handicap.weightedWrong,
            accuracy: handicapAccuracy === null ? "N/A" : (handicapAccuracy * 100).toFixed(1),
            totalTotal: marketStats.total.weightedTotal,
            totalCorrect: marketStats.total.weightedCorrect,
            totalWrong: marketStats.total.weightedWrong,
            totalAccuracy: totalAccuracy === null ? "N/A" : (totalAccuracy * 100).toFixed(1),
          },
        };
      });
      toast.success(isCorrect === null ? `已撤回${marketLabel}人工验证` : `${marketLabel}人工验证已保存`, {
        description: isCorrect === null ? "结果已恢复为自动判定" : `已标记为${isCorrect ? "正确" : "错误"}`,
      });
    } catch (error) {
      console.error("Manual verify failed:", error);
      toast.error(`${marketLabel}手动验证失败`, {
        description: error instanceof Error ? error.message : "网络请求失败，请稍后重试",
        duration: 8000,
      });
    } finally {
      setVerifyingMarketKey(null);
    }
  }, [analysisResults, currentDbDate]);

  // --- Chat with LLM for a specific match ---
  const sendChatMessage = useCallback(async (matchId: string, message: string) => {
    if (!message.trim() || chatStreaming) return;

    // Ensure analysis detail is loaded before chat (light list may have empty indicators)
    await loadAnalysisDetail(matchId);

    const match = dataTabMatches.find(m => m.id === matchId) || matches.find(m => m.id === matchId);
    if (!match) return;

    // Get 皇冠 live odds from DB for chat context (prefer over goalBf3.xml)
    const crownDbChat = dbCompanyOddsMap.get(matchId);
    const crownChatCompanies = Array.isArray(crownDbChat?.companies) ? crownDbChat.companies : [];
    const crownCompChat = crownChatCompanies.find(c => c.companyId === "3");

    // Add user message
    const currentMessages = chatMessages.get(matchId) || [];
    const newMessages = [...currentMessages, { role: "user" as const, content: message.trim() }];
    setChatMessages(prev => new Map(prev).set(matchId, newMessages));
    setChatInput("");
    setChatStreaming(true);

    // Build analysis context from results
    const result = analysisResults.get(matchId);
    const analysisContext = result
      ? `水位预测: ${result.waterDirection} / 方向: ${result.prediction} / 置信度: ${result.confidenceLevel} / 策略: ${result.strategy}\n指标: ${result.indicators.map(i => `${i.name}=${i.signal}(${i.reasoning})`).join(", ")}\n推理: ${result.reasoning}`
      : undefined;

    try {
      const res = await fetch("/api/analysis/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchId,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          league: match.league,
          matchTime: match.time,
          messages: newMessages,
          analysisContext,
          liveHandicap: crownCompChat?.ftHandicapLineLive || match.handicap || "",
          liveHomeOdds: crownCompChat?.ftHandicapHomeLive || match.homeOdds || "",
          liveAwayOdds: crownCompChat?.ftHandicapAwayLive || match.awayOdds || "",
        }),
      });

      if (!res.ok || !res.body) {
        setChatMessages(prev => {
          const updated = new Map(prev);
          updated.set(matchId, [...(updated.get(matchId) || []), { role: "assistant", content: "连接失败" }]);
          return updated;
        });
        return;
      }

      // Stream SSE response
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";

      // Add empty assistant message
      setChatMessages(prev => {
        const updated = new Map(prev);
        updated.set(matchId, [...(updated.get(matchId) || []), { role: "assistant", content: "" }]);
        return updated;
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") break;
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                assistantContent += parsed.content;
                const contentSnapshot = assistantContent;
                setChatMessages(prev => {
                  const updated = new Map(prev);
                  const msgs = updated.get(matchId) || [];
                  msgs[msgs.length - 1] = { role: "assistant", content: contentSnapshot };
                  updated.set(matchId, msgs);
                  return updated;
                });
              }
            } catch {
              // Skip malformed data
            }
          }
        }
      }
    } catch {
      setChatMessages(prev => {
        const updated = new Map(prev);
        updated.set(matchId, [...(updated.get(matchId) || []), { role: "assistant", content: "请求失败" }]);
        return updated;
      });
    } finally {
      setChatStreaming(false);
    }
  }, [chatStreaming, chatMessages, dataTabMatches, matches, analysisResults, loadAnalysisDetail, dbCompanyOddsMap]);

  // --- Load evolution stats ---
  const loadEvolutionStats = useCallback(async () => {
    try {
      const res = await fetch("/api/analysis/learn");
      const json = await res.json();
      if (json.success) {
        setEvolutionStats({
          totalPredictions: json.totalPredictions,
          correctPredictions: json.correctPredictions,
          overallAccuracy: json.overallAccuracy,
          topPatterns: (json.topPatterns || []).map((p: { key: string; description: string; hitRate: string; total: number }) => ({
            key: p.key,
            description: p.description,
            hitRate: p.hitRate,
            total: p.total,
          })),
        });
      }
    } catch {
      // silently fail
    }
  }, []);

  // Load evolution stats on mount
  useEffect(() => {
    loadEvolutionStats();
  }, [loadEvolutionStats]);

  // Batch fetch for visible matches, serialized to protect the Titan source IP.
  const fetchAllVisibleOdds = useCallback(async (matchIds?: string[]) => {
    setDataLoading(true);
    autoFetchAbortRef.current = false;
    try {
      // Determine which matches to fetch
      let targetMatches: MatchData[];
      if (matchIds) {
        targetMatches = dataTabMatches.filter(m => matchIds.includes(m.id));
      } else {
        targetMatches = dataTabMatches
          .filter(m => {
            if (dataSelectedLeagues.size > 0 && !isLeagueSelected(m.league, dataSelectedLeagues)) return false;
            // For history mode: fetch all states; for today/future: only not-started
            if (dataScheduleMode !== "history" && m.state !== "0") return false;
            return true;
          });
      }

      if (targetMatches.length === 0) {
        setDataLoading(false);
        return;
      }

      const concurrency = 1;
      console.log(`[BatchFetch] Refreshing latest odds: ${targetMatches.length} matches, concurrency=${concurrency}`);
      setBatchProgress({ done: 0, total: targetMatches.length, phase: "刷新最新赔率" });

      let completed = 0;
      for (let i = 0; i < targetMatches.length; i += concurrency) {
        if (autoFetchAbortRef.current) break;
        const batch = targetMatches.slice(i, i + concurrency);
        await Promise.allSettled(batch.map(m => fetchSingleMatchOdds(m.id)));
        completed += batch.length;
        setBatchProgress({ done: completed, total: targetMatches.length, phase: "刷新最新赔率" });
        if (i + concurrency < targetMatches.length) {
          await new Promise(r => setTimeout(r, 100));
        }
      }
      setScheduleError("");
      refreshMissingCounts();
    } catch (err) {
      console.error("[DataTab] Fetch all odds error:", err);
    } finally {
      setDataLoading(false);
      setBatchProgress(null);
    }
  }, [dataTabMatches, dataSelectedLeagues, dataScheduleMode, fetchSingleMatchOdds, refreshMissingCounts]);

  // Supplement fetch: fetch specific missing data types for already-fetched matches
  const supplementFetch = useCallback(async (type: "opentimes" | "crownOpen" | "odds" | "crownFinal" | "revalidate") => {
    setDataLoading(true);
    autoFetchAbortRef.current = false;
    try {
      const matchFilter = (m: MatchData) => {
        if (dataSelectedLeagues.size > 0 && !isLeagueSelected(m.league, dataSelectedLeagues)) return false;
        if (dataScheduleMode !== "history" && m.state !== "0") return false;
        return true;
      };

      let toFetch: MatchData[] = [];
      if (type === "opentimes") {
        toFetch = dataTabMatches.filter(matchFilter).filter(m => {
          const cod = dbCompanyOddsMap.get(m.id);
          const companies = Array.isArray(cod?.companies) ? cod.companies : [];
          return fetchedMatches.has(m.id) && (!cod || companies.every(c => !c.openTime));
        });
      } else if (type === "crownOpen") {
        toFetch = dataTabMatches.filter(matchFilter).filter(m => {
          return fetchedMatches.has(m.id) && !crown12OddsFromDb.has(m.id);
        });
      } else if (type === "crownFinal") {
        toFetch = dataTabMatches.filter(matchFilter).filter(m => {
          if (!fetchedMatches.has(m.id)) return false;
          if (dataScheduleMode === "history" || (dataScheduleMode === "today" && m.state !== "0")) {
            const companies = dbCompanyOddsMap.get(m.id)?.companies || [];
            const crown = companies.find(company => company.companyId === "3");
            return !(crown?.ftHandicapLineLive || crown?.ftTotalLineLive);
          }
          return false;
        });
      } else if (type === "odds") {
        toFetch = dataTabMatches.filter(matchFilter).filter(m => !fetchedMatches.has(m.id));
      } else if (type === "revalidate") {
        // 数据校验：重新抓取已有DB数据的赛事，对比并更新
        toFetch = dataTabMatches.filter(matchFilter).filter(m => fetchedMatches.has(m.id));
      }

      if (toFetch.length === 0) {
        setDataLoading(false);
        refreshMissingCounts();
        return;
      }

      const phaseLabel = type === "opentimes" ? "开盘时间" : type === "crownOpen" ? "新数据" : type === "crownFinal" ? "终盘" : type === "revalidate" ? "数据校验" : "赔率";
      console.log(`[SupplementFetch] Starting: ${toFetch.length} matches, type=${type}`);
      setBatchProgress({ done: 0, total: toFetch.length, phase: phaseLabel });

      // Serialize all Titan supplement requests to reduce source-IP blocking.
      const concurrency = 1;
      let completed = 0;

      for (let i = 0; i < toFetch.length; i += concurrency) {
        if (autoFetchAbortRef.current) break;
        const batch = toFetch.slice(i, i + concurrency);

        if (type === "odds" || type === "crownFinal" || type === "revalidate") {
          // Both use /api/data/match/{id} (fast ~0.2s)
          await Promise.allSettled(batch.map(m => fetchSingleMatchOdds(m.id)));
        } else {
          // Fetch open times + crown open data via opentimes API
          await Promise.allSettled(batch.map(async (m) => {
            const supplementGeneration = oddsGenerationRef.current;
            try {
              const cod = dbCompanyOddsMapRef.current.get(m.id);
              const codCompanies = Array.isArray(cod?.companies) ? cod.companies : [];
              const companies = codCompanies.length > 0 ? codCompanies.map(c => c.companyId).join(",") : dataCompanyIds.join(",");
              const includeCrownOpen = type === "crownOpen";
              const res = await runSerializedOddsSourceTask(() => fetch(`/api/data/match/${m.id}/opentimes?companies=${companies}&crownOpen=${includeCrownOpen}`));
              const json = await res.json();
              if (json.success && json.data && supplementGeneration === oddsGenerationRef.current) {
                const latestCod = dbCompanyOddsMapRef.current.get(m.id);
                const latestCompanies = Array.isArray(latestCod?.companies) ? latestCod.companies : [];
                const otMap = new Map<string, string>((json.data as ApiOpenTimeEntry[]).map((e: ApiOpenTimeEntry) => [e.companyId, e.openTime]));
                const openTimesObj: Record<string, string> = {};
                otMap.forEach((v, k) => { openTimesObj[k] = v; });

                if (latestCod) {
                  const updatedEntry: CompanyOddsData = {
                    ...latestCod,
                    openTime: otMap.get("3") || latestCod.openTime,
                    companies: latestCompanies.map(c => ({
                      ...c,
                      openTime: otMap.get(c.companyId) || c.openTime,
                    })),
                  };
                  setDbCompanyOddsMap(() => {
                    const next = new Map(dbCompanyOddsMapRef.current);
                    next.set(m.id, updatedEntry);
                    dbCompanyOddsMapRef.current = next;
                    return next;
                  });
                  const matchData = matchesRef.current.find(mt => mt.id === m.id) || dataTabMatches.find(mt => mt.id === m.id);
                  const matchDateForSave = matchData?.matchDate || currentDbDate;
                  const patchResponse = await fetch("/api/data/odds-db", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ matchId: m.id, matchDate: matchDateForSave, openTimesData: openTimesObj }),
                  });
                  if (!patchResponse.ok) {
                    const patchError = await patchResponse.json().catch(() => ({})) as { error?: string };
                    throw new Error(patchError.error || "开盘时间保存失败");
                  }
                }

                // Process crown open odds if returned
                if (supplementGeneration === oddsGenerationRef.current && json.crownOpen && (json.crownOpen.handicapLine || json.crownOpen.totalLine)) {
                  const co = json.crownOpen as {
                    handicapHome: string;
                    handicapLine: string;
                    handicapAway: string;
                    totalOver: string;
                    totalLine: string;
                    totalUnder: string;
                  };
                  const crownOpenOdds: Record<string, unknown> = {
                    handicapHome: co.handicapHome || null,
                    handicapLine: co.handicapLine || null,
                    handicapAway: co.handicapAway || null,
                    totalOver: co.totalOver || null,
                    totalLine: co.totalLine || null,
                    totalUnder: co.totalUnder || null,
                  };
                  const matchData = matchesRef.current.find(mt => mt.id === m.id) || dataTabMatches.find(mt => mt.id === m.id);
                  const matchDateForSave = matchData?.matchDate || currentDbDate;
                  const patchResponse = await fetch("/api/data/odds-db", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ matchId: m.id, matchDate: matchDateForSave, crown12Odds: crownOpenOdds }),
                  });
                  if (!patchResponse.ok) {
                    const patchError = await patchResponse.json().catch(() => ({})) as { error?: string };
                    throw new Error(patchError.error || "皇冠快照保存失败");
                  }
                  setCrown12OddsFromDb(prev => {
                    const next = new Map(prev);
                    next.set(m.id, crownOpenOdds as { handicapHome?: string; handicapLine?: string; handicapAway?: string; totalOver?: string; totalLine?: string; totalUnder?: string });
                    return next;
                  });
                }
              }
            } catch {
              // individual match fetch failed, continue
            }
          }));
        }

        completed += batch.length;
        setBatchProgress({ done: completed, total: toFetch.length, phase: phaseLabel });
        if (i + concurrency < toFetch.length) {
          await new Promise(r => setTimeout(r, type === "odds" || type === "crownFinal" ? 100 : 200));
        }
      }
      // Refresh counts after completion
      refreshMissingCounts();
    } catch (err) {
      console.error("[SupplementFetch] Error:", err);
    } finally {
      setDataLoading(false);
      setBatchProgress(null);
    }
  }, [dataTabMatches, dataSelectedLeagues, dataScheduleMode, fetchedMatches, dbCompanyOddsMap, crown12OddsFromDb, dataCompanyIds, fetchSingleMatchOdds, currentDbDate, refreshMissingCounts, runSerializedOddsSourceTask]);

  // Abort all ongoing fetches
  const abortFetch = useCallback(() => {
    autoFetchAbortRef.current = true;
    const retained: RefreshQueueItem<OddsRefreshJob>[] = [];
    const removed = oddsRefreshQueueRef.current;
    removed.forEach(item => item.value.resolvers.forEach(resolve => resolve(false)));
    oddsRefreshQueueRef.current = retained;
    setOddsQueueStatus(previous => ({ ...previous, queued: retained.length }));
    setAutoFetchRunning(false);
    setDataLoading(false);
    setBatchProgress(null);
    setScheduleError("");
  }, []);

  // Export data to Excel
  const exportToExcel = useCallback(() => {
    const filtered = dataTabMatches.filter(m => {
      if (dataSelectedLeagues.size > 0 && !isLeagueSelected(m.league, dataSelectedLeagues)) return false;
      return true;
    });
    if (filtered.length === 0) return;

    const isHistory = dataScheduleMode === "history";
    const rows: Record<string, string | number>[] = [];

    for (const match of filtered) {
      const cod = dbCompanyOddsMap.get(match.id);
      const codCompanies = Array.isArray(cod?.companies) ? cod.companies : [];
      const crownFinal = (() => {
        const crown = codCompanies.find(c => c.companyId === "3");
        if (crown && (crown.ftHandicapLineLive || crown.ftTotalLineLive)) {
          return {
            handicapHome: crown.ftHandicapHomeLive,
            handicapLine: crown.ftHandicapLineLive,
            handicapAway: crown.ftHandicapAwayLive,
            totalOver: crown.ftTotalOverLive,
            totalLine: crown.ftTotalLineLive,
            totalUnder: crown.ftTotalUnderLive,
          };
        }
        const stored = crownLiveOddsFromDb.get(match.id);
        return stored && (stored.handicapLine || stored.totalLine) ? stored : undefined;
      })();
      const crown12 = crown12OddsFromDb.get(match.id);
      const companies = codCompanies
        .filter(c => dataCompanyIds.includes(c.companyId))
        .sort((a, b) => normalizeOpenTime(a.openTime).localeCompare(normalizeOpenTime(b.openTime)));

      if (companies.length === 0) {
        // Single row without company data
        const row: Record<string, string | number> = {
          "日期": match.matchDate || "",
          "联赛": match.league,
          "时间": match.time,
          "状态": match.state === "0" ? "未开赛" : match.state === "1" ? "进行中" : match.state === "-1" ? "完场" : match.state,
        };
        if (isHistory) {
          row["比分"] = match.homeScore && match.awayScore ? `${match.homeScore}-${match.awayScore}` : "";
          row["半场"] = match.halfHomeScore && match.halfAwayScore ? `${match.halfHomeScore}-${match.halfAwayScore}` : "";
        }
        row["主队"] = match.homeTeam;
        row["客队"] = match.awayTeam;
        if (isHistory && crownFinal) {
          row["终盘-亚盘主水"] = crownFinal.handicapHome || "";
          row["终盘-亚盘盘口"] = formatHandicapLine(crownFinal.handicapLine || "");
          row["终盘-亚盘客水"] = crownFinal.handicapAway || "";
          row["终盘-进球大水"] = crownFinal.totalOver || "";
          row["终盘-进球盘口"] = crownFinal.totalLine || "";
          row["终盘-进球小水"] = crownFinal.totalUnder || "";
        }
        if (isHistory && crown12) {
          row["新数据-亚盘主水"] = crown12.handicapHome || "";
          row["新数据-亚盘盘口"] = crown12.handicapLine || "";
          row["新数据-亚盘客水"] = crown12.handicapAway || "";
          row["新数据-进球大水"] = crown12.totalOver || "";
          row["新数据-进球盘口"] = crown12.totalLine || "";
          row["新数据-进球小水"] = crown12.totalUnder || "";
        }
        rows.push(row);
      } else {
        for (const c of companies) {
          const row: Record<string, string | number> = {
            "日期": match.matchDate || "",
            "联赛": match.league,
            "时间": match.time,
            "状态": match.state === "0" ? "未开赛" : match.state === "1" ? "进行中" : match.state === "-1" ? "完场" : match.state,
          };
          if (isHistory) {
            row["比分"] = match.homeScore && match.awayScore ? `${match.homeScore}-${match.awayScore}` : "";
            row["半场"] = match.halfHomeScore && match.halfAwayScore ? `${match.halfHomeScore}-${match.halfAwayScore}` : "";
          }
          row["主队"] = match.homeTeam;
          row["客队"] = match.awayTeam;
          if (isHistory && crownFinal) {
            row["终盘-亚盘主水"] = crownFinal.handicapHome || "";
            row["终盘-亚盘盘口"] = formatHandicapLine(crownFinal.handicapLine || "");
            row["终盘-亚盘客水"] = crownFinal.handicapAway || "";
            row["终盘-进球大水"] = crownFinal.totalOver || "";
            row["终盘-进球盘口"] = crownFinal.totalLine || "";
            row["终盘-进球小水"] = crownFinal.totalUnder || "";
          }
          if (crown12) {
            row["新数据-亚盘主水"] = crown12.handicapHome || "";
            row["新数据-亚盘盘口"] = crown12.handicapLine || "";
            row["新数据-亚盘客水"] = crown12.handicapAway || "";
            row["新数据-进球大水"] = crown12.totalOver || "";
            row["新数据-进球盘口"] = crown12.totalLine || "";
            row["新数据-进球小水"] = crown12.totalUnder || "";
          }
          row["开盘时间"] = c.openTime || "";
          row["公司"] = c.companyName;
          row["亚盘(初)主水"] = c.ftHandicapHome || "";
          row["亚盘(初)盘口"] = c.ftHandicapLine || "";
          row["亚盘(初)客水"] = c.ftHandicapAway || "";
          row["欧转亚盘(初)主水"] = c.euroAsianHome || "";
          row["欧转亚盘(初)盘口"] = c.euroAsianLine || "";
          row["欧转亚盘(初)客水"] = c.euroAsianAway || "";
          row["进球数(初)大水"] = c.ftTotalOver || "";
          row["进球数(初)盘口"] = c.ftTotalLine || "";
          row["进球数(初)小水"] = c.ftTotalUnder || "";
          rows.push(row);
        }
      }
    }

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "赔率数据");
    const dateRange = dataDateEnd ? `${dataDate.replace(/-/g, "")}-${dataDateEnd.replace(/-/g, "")}` : (currentDbDate || "data");
    XLSX.writeFile(wb, `赔率数据_${dateRange}.xlsx`);
  }, [dataTabMatches, dataSelectedLeagues, dataScheduleMode, dbCompanyOddsMap, crownLiveOddsFromDb, crown12OddsFromDb, dataCompanyIds, dataDate, dataDateEnd, currentDbDate]);

  // Fetch schedule data for history/future modes
  const fetchScheduleData = useCallback(async (mode: "history" | "future", date: string) => {
    if (!date) return;
    setScheduleLoading(true);
    setScheduleError("");
    try {
      const dateStr = date.replace(/-/g, ""); // Convert YYYY-MM-DD to YYYYMMDD
      const res = await fetch(`/api/schedule?date=${dateStr}&mode=${mode}`);
      const json = await res.json();
      if (json.success && json.data) {
        setScheduleMatches(json.data.matches || []);
        setScheduleLeagues(json.data.leagues || []);
        // Count hot matches for this schedule
        const hotLeagues = (json.data.leagues || []).filter((l: LeagueData) => l.isHot);
        const hotIds = new Set(hotLeagues.map((l: LeagueData) => l.id));
        const hotCount = (json.data.matches || []).filter((m: MatchData) => hotIds.has(m.sclassId)).length;
        setScheduleHotMatchCount(hotCount);
      } else {
        setScheduleError(json.error || "获取赛程数据失败");
        setScheduleMatches([]);
        setScheduleLeagues([]);
      }
    } catch (err) {
      console.error("[DataTab] Fetch schedule error:", err);
      setScheduleError(err instanceof Error ? err.message : "获取赛程数据失败");
      setScheduleMatches([]);
      setScheduleLeagues([]);
    } finally {
      setScheduleLoading(false);
    }
  }, []);

  // Fetch schedule data for a date range (history mode)
  const fetchScheduleRange = useCallback(async (startDate: string, endDate: string) => {
    if (!startDate || !endDate) return;
    setScheduleLoading(true);
    setScheduleError("");
    try {
      const start = new Date(startDate);
      const end = new Date(endDate);
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
        setScheduleError("日期范围无效");
        setScheduleLoading(false);
        return;
      }

      const allMatches: MatchData[] = [];
      const leagueMap = new Map<string, LeagueData>();
      let totalHot = 0;
      const totalDays = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
      let loadedDays = 0;

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10).replace(/-/g, "");
        try {
          const res = await fetch(`/api/schedule?date=${dateStr}&mode=history`);
          const json = await res.json();
          if (json.success && json.data) {
            const dayMatches = json.data.matches || [];
            const dayLeagues = json.data.leagues || [];
            allMatches.push(...dayMatches);
            for (const l of dayLeagues) {
              const existing = leagueMap.get(l.name);
              if (existing) {
                existing.count += l.count;
              } else {
                leagueMap.set(l.name, l);
              }
            }
            const hotLeagues = dayLeagues.filter((l: LeagueData) => l.isHot);
            const hotIds = new Set(hotLeagues.map((l: LeagueData) => l.id));
            totalHot += dayMatches.filter((m: MatchData) => hotIds.has(m.sclassId)).length;
          }
        } catch {
          // Skip failed dates
        }
        loadedDays++;
        setScheduleError(`加载中 ${loadedDays}/${totalDays} 天...`);
      }

      setScheduleMatches(allMatches);
      setScheduleLeagues(Array.from(leagueMap.values()).sort((a, b) => b.count - a.count));
      setScheduleHotMatchCount(totalHot);
      setScheduleError("");
    } catch (err) {
      console.error("[DataTab] Fetch schedule range error:", err);
      setScheduleError(err instanceof Error ? err.message : "获取赛程数据失败");
    } finally {
      setScheduleLoading(false);
    }
  }, []);

  // Effect: fetch schedule data when mode or date changes
  useEffect(() => {
    if (dataScheduleMode !== "today" && dataDate) {
      if (dataScheduleMode === "history" && dataDateEnd) {
        // History with date range
        fetchScheduleRange(dataDate, dataDateEnd);
      } else if (dataScheduleMode === "history" && !dataDateEnd) {
        // History single date (no range)
        fetchScheduleData(dataScheduleMode, dataDate);
      } else {
        // Future
        fetchScheduleData(dataScheduleMode, dataDate);
      }
      // Reset odds data when switching schedule
      dbCompanyOddsMapRef.current = new Map();
      setDbCompanyOddsMap(new Map());
      setFetchedMatches(new Set());
      setFailedMatches(new Map());
      setAnalysisResults(new Map());
      analysisResultsRef.current = new Map();
      setAutoFetchTriggered(""); // Reset auto-fetch trigger
      // Load saved odds from DB for the date range
      if (dataScheduleMode === "history" && dataDateEnd) {
        // Batch load all dates in one go — single setState to avoid cascade re-renders
        loadOddsFromDbRange(dataDate, dataDateEnd);
        loadPredictionsFromDb(dataDate.replace(/-/g, ""));
      } else {
        const dateStr = dataDate.replace(/-/g, "");
        loadOddsFromDb(dateStr);
        loadPredictionsFromDb(dateStr);
      }
      // Load saved league selections for this date+mode
      loadLeagueSelections(dataDate.replace(/-/g, ""), dataScheduleMode);
    } else if (dataScheduleMode === "today") {
      // Clear schedule data when switching back to today
      setScheduleMatches([]);
      setScheduleLeagues([]);
      setAutoFetchTriggered(""); // Reset auto-fetch trigger
      // Load today's saved odds from DB
      if (currentDbDate) {
        loadOddsFromDb(currentDbDate);
        loadPredictionsFromDb(currentDbDate);
        // Also load PREVIOUS day's odds — matches that started before noon today
        // belong to yesterday's schedule per titan007 date rules (matchDate="04月26日" for 09:10 match on 4/27)
        // This ensures in-progress/finished matches have their final odds available
        const prevDate = (() => {
          const y = parseInt(currentDbDate.substring(0, 4));
          const m = parseInt(currentDbDate.substring(4, 6));
          const d = parseInt(currentDbDate.substring(6, 8));
          const dt = new Date(y, m - 1, d);
          dt.setDate(dt.getDate() - 1);
          return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(dt.getDate()).padStart(2, "0")}`;
        })();
        loadOddsFromDb(prevDate);
        loadPredictionsFromDb(prevDate);
        // Load saved league selections for today
        loadLeagueSelections(currentDbDate, "today");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataScheduleMode, dataDate, dataDateEnd]);

  // --- Auto-fetch hot matches ---
  // After data is loaded and DB odds are checked, auto-fetch hot matches that haven't been saved
  // Use a ref to track fetchedMatches to avoid dependency cycle
  const fetchedMatchesRef = useRef(fetchedMatches);
  useEffect(() => { fetchedMatchesRef.current = fetchedMatches; }, [fetchedMatches]);

  const autoFetchHotMatches = useCallback(async () => {
    if (autoFetchRunning) return;

    // Determine which matches to auto-fetch:
    // - If user has selected specific leagues: fetch only matches in those leagues
    // - If no league filter (all selected): fetch hot matches only
    const currentFetched = fetchedMatchesRef.current;
    let targetMatches: MatchData[];

    if (dataSelectedLeagues.size > 0) {
      // User has league filter: fetch matches in selected leagues only
      targetMatches = dataTabMatches
        .filter(m => {
          if (dataScheduleMode !== "history" && m.state !== "0") return false;
          if (!isLeagueSelected(m.league, dataSelectedLeagues)) return false;
          return true;
        })
        .filter(m => !currentFetched.has(m.id));
    } else {
      // No league filter: fetch hot matches only
      const hotLeagueNames = new Set(hotLeagues.map(l => l.name));
      targetMatches = dataTabMatches
        .filter(m => {
          if (dataScheduleMode !== "history" && m.state !== "0") return false;
          return true;
        })
        .filter(m => hotLeagueNames.has(m.league) || m.isHot)
        .filter(m => !currentFetched.has(m.id));
    }

    if (targetMatches.length === 0) return;

    setAutoFetchRunning(true);
    autoFetchAbortRef.current = false;

    try {
      const batchSize = 1;
      for (let i = 0; i < targetMatches.length; i += batchSize) {
        if (autoFetchAbortRef.current) break;
        const batch = targetMatches.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(m => fetchSingleMatchOdds(m.id)));
        if (i + batchSize < targetMatches.length) {
          await new Promise(r => setTimeout(r, 100));
        }
      }
    } catch (err) {
      console.error("[AutoFetch] Error:", err);
    } finally {
      setAutoFetchRunning(false);
    }
  }, [autoFetchRunning, hotLeagues, dataTabMatches, dataScheduleMode, dataSelectedLeagues, fetchSingleMatchOdds]);

  // Trigger auto-fetch when match data is loaded and DB check is done
  // Only auto-fetch once per mode/date change (not on every refresh)
  const [autoFetchTriggered, setAutoFetchTriggered] = useState<string>("");
  useEffect(() => {
    // Create a key for this mode+date combination
    const key = `${dataScheduleMode}-${currentDbDate}${dataDateEnd ? "-" + dataDateEnd.replace(/-/g, "") : ""}`;
    if (dataTabMatches.length === 0) return;
    if (!currentDbDate) return;
    if (autoFetchRunning) return;
    // Don't re-trigger for the same mode+date
    if (autoFetchTriggered === key) return;

    // Wait for DB to load first — know what's already fetched, avoid duplicate work
    if (!isDbLoadReady(currentDbDate)) return;

    setAutoFetchTriggered(key);
    autoFetchHotMatches();
  }, [dataTabMatches.length, currentDbDate, dataDateEnd, dataScheduleMode, autoFetchTriggered, autoFetchRunning, isDbLoadReady, autoFetchHotMatches]);

  // Also load DB odds on initial mount when matchDate becomes available
  useEffect(() => {
    if (currentDbDate && dataScheduleMode === "today") {
      loadOddsFromDb(currentDbDate);
      loadPredictionsFromDb(currentDbDate);
      loadLeagueSelections(currentDbDate, "today");
      // Also load previous day — in-progress/finished matches belong to previous day's schedule
      const prevDate = (() => {
        const y = parseInt(currentDbDate.substring(0, 4));
        const m = parseInt(currentDbDate.substring(4, 6));
        const d = parseInt(currentDbDate.substring(6, 8));
        const dt = new Date(y, m - 1, d);
        dt.setDate(dt.getDate() - 1);
        return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(dt.getDate()).padStart(2, "0")}`;
      })();
      loadOddsFromDb(prevDate);
      loadPredictionsFromDb(prevDate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDbDate]);

  // --- Incremental auto-fetch: when user adds leagues, auto-fetch new unfetched matches ---
  useEffect(() => {
    if (dataSelectedLeagues.size === 0) {
      // "All" selected - nothing to incrementally fetch (initial auto-fetch handles hot matches)
      prevSelectedLeaguesRef.current = dataSelectedLeagues;
      return;
    }
    if (autoFetchRunning || dataLoading) {
      prevSelectedLeaguesRef.current = dataSelectedLeagues;
      return;
    }

    // Find newly added leagues (leagues that are in current but not in previous)
    const prev = prevSelectedLeaguesRef.current;
    const newLeagues = new Set<string>();
    for (const league of dataSelectedLeagues) {
      if (!prev.has(league)) newLeagues.add(league);
    }
    prevSelectedLeaguesRef.current = new Set(dataSelectedLeagues);

    if (newLeagues.size === 0) return;

    // Find unfetched matches in the newly added leagues
    const currentFetched = fetchedMatchesRef.current;
    const newMatches = dataTabMatches
      .filter(m => {
        if (dataScheduleMode !== "history" && m.state !== "0") return false;
        return true;
      })
      .filter(m => newLeagues.has(m.league))
      .filter(m => !currentFetched.has(m.id));

    if (newMatches.length === 0) return;

    // Auto-fetch the new matches
    const fetchNewMatches = async () => {
      setDataLoading(true);
      const batchSize = 1;
      try {
        for (let i = 0; i < newMatches.length; i += batchSize) {
          const batch = newMatches.slice(i, i + batchSize);
          await Promise.allSettled(batch.map(m => fetchSingleMatchOdds(m.id)));
          if (i + batchSize < newMatches.length) {
            await new Promise(r => setTimeout(r, 100));
          }
        }
      } catch (err) {
        console.error("[IncrementalFetch] Error:", err);
      } finally {
        setDataLoading(false);
      }
    };

    // Delay to avoid fetching while user is still selecting
    const timer = setTimeout(fetchNewMatches, 800);
    return () => clearTimeout(timer);
  }, [dataSelectedLeagues, dataScheduleMode, autoFetchRunning, dataLoading, dataTabMatches, fetchSingleMatchOdds]);

  useEffect(() => {
    const updateAvailability = () => setAutomationCompensationAvailable(isAutomationCompensationAvailable());
    updateAvailability();
    const timer = setInterval(updateAvailability, 30000);
    return () => clearInterval(timer);
  }, []);

  // --- Server automation status and manual compensation ---
  const loadAutomationStatus = useCallback(async (dateKey: string) => {
    if (!dateKey) return;
    try {
      const response = await fetch(`/api/automation/status?date=${dateKey}`);
      const json = await response.json();
      if (json.success && Array.isArray(json.tasks)) {
        const next = json.tasks as AutomationTaskStatusData[];
        setAutomationTasks((previous) => {
          const unchanged = previous.length === next.length && previous.every((task, index) => (
            task.id === next[index]?.id
            && task.status === next[index]?.status
            && task.currentStep === next[index]?.currentStep
            && task.lastError === next[index]?.lastError
            && task.updatedAt === next[index]?.updatedAt
          ));
          return unchanged ? previous : next;
        });
      }
    } catch {
      // Status is informational and must not block the monitor.
    }
  }, []);

  useEffect(() => {
    if (!currentDbDate) return;
    loadAutomationStatus(currentDbDate);
    const timer = setInterval(() => loadAutomationStatus(currentDbDate), 30000);
    return () => clearInterval(timer);
  }, [currentDbDate, loadAutomationStatus]);

  useEffect(() => {
    const previous = previousAutomationStatusRef.current;
    const completedNow = automationTasks.some(task => task.status === "completed" && previous.get(task.id) !== "completed");
    previousAutomationStatusRef.current = new Map(automationTasks.map(task => [task.id, task.status]));
    if (completedNow && currentDbDate) void loadOddsFromDb(currentDbDate);
  }, [automationTasks, currentDbDate, loadOddsFromDb]);

  const compensateAutomation = useCallback(async () => {
    if (automationCompensating) return;
    if (!automationCompensationAvailable) {
      setAutomationMessage("北京时间12:02后才可执行当日补偿；未到时间前属于待执行，不是失败");
      return;
    }
    setAutomationCompensating(true);
    setAutomationMessage("");
    try {
      const response = await fetch("/api/automation/compensate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxTasks: 1 }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.error || "补偿失败");
      setAutomationMessage(`已提交 ${json.ensured?.length || 0} 个幂等补偿任务`);
      if (currentDbDate) {
        await Promise.all([
          loadAutomationStatus(currentDbDate),
          loadOddsFromDb(currentDbDate),
          loadPredictionsFromDb(currentDbDate),
        ]);
      }
    } catch (error) {
      setAutomationMessage(error instanceof Error ? error.message : "补偿失败");
    } finally {
      setAutomationCompensating(false);
    }
  }, [automationCompensating, automationCompensationAvailable, currentDbDate, loadAutomationStatus, loadOddsFromDb, loadPredictionsFromDb]);

  // --- Auto dismiss old alerts ---
  useEffect(() => {
    if (alerts.length === 0) return;
    const timer = setTimeout(() => {
      setAlerts((prev) => prev.filter((a) => Date.now() - a.time < 30000));
    }, 5000);
    return () => clearTimeout(timer);
  }, [alerts]);

  // --- Toggle league ---
  const toggleLeague = (name: string) => {
    setSelectedLeagues((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const selectAllLeagues = () => setSelectedLeagues(new Set());
  const clearAllLeagues = () =>
    setSelectedLeagues(new Set(leagues.map((l) => l.name)));

  // --- Toggle pin ---
  const togglePin = (matchId: string) => {
    setPinnedMatches((prev) => {
      const next = new Set(prev);
      if (next.has(matchId)) {
        next.delete(matchId);
        // Also remove from pinnedMatchInfo when unpinning completed match
        setPinnedMatchInfo((infoPrev) => {
          const infoNext = new Map(infoPrev);
          infoNext.delete(matchId);
          return infoNext;
        });
      } else {
        next.add(matchId);
        // Save match info for the newly pinned match
        const m = matches.find((x) => x.id === matchId);
        if (m) {
          setPinnedMatchInfo((infoPrev) => {
            const infoNext = new Map(infoPrev);
            infoNext.set(matchId, {
              id: m.id,
              league: m.league,
              leagueColor: m.leagueColor,
              time: m.time,
              homeTeam: m.homeTeam,
              awayTeam: m.awayTeam,
              handicap: m.handicap,
              homeOdds: m.homeOdds,
              awayOdds: m.awayOdds,
              totalLine: m.totalLine,
              overOdds: m.overOdds,
              underOdds: m.underOdds,
            });
            return infoNext;
          });
        }
      }
      return next;
    });
  };

  // --- Alert config ---
  const openAlertConfig = (matchId: string) => {
    setCurrentAlertMatchId(matchId);
    setAlertDialogOpen(true);
  };
  const updateAlertConfig = (field: keyof AlertConfig, value: string) => {
    setAlertConfigs((prev) => {
      const next = new Map(prev);
      const config = next.get(currentAlertMatchId) || {
        matchId: currentAlertMatchId,
        handicapUp: "", handicapDown: "",
        totalLineUp: "", totalLineDown: "",
        homeOddsUp: "", homeOddsDown: "",
        awayOddsUp: "", awayOddsDown: "",
        overOddsUp: "", overOddsDown: "",
        underOddsUp: "", underOddsDown: "",
      };
      next.set(currentAlertMatchId, { ...config, [field]: value });
      return next;
    });
  };
  const removeAlertConfig = (matchId: string) => {
    setAlertConfigs((prev) => {
      const next = new Map(prev);
      next.delete(matchId);
      return next;
    });
  };

  // --- Notes ---
  const openNoteDialog = (matchId: string) => {
    setNoteMatchId(matchId);
    const existing = notes.get(matchId);
    setEditHandicapNote(existing?.handicapNote || "");
    setEditTotalNote(existing?.totalNote || "");
    setEditHandicapAmount(existing?.handicapAmount || "");
    setEditTotalAmount(existing?.totalAmount || "");
    setEditHandicapSettled(existing?.handicapSettled || false);
    setEditTotalSettled(existing?.totalSettled || false);
    setNoteDialogOpen(true);
  };

  const saveNotes = () => {
    setNotes((prev) => {
      const next = new Map(prev);
      if (editHandicapNote.trim() || editTotalNote.trim() || editHandicapAmount.trim() || editTotalAmount.trim()) {
        next.set(noteMatchId, {
          handicapNote: editHandicapNote.trim(),
          totalNote: editTotalNote.trim(),
          handicapAmount: editHandicapAmount.trim(),
          totalAmount: editTotalAmount.trim(),
          handicapSettled: editHandicapSettled,
          totalSettled: editTotalSettled,
        });
      } else {
        next.delete(noteMatchId);
      }
      return next;
    });
    setNoteDialogOpen(false);
  };

  const clearMatchNotes = (matchId: string) => {
    setNotes((prev) => {
      const next = new Map(prev);
      next.delete(matchId);
      return next;
    });
  };

  // --- Report functions ---
  const loadReportDates = useCallback(async () => {
    try {
      const res = await fetch("/api/report");
      const json = await res.json();
      if (!res.ok || !json.success || !Array.isArray(json.dates)) {
        throw new Error(json.error || "加载报表日期失败");
      }
      setReportDates(json.dates.map((d: { report_date: string }) => d.report_date));
    } catch (err) {
      toast.error("加载报表日期失败", { description: err instanceof Error ? err.message : "网络请求失败" });
    }
  }, []);

  const generateReport = async () => {
    setReportLoading(true);
    try {
      const res = await fetch(`/api/report?predDate=${selectedPredDate}&mode=ai`, { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.success || !json.report) {
        throw new Error(json.error || "生成AI报表失败");
      }
      setReportData(json.report);
      setSelectedReportDate(json.report.date);
      toast.success("AI报表生成成功", {
        description: `最后分析：${formatAnalysisTime(json.report.latestAnalysisAt)}`,
      });
      await loadReportDates();
      await loadReportTrend();
    } catch (err) {
      toast.error("生成AI报表失败", { description: err instanceof Error ? err.message : "网络请求失败" });
    } finally {
      setReportLoading(false);
    }
  };

  const loadReport = async (date: string) => {
    if (!date) return;
    setReportLoading(true);
    try {
      const res = await fetch(`/api/report?date=${date}`);
      const json = await res.json();
      if (!res.ok || !json.success || !json.data?.report_content) {
        throw new Error(json.error || "加载AI报表失败");
      }
      setReportData(JSON.parse(json.data.report_content));
      setSelectedReportDate(date);
    } catch (err) {
      toast.error("加载AI报表失败", { description: err instanceof Error ? err.message : "网络请求失败" });
    } finally {
      setReportLoading(false);
    }
  };

  const loadReportTrend = useCallback(async () => {
    try {
      const res = await fetch("/api/report?trend=14");
      const json = await res.json();
      if (!res.ok || !json.success || !Array.isArray(json.trend)) {
        throw new Error(json.error || "加载报表趋势失败");
      }
      setReportTrend(json.trend);
    } catch (err) {
      toast.error("加载报表趋势失败", { description: err instanceof Error ? err.message : "网络请求失败" });
    }
  }, []);

  // Load report dates when switching to report tab
  useEffect(() => {
    if (activeTab === "report") loadReportDates();
  }, [activeTab, loadReportDates]);

  // --- Sort and filter matches (always by original order from source) ---
  const minOddsSumVal = parseFloat(minOddsSum) || 0;

  const filteredMatches = useMemo(() => matches
    .filter((m) => m.state === "0") // Only show not-started matches
    .filter((m) => selectedLeagues.size === 0 || selectedLeagues.has(m.league))
    .filter((m) => {
      if (minOddsSumVal <= 0) return true;
      const home = parseFloat(m.homeOdds);
      const away = parseFloat(m.awayOdds);
      if (isNaN(home) || isNaN(away)) return false;
      return (home + away) > minOddsSumVal;
    })
    .sort((a, b) => {
      // Pinned first
      const aPinned = pinnedMatches.has(a.id) ? 0 : 1;
      const bPinned = pinnedMatches.has(b.id) ? 0 : 1;
      if (aPinned !== bPinned) return aPinned - bPinned;
      // Then by original order from source (same as original website)
      return a.orderIndex - b.orderIndex;
    }), [matches, selectedLeagues, minOddsSumVal, pinnedMatches]);

  useEffect(() => {
    detailedScheduleRef.current = () => {
      if (activeTab !== "odds" || dataScheduleMode !== "today") return;
      const generation = oddsGenerationRef.current;
      for (const match of filteredMatches) {
        if (generation !== oddsGenerationRef.current) break;
        const observedAt = oddsSourceMetaRef.current.get(match.id)?.sourceObservedAt;
        if (!isOddsStale(observedAt, Date.now())) continue;
        const priority = pinnedMatches.has(match.id) || expandedCrown.has(match.id) || expandedCompanies.has(match.id) ? 100 : 1;
        void enqueueOddsRefresh(match.id, priority, true);
      }
    };
    detailedScheduleRef.current();
    return () => { detailedScheduleRef.current = () => {}; };
  }, [activeTab, dataScheduleMode, filteredMatches, pinnedMatches, expandedCrown, expandedCompanies, enqueueOddsRefresh]);

  // --- Completed pinned matches (pinned but no longer in data) ---
  const activeMatchIds = new Set(matches.map((m) => m.id));
  const completedPinnedMatches = [...pinnedMatches]
    .filter((id) => !activeMatchIds.has(id) && pinnedMatchInfo.has(id))
    .map((id) => pinnedMatchInfo.get(id)!);

  // --- In-progress / finished matches for monitor tab bottom section ---
  const otherStateMatches = useMemo(() => matches
    .filter((m) => m.state !== "0")
    .filter((m) => selectedLeagues.size === 0 || selectedLeagues.has(m.league))
    .sort((a, b) => {
      // Pinned first
      const aPinned = pinnedMatches.has(a.id) ? 0 : 1;
      const bPinned = pinnedMatches.has(b.id) ? 0 : 1;
      if (aPinned !== bPinned) return aPinned - bPinned;
      return a.orderIndex - b.orderIndex;
    }), [matches, selectedLeagues, pinnedMatches]);

  // --- Odds comparison summary (from all matches with notes) ---
  const oddsComparisonSummary = useMemo(() => {
    let totalDiff = 0;
    let matchCount = 0;
    const details: Array<{
      matchId: string;
      home: string;
      away: string;
      league: string;
      type: "handicap" | "total";
      predictedOdds: number;
      currentOdds: number;
      sumTotal: number;
      diff: number;
    }> = [];

    for (const match of matches) {
      // Only compute comparison for not-started matches (state === "0")
      // In-progress/finished matches use stale odds, should not count
      if (match.state !== "0") continue;
      const matchNotes = notes.get(match.id);
      if (!matchNotes) continue;

      const hc = matchNotes.handicapNote && !matchNotes.handicapSettled
        ? computeHandicapComparison(matchNotes.handicapNote, match.homeOdds, match.awayOdds, oddsBaseTotal)
        : null;
      if (hc) {
        totalDiff += hc.diff;
        matchCount++;
        details.push({
          matchId: match.id, home: match.homeTeam, away: match.awayTeam,
          league: match.league, type: "handicap",
          predictedOdds: hc.predictedOdds, currentOdds: hc.currentOdds,
          sumTotal: hc.sumTotal, diff: hc.diff,
        });
      }

      const tc = matchNotes.totalNote && !matchNotes.totalSettled
        ? computeTotalComparison(matchNotes.totalNote, match.overOdds, match.underOdds, oddsBaseTotal)
        : null;
      if (tc) {
        totalDiff += tc.diff;
        matchCount++;
        details.push({
          matchId: match.id, home: match.homeTeam, away: match.awayTeam,
          league: match.league, type: "total",
          predictedOdds: tc.predictedOdds, currentOdds: tc.currentOdds,
          sumTotal: tc.sumTotal, diff: tc.diff,
        });
      }
    }

    return { totalDiff, matchCount, details } as const;
  }, [matches, notes, oddsBaseTotal]);

  // --- Alert when odds comparison total exceeds threshold ---
  const prevTotalExcess = useRef(0);
  useEffect(() => {
    if (
      oddsComparisonSummary.totalDiff > oddsAlertThreshold &&
      oddsComparisonSummary.totalDiff > prevTotalExcess.current
    ) {
      // Play alert sound
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        gain.gain.value = 0.3;
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      } catch {
        // Audio not available
      }
    }
    prevTotalExcess.current = oddsComparisonSummary.totalDiff;
  }, [oddsComparisonSummary.totalDiff, oddsAlertThreshold]);

  // --- Parse predictions from pasted JSON ---
  const predictionsMap = parsePredictions(savedJson);

  // --- Odds change detection ---
  const getOddsChangeClass = (
    matchId: string, field: keyof OddsSnapshot, currentValue: string | number
  ): string => {
    const snapshot = oddsSnapshots.get(matchId);
    if (!snapshot) return "";
    const old = snapshot[field];
    const current = typeof currentValue === "string" ? parseFloat(currentValue) : currentValue;
    const oldVal = typeof old === "string" ? parseFloat(old) : old;
    if (isNaN(current) || isNaN(oldVal)) return "";
    if (current > oldVal) return "text-red-400";
    if (current < oldVal) return "text-green-400";
    return "";
  };

  // Normalize open time for correct chronological sorting
  // Input: "4-6 17:19" → Output: "04-06 17:19" (pad month/day to 2 digits)
  const getHandicapChangeClass = (matchId: string, currentRaw: number): string => {
    const snapshot = oddsSnapshots.get(matchId);
    if (!snapshot) return "";
    if (currentRaw > snapshot.handicapRaw) return "text-red-400";
    if (currentRaw < snapshot.handicapRaw) return "text-green-400";
    return "";
  };

  const getTotalLineChangeClass = (matchId: string, currentRaw: number): string => {
    const snapshot = oddsSnapshots.get(matchId);
    if (!snapshot) return "";
    if (currentRaw > snapshot.totalLineRaw) return "text-red-400";
    if (currentRaw < snapshot.totalLineRaw) return "text-green-400";
    return "";
  };

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as typeof activeTab)}
      className="odds-terminal"
    >
      {/* Header */}
      <header className="odds-header">
        <div className="odds-header-inner">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-4 max-lg:items-start max-lg:flex-col">
              <div className="flex min-w-0 items-center gap-4 max-md:w-full max-md:flex-col max-md:items-start">
                <div className="shrink-0">
                  <div className="odds-kicker">PEILV INTELLIGENCE</div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <h1 className="odds-title">实时赔率监控</h1>
                    {matchDate && (
                      <Badge variant="secondary" className="border-primary/25 bg-primary/10 text-primary">
                        {matchDate}
                      </Badge>
                    )}
                  </div>
                </div>
                <TabsList className="odds-tabs" aria-label="赔率系统功能区">
                  <TabsTrigger value="odds" className="odds-tab" onClick={() => setActiveTab("odds")}>赔率监控</TabsTrigger>
                  <TabsTrigger value="data" className="odds-tab" onClick={() => setActiveTab("data")}>
                    <Building2 className="size-3.5" />
                    数据中心
                  </TabsTrigger>
                  <TabsTrigger value="comparison" className="odds-tab" onClick={() => setActiveTab("comparison")}>
                    赔率对比
                    {oddsComparisonSummary.matchCount > 0 && oddsComparisonSummary.totalDiff > oddsAlertThreshold && (
                      <span className="size-1.5 rounded-full bg-red-400" aria-label="有超阈值赔率" />
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="report" className="odds-tab" onClick={() => setActiveTab("report")}>
                    <FileBarChart className="size-3.5" />
                    预测报表
                  </TabsTrigger>
                </TabsList>
              </div>

              {oddsComparisonSummary.matchCount > 0 && (
                <div className="odds-status-chip" aria-label="赔率对比摘要">
                  <span>总超值</span>
                  <strong className={cn(
                    "font-mono text-sm",
                    oddsComparisonSummary.totalDiff > oddsAlertThreshold
                      ? "text-red-300"
                      : oddsComparisonSummary.totalDiff < 0
                        ? "text-red-400"
                        : "text-emerald-300"
                  )}>
                    {oddsComparisonSummary.totalDiff >= 0 ? "+" : ""}{oddsComparisonSummary.totalDiff.toFixed(2)}
                  </strong>
                  <span>{oddsComparisonSummary.matchCount} 项 · 阈值 {oddsAlertThreshold.toFixed(1)}</span>
                </div>
              )}
            </div>

            {activeTab === "odds" && (
            <div className="odds-toolbar" aria-label="赔率监控工具栏">
              <div className="odds-toolbar-group" aria-label="筛选条件">
              {/* Paste JSON */}
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "border-gray-700 hover:bg-gray-800 h-7",
                  savedJson ? "text-emerald-400 border-emerald-700/50" : "text-gray-300"
                )}
                onClick={() => {
                  setPastedJson(savedJson);
                  setFetchUrlInput("");
                  setFetchError("");
                  if (!selectedPredDate) {
                    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
                    setSelectedPredDate(today);
                  }
                  setPasteDialogOpen(true);
                }}
              >
                <Link className="w-3.5 h-3.5 mr-1" />
                {selectedPredDate || "JSON"}
                {predictionsMap.size > 0 && (
                  <Badge className="ml-1 bg-purple-600 text-white px-1.5 py-0 text-xs">
                    {predictionsMap.size}
                  </Badge>
                )}
              </Button>

              {/* Odds sum filter */}
              <div className="flex items-center gap-1">
                <span className="text-xs text-gray-400 whitespace-nowrap">水位和 &gt;</span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0"
                  value={minOddsSum}
                  onChange={(e) => setMinOddsSum(e.target.value)}
                  className="w-16 h-7 bg-gray-800 border-gray-700 text-gray-200 text-xs px-2"
                />
              </div>

              {/* League filter */}
              <Popover open={leagueFilterOpen} onOpenChange={setLeagueFilterOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="border-gray-700 text-gray-300 hover:bg-gray-800 h-7">
                    <Filter className="w-3.5 h-3.5 mr-1" />
                    联赛筛选
                    {selectedLeagues.size > 0 && (
                      <Badge className="ml-1 bg-blue-600 text-white px-1.5 py-0 text-xs">
                        {selectedLeagues.size}
                      </Badge>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 odds-popover p-0" align="end">
                  <div className="p-3 border-b border-gray-700 flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-200">选择联赛</span>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" className="text-xs text-blue-400 hover:text-blue-300 h-6 px-2" onClick={selectAllLeagues}>全选</Button>
                      <Button size="sm" variant="ghost" className="text-xs text-red-400 hover:text-red-300 h-6 px-2" onClick={clearAllLeagues}>全不选</Button>
                    </div>
                  </div>
                  <ScrollArea className="h-[300px]">
                    <div className="p-2 space-y-1">
                      {leagues.map((league) => (
                        <label
                          key={league.name}
                          className={cn(
                            "flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-gray-800/50",
                            selectedLeagues.has(league.name) ? "bg-blue-900/30" : ""
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={selectedLeagues.size === 0 || selectedLeagues.has(league.name)}
                            onChange={() => toggleLeague(league.name)}
                            className="rounded border-gray-600"
                          />
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: `#${league.color}` }} />
                          <span className="text-sm text-gray-300 flex-1">{league.name}</span>
                          <span className="text-xs text-gray-500">{league.count}</span>
                        </label>
                      ))}
                    </div>
                  </ScrollArea>
                </PopoverContent>
              </Popover>
              </div>

              <div className="odds-toolbar-group" aria-label="数据源与刷新设置">
              {/* Sound toggle */}
              <Button variant="outline" size="icon-sm" className="border-gray-700 text-gray-300 hover:bg-gray-800" onClick={() => setSoundEnabled(!soundEnabled)} aria-label={soundEnabled ? "关闭提醒声音" : "开启提醒声音"} title={soundEnabled ? "关闭提醒声音" : "开启提醒声音"}>
                {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              </Button>

              {/* Refresh interval */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="border-gray-700 text-gray-300 hover:bg-gray-800 h-7">
                    <Settings className="w-3.5 h-3.5 mr-1" />
                    {refreshInterval}s
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-64 odds-popover" align="end">
                  <div className="space-y-3">
                    <Label className="text-gray-300">刷新间隔: {refreshInterval} 秒</Label>
                    <Slider value={[refreshInterval]} onValueChange={([v]) => setRefreshInterval(v)} min={3} max={120} step={1} className="py-2" />
                    <div className="flex gap-2">
                      {[5, 10, 15, 30, 60].map((s) => (
                        <Button key={s} size="sm" variant={refreshInterval === s ? "default" : "outline"}
                          className={refreshInterval === s ? "bg-blue-600" : "border-gray-700 text-gray-400"}
                          onClick={() => setRefreshInterval(s)}>{s}s</Button>
                      ))}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>

              {/* Company selector */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="border-gray-700 text-gray-300 hover:bg-gray-800 h-7">
                    <Building2 className="w-3.5 h-3.5 mr-1" />
                    公司
                    <ChevronDown className="w-3 h-3 ml-0.5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-56 odds-popover" align="end">
                  <div className="space-y-2">
                    <Label className="text-gray-300 text-xs">选择赔率公司</Label>
                    <div className="space-y-1">
                      {["3:皇冠", "35:盈禾", "42:18博", "47:平博", "12:易胜博", "17:明升", "31:利记", "1:澳门", "8:36bet", "14:伟德", "24:12BET", "50:1xbet"].map((item) => {
                        const [id, name] = item.split(":");
                        const isSelected = monitorCompanyIds.includes(id);
                        return (
                          <label key={id} className="flex items-center gap-2 cursor-pointer hover:bg-gray-800/50 px-1 py-0.5 rounded">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {
                                setMonitorCompanyIds(prev =>
                                  isSelected ? prev.filter(x => x !== id) : [...prev, id]
                                );
                              }}
                              className="rounded border-gray-600"
                            />
                            <span className="text-xs text-gray-300">{name}</span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="flex gap-2 pt-1 border-t border-gray-700">
                      <Button size="sm" variant="outline" className="flex-1 text-xs border-gray-700 text-gray-400 h-6"
                        onClick={() => setMonitorCompanyIds(DEFAULT_COMPANY_IDS)}>
                        默认5家
                      </Button>
                      <Button size="sm" variant="outline" className="flex-1 text-xs border-gray-700 text-gray-400 h-6"
                        onClick={() => setMonitorCompanyIds(["3","35","42","47","12","17","31","1","8","14","24","50"])}>
                        全选
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
              </div>

              <div className="odds-toolbar-group" aria-label="智能分析与系统操作">
              {/* AI Analysis */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      "border-gray-700 hover:bg-gray-800 h-7",
                      (analyzingMatchId || batchAIProgress.total > 0 || dataScheduleMode === "history") ? "text-gray-600" : "text-purple-400 border-purple-700/50"
                    )}
                    disabled={!!analyzingMatchId || batchAIProgress.total > 0 || dataScheduleMode === "history"}
                  >
                    {analyzingMatchId ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Zap className="w-3.5 h-3.5 mr-1" />}
                    {analyzingMatchId ? "分析中…" : batchAIProgress.total > 0 ? "批量分析中…" : "AI分析"}
                    {analysisResults.size > 0 && (
                      <Badge className="ml-1 bg-purple-600 text-white px-1.5 py-0 text-xs">
                        {analysisResults.size}
                      </Badge>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-44 odds-popover p-1" side="bottom" align="end">
                  <div className="px-2 py-1.5 border-b border-gray-700/60 mb-1">
                    <label className="flex items-center justify-between gap-2 text-[11px] text-gray-400">
                      <span>并发数</span>
                      <input
                        type="number"
                        min={1}
                        max={8}
                        className="w-14 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[11px] text-purple-300 text-center outline-none focus:border-purple-600"
                        value={aiConcurrency}
                        disabled={batchAIProgress.total > 0}
                        onChange={(e) => setAiConcurrency(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                      />
                    </label>
                    <div className="mt-0.5 text-[11px] text-gray-600">批量分析同时请求数量</div>
                  </div>
                  <button
                    className="w-full text-left text-[11px] text-purple-400 hover:bg-gray-800 px-2 py-1.5 rounded disabled:text-gray-600"
                    disabled={!!analyzingMatchId || batchAIProgress.total > 0}
                    onClick={() => {
                      const firstMatch = filteredMatches[0];
                      if (firstMatch) {
                        analyzeSingleMatch(firstMatch.id, true);
                      } else {
                        toast.info("当前没有可分析的赛事", { description: "请调整筛选条件或等待赛事数据加载" });
                      }
                    }}
                  >
                    分析首场赛事
                  </button>
                  <button
                    className="w-full text-left text-[11px] text-purple-400 hover:bg-gray-800 px-2 py-1.5 rounded disabled:text-gray-600"
                    disabled={!!analyzingMatchId || batchAIProgress.total > 0}
                    onClick={() => {
                      const analyzable = filteredMatches
                        .map(m => ({ id: m.id, homeTeam: m.homeTeam, awayTeam: m.awayTeam }));
                      if (analyzable.length === 0) {
                        toast.info("没有可分析的赛事", { description: "当前列表中没有符合条件的赛事" });
                        return;
                      }
                      batchAnalyzeAll(analyzable, true);
                    }}
                  >
                    批量AI分析
                  </button>
                  <hr className="border-gray-700 my-1" />
                  <button
                    className="w-full text-left text-[11px] text-blue-400 hover:bg-gray-800 px-2 py-1.5 rounded"
                    onClick={async () => {
                      const now = new Date();
                      const beijingOffset = 8 * 60;
                      const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
                      const beijingNow = new Date(utcMs + beijingOffset * 60000);
                      const yesterday = new Date(beijingNow);
                      yesterday.setDate(yesterday.getDate() - 1);
                      const yd = yesterday.toISOString().slice(0, 10).replace(/-/g, "");
                      try {
                        const vr = await fetch(`/api/analysis/verify?startDate=${yd}&endDate=${yd}`);
                        const vj = await vr.json();
                        const [handicapLearn, totalLearn] = await Promise.all(["handicap", "total"].map(market => fetch("/api/analysis/learn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ market, league: "ALL", minSamples: 3 }) })));
                        const [handicapResult, totalResult] = await Promise.all([handicapLearn.json(), totalLearn.json()]);
                        const learnedPatterns = (handicapResult.patternsFound || 0) + (totalResult.patternsFound || 0);
                        await loadEvolutionStats();
                        toast.success("验证与学习完成", { description: `验证 ${vj.verified || 0} 场 · 命中 ${vj.correct || 0} 场 · 新增 ${learnedPatterns} 个模式` });
                      } catch (err) { toast.error("验证学习失败", { description: err instanceof Error ? err.message : "网络请求失败", duration: 8000 }); }
                    }}
                  >
                    验证+学习
                  </button>
                  {evolutionStats && evolutionStats.totalPredictions > 0 && (
                    <div className="px-2 py-1 text-[11px] text-gray-500">
                      已验证{evolutionStats.totalPredictions}场 命中{evolutionStats.correctPredictions}场 ({evolutionStats.overallAccuracy})
                    </div>
                  )}
                </PopoverContent>
              </Popover>
              {batchAIProgress.total > 0 && (
                <span className="text-[11px] text-purple-300 flex items-center gap-1" title={`最近处理：${batchAIProgress.matchName}`}>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {batchAIProgress.current}/{batchAIProgress.total}
                  <span className="text-green-400">成功{batchAIProgress.succeeded}</span>
                  <span className="text-red-400">失败{batchAIProgress.failed}</span>
                  <button className="text-red-400 hover:text-red-300" onClick={stopBatchAI}>停止后续</button>
                </span>
              )}

              <Button
                variant="outline"
                size="sm"
                className="border-amber-700 text-amber-300 hover:bg-amber-950 h-7 text-xs"
                onClick={compensateAutomation}
                disabled={automationCompensating || !automationCompensationAvailable}
                title={automationCompensationAvailable
                  ? "幂等补偿赔率、皇冠快照和AI分析任务"
                  : "北京时间12:02后才可执行当日补偿"}
              >
                {automationCompensating ? "补偿中..." : automationCompensationAvailable ? "补偿服务端任务" : "12:02后可补偿"}
              </Button>

              {/* Manual refresh */}
              <Button variant="outline" size="icon-sm" className="border-gray-700 text-gray-300 hover:bg-gray-800" onClick={fetchData} disabled={loading} aria-label="立即刷新赔率" title="立即刷新赔率">
                <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
              </Button>
              </div>
            </div>
            )}
          </div>

          {/* Status bar */}
          <div className="odds-statusbar" aria-live="polite">
            {activeTab === "odds" && (
            <>
              <span className="odds-status-chip"><strong className="font-mono text-foreground">{filteredMatches.length}</strong> 场赛事</span>
              <span className="odds-status-chip">未赛 {matches.filter(m => m.state === "0").length} · 其他赛况 {otherStateMatches.length}</span>
              <span className="odds-status-chip">置顶 {pinnedMatches.size} · 监控 {alertConfigs.size} · 笔记 {[...notes.values()].filter(n => n.handicapNote || n.totalNote).length}</span>
              <span className="odds-status-chip">刷新 {lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : "--:--:--"}</span>
              <span className="odds-status-chip" title={`详细赔率超过 ${ODDS_STALE_AFTER_MS / 1000} 秒自动刷新`}>
                队列 {oddsQueueStatus.queued} · 进行中 {oddsQueueStatus.inFlight} · 最近成功 {oddsQueueStatus.lastSuccessAt ? `${Math.floor((oddsStatusNow - oddsQueueStatus.lastSuccessAt) / 1000)}秒前` : "--"}
              </span>
              {loading && <span className="odds-status-chip text-blue-300"><RefreshCw className="size-3 animate-spin" /> 刷新中</span>}
              {error && <span className="odds-status-chip text-red-300" role="alert"><AlertTriangle className="size-3" /> {error}</span>}
              {alertConfigs.size > 0 && <span className="odds-status-chip text-amber-300"><BellRing className="size-3" /> {alertConfigs.size} 项监控中</span>}
              <span className="odds-status-chip text-amber-300">{automationStatusText(automationTasks)}</span>
              {automationMessage && <span className="odds-status-chip text-amber-300">{automationMessage}</span>}
            </>
            )}
          </div>
        </div>
      </header>

      {/* Alert notifications */}
      {alerts.length > 0 && (
        <div className="fixed top-20 right-4 z-50 max-w-sm space-y-2" aria-live="assertive">
          {alerts.slice(-5).map((alert) => (
            <div key={alert.id} className="rounded-lg border border-red-500/45 bg-red-950/95 p-3 shadow-2xl">
              <div className="flex items-start gap-2">
                <BellRing className="w-4 h-4 text-red-300 mt-0.5 shrink-0" />
                <p className="text-sm text-red-100">{alert.message}</p>
                <Button variant="ghost" size="sm" className="h-5 w-5 p-0 text-red-300 hover:text-red-100 ml-auto shrink-0"
                  aria-label="关闭赔率提醒"
                  onClick={() => setAlerts((prev) => prev.filter((a) => a.id !== alert.id))}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
              <p className="text-xs text-red-300 mt-1">{new Date(alert.time).toLocaleTimeString()}</p>
            </div>
          ))}
        </div>
      )}

      {/* Main content */}
      <main className="odds-main">
        {activeTab === "odds" && (
        <>
        <div className="odds-table-wrap">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[#141828] text-gray-400 text-[11px]">
                <th scope="col" className="px-1 py-1.5 text-center w-7"><span className="sr-only">置顶</span></th>
                <th scope="col" className="px-1 py-1.5 text-center w-7"><span className="sr-only">提醒</span></th>
                <th scope="col" className="px-1 py-1.5 text-center w-7"><span className="sr-only">笔记</span></th>
                <th scope="col" className="px-1 py-1.5 text-center w-7"><span className="sr-only">公司赔率</span></th>
                <th scope="col" className="px-1 py-1.5 text-center w-7"><span className="sr-only">AI 分析</span></th>
                <th scope="col" className="px-2 py-1.5 text-left w-[90px]">联赛</th>
                <th scope="col" className="px-2 py-1.5 text-center w-24">赛况</th>
                <th scope="col" className="px-2 py-1.5 text-right">主队</th>
                <th scope="colgroup" className="px-2 py-1.5 text-center" colSpan={3}>最新亚盘</th>
                <th scope="col" className="px-2 py-1.5 text-left">客队</th>
                <th scope="colgroup" className="px-2 py-1.5 text-center" colSpan={3}>最新进球数</th>
              </tr>
            </thead>
            <tbody>
              {filteredMatches.length === 0 ? (
                <tr>
                  <td colSpan={15} className="text-center py-12 text-gray-500">
                    {loading ? "加载中..." : "暂无未开赛赛事数据"}
                  </td>
                </tr>
              ) : (
                filteredMatches.map((match) => {
                  const isPinned = pinnedMatches.has(match.id);
                  const hasAlert = alertConfigs.has(match.id);
                  const matchNotes = notes.get(match.id);
                  const prediction = predictionsMap.get(`${match.homeTeam}_${match.awayTeam}`);

                  // Prefer Crown liveOdds parsed from the legacy allCompOdds page.
                  // goalBf3.xml is only the generic match feed fallback.
                  const crownDbData = dbCompanyOddsMap.get(match.id);
                  const crownDbCompanies = Array.isArray(crownDbData?.companies) ? crownDbData.companies : [];
                  const crownCompany = crownDbCompanies.find(c => c.companyId === "3");
                  const latestOdds = getMatchLatestOdds(match, crownCompany);
                  const hasCrownLive = latestOdds.isCrownLatest;
                  const effectiveHomeOdds = latestOdds.handicapHome;
                  const effectiveHandicap = latestOdds.handicapLine;
                  const effectiveAwayOdds = latestOdds.handicapAway;
                  const effectiveOverOdds = latestOdds.totalOver;
                  const effectiveTotalLine = latestOdds.totalLine;
                  const effectiveUnderOdds = latestOdds.totalUnder;
                  const effectiveHandicapRaw = hasCrownLive && effectiveHandicap !== match.handicap
                    ? lineTextToNumber(effectiveHandicap) ?? match.handicapRaw
                    : match.handicapRaw;
                  const analysisResult = analysisResults.get(match.id);
                  const purchaseAdvice = analysisResult ? buildPurchaseAdvice(analysisResult, latestOdds) : null;

                  const predComp = prediction ? computePredictionComparison(prediction, effectiveHomeOdds, effectiveAwayOdds, effectiveHandicapRaw) : null;

                  return (
                    <React.Fragment key={match.id}>
                      <tr
                        className={cn(
                          "border-b border-gray-800/30 transition-colors",
                          isPinned ? "bg-blue-950/40 hover:bg-blue-950/60" : cn(getMatchRowClass(match.state), "hover:bg-gray-800/30")
                        )}
                      >
                        {/* Expand company odds - always show */}
                        <td className="px-0.5 py-0.5 text-center w-5">
                          <button
                            className="inline-flex items-center justify-center w-4 h-5 rounded hover:bg-gray-700/50 text-gray-500 hover:text-gray-300 transition-transform"
                            onClick={() => {
                              const isExpanded = expandedCompanies.has(match.id);
                              setExpandedCompanies(prev => {
                                const next = new Set(prev);
                                if (next.has(match.id)) next.delete(match.id);
                                else next.add(match.id);
                                return next;
                              });
                              // Fetch data if expanding and no data yet
                              const oddsData = dbCompanyOddsMap.get(match.id);
                              const hasCompanies = Array.isArray(oddsData?.companies) && oddsData.companies.length > 0;
                              if (!isExpanded && !hasCompanies && !fetchingMatches.has(match.id)) {
                                fetchSingleMatchOdds(match.id);
                              }
                            }}
                          >
                            <ChevronDown className={cn("w-3 h-3 transition-transform", expandedCompanies.has(match.id) && "rotate-180")} />
                          </button>
                        </td>
                        {/* Pin */}
                        <td className="px-1 py-0.5 text-center">
                          <button
                            className={cn(
                              "inline-flex items-center justify-center w-5 h-5 rounded hover:bg-gray-700/50",
                              isPinned ? "text-blue-400" : "text-gray-600"
                            )}
                            onClick={() => togglePin(match.id)}
                            title={isPinned ? "取消置顶" : "置顶"}
                          >
                            {isPinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-2.5 h-2.5" />}
                          </button>
                        </td>

                        {/* Alert */}
                        <td className="px-1 py-0.5 text-center">
                          <button
                            className={cn(
                              "inline-flex items-center justify-center w-5 h-5 rounded hover:bg-gray-700/50",
                              hasAlert ? "text-yellow-400" : "text-gray-600"
                            )}
                            onClick={() => openAlertConfig(match.id)}
                            title="设置提醒"
                          >
                            {hasAlert ? <BellRing className="w-3 h-3" /> : <Bell className="w-2.5 h-2.5" />}
                          </button>
                        </td>

                        {/* Note */}
                        <td className="px-1 py-0.5 text-center">
                          <button
                            className={cn(
                              "inline-flex items-center justify-center w-5 h-5 rounded hover:bg-gray-700/50",
                              matchNotes ? "text-emerald-400" : "text-gray-600"
                            )}
                            onClick={() => openNoteDialog(match.id)}
                            title="添加笔记"
                          >
                            <StickyNote className="w-3 h-3" />
                          </button>
                        </td>

                        {/* AI Analysis */}
                        <td className="px-1 py-0.5 text-center">
                          {analysisResult && purchaseAdvice ? (
                            <button
                              className={cn(
                                "inline-flex flex-col items-center gap-0.5 px-1 py-0.5 rounded text-[11px] font-bold transition-colors leading-none",
                                analysisResult.prediction === "主" ? "bg-red-900/30 text-red-300 hover:bg-red-900/50" :
                                analysisResult.prediction === "客" ? "bg-green-900/30 text-green-300 hover:bg-green-900/50" :
                                "bg-gray-700/30 text-gray-400 hover:bg-gray-700/50",
                                analysisExpanded === match.id && "ring-1 ring-purple-500/50"
                              )}
                              onClick={() => { const next = analysisExpanded === match.id ? null : match.id; setAnalysisExpanded(next); if (next) loadAnalysisDetail(next); }}
                              title={purchaseAdvice.title}
                            >
                              <span>{analysisResult.prediction === "主" ? "买主" : analysisResult.prediction === "客" ? "买客" : "观望"}</span>
                              <span className="text-[11px] opacity-80">{analysisResult.confidenceLevel}{analysisResult.accuracy}</span>
                            </button>
                          ) : dataScheduleMode !== "history" ? (
                              <button
                                className={cn(
                                  "inline-flex items-center justify-center w-5 h-5 rounded hover:bg-gray-700/50 transition-colors text-gray-600 hover:text-purple-400",
                                  analyzingMatchId === match.id && "animate-pulse text-purple-400"
                                )}
                                onClick={() => analyzeSingleMatch(match.id, true)}
                                disabled={!!analyzingMatchId}
                                title={analyzingMatchId === match.id ? "AI分析中" : "AI分析(点击重新分析)"}
                              >
                                {analyzingMatchId === match.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                              </button>
                            ) : null}
                        </td>

                        {/* League */}
                        <td className="px-2 py-0.5">
                          <div className="flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: `#${match.leagueColor}` }} />
                            <span className="text-gray-400 truncate max-w-[80px] leading-tight">{match.league}</span>
                          </div>
                        </td>

                        {/* Match situation */}
                        <td className="px-2 py-0.5 text-center leading-tight">
                          <MatchSituation state={match.state} time={match.time} display="time" />
                        </td>

                        {/* Home Team */}
                        <td className="px-2 py-0.5 text-right leading-tight">
                          <div className="flex items-center justify-end gap-1 flex-wrap">
                            {(() => {
                              const aiResult = analysisResults.get(match.id);
                              // Only show diff on AI-recommended side (home)
                              if (!aiResult || aiResult.prediction !== "主") return null;
                              const c12 = crown12OddsFromDb.get(match.id);
                              const diff = c12 && effectiveHomeOdds ? computeCrown12VsLiveDiff(c12, effectiveHomeOdds, effectiveAwayOdds, effectiveHandicapRaw) : null;
                              if (!diff || (diff.homeDiff === 0 && diff.lineChange === 0)) return null;
                              const c12Line = c12?.handicapLine ? lineTextToNumber(c12.handicapLine) : 0;
                              const trendLabel = diff.lineChange !== 0 && c12Line !== null ? getHandicapTrendLabel(c12Line, c12Line + diff.lineChange) : null;
                              return (
                                <span className="text-[11px] font-mono leading-tight flex items-center gap-0.5">
                                  {trendLabel && (
                                    <span className={trendLabel === "升" ? "text-red-400" : "text-green-400"}>
                                      {trendLabel}
                                    </span>
                                  )}
                                  {diff.homeDiff !== 0 && (
                                    <span className={diff.homeDiff > 0 ? "text-red-400" : "text-green-400"}>
                                      {diff.homeDiff > 0 ? "+" : ""}{diff.homeDiff}
                                    </span>
                                  )}
                                </span>
                              );
                            })()}
                            <span className={cn("font-medium", analysisResults.has(match.id) && analysisResults.get(match.id)!.prediction === "主" ? "text-red-400" : "text-white")}>{match.homeTeam}{match.homeRank && <span className="text-gray-500 text-[11px] ml-0.5">[{match.homeRank}]</span>}</span>
                            {predComp?.predictedSide === "home" && predComp.oddsDiff !== null && (
                              <span
                                className={cn(
                                  "text-[11px] px-1 py-0 rounded font-medium cursor-pointer hover:opacity-80",
                                  predComp.action === "重注" ? "text-red-300 bg-red-900/40" :
                                  predComp.action === "轻注" ? "text-orange-300 bg-orange-900/40" :
                                  "text-blue-300 bg-blue-900/40"
                                )}
                                onClick={() => {
                                  setExpandedCrown((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(match.id)) next.delete(match.id);
                                    else next.add(match.id);
                                    return next;
                                  });
                                }}
                              >
                                {predComp.action}{predComp.oddsDiff >= 0 ? "+" : ""}{predComp.oddsDiff}
                                {predComp.handicapChange && (
                                  <span className="ml-0.5 text-yellow-300">{predComp.handicapChange}</span>
                                )}
                              </span>
                            )}
                            {predComp?.predictedSide === "away" && predComp.handicapChange && (
                              <span className="text-[11px] text-yellow-300">{predComp.handicapChange}</span>
                            )}
                          </div>
                          {expandedCrown.has(match.id) && prediction && (prediction.crown_handicap || (prediction as unknown as Record<string, string>)?.handicap) && (
                            <div className="text-[11px] text-cyan-300 mt-0.5">皇冠 {prediction.crown_handicap || String((prediction as unknown as Record<string, string>)?.handicap || "")}</div>
                          )}
                        </td>

                        {/* Handicap: 主水 | 盘口 | 客水 */}
                        <td className="px-1 py-0.5 text-right leading-tight">
                          <a
                            href={`https://vip.titan007.com/changeDetail/3in1Odds.aspx?id=${match.id}&companyid=3&l=0`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:opacity-80"
                          >
                            {hasCrownLive ? (
                              <span className="text-emerald-300">{effectiveHomeOdds || "--"}</span>
                            ) : (
                              <span className={cn(match.homeOdds ? getOddsChangeClass(match.id, "homeOdds", match.homeOdds) : "text-gray-600")}>
                                {match.homeOdds || "--"}
                              </span>
                            )}
                          </a>
                          {matchNotes?.handicapNote && !matchNotes.handicapSettled && (() => {
                            const pn = parseHandicapNote(matchNotes.handicapNote);
                            const cmp = computeHandicapComparison(matchNotes.handicapNote, effectiveHomeOdds, effectiveAwayOdds, oddsBaseTotal);
                            if (!pn) return null;
                            return (
                              <div className="text-[11px] text-amber-300 leading-tight flex items-center justify-end gap-0.5">
                                {cmp && pn.side === "主" && (
                                  <span className={cmp.diff >= 0 ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                                    {cmp.diff >= 0 ? "+" : ""}{cmp.diff.toFixed(2)}
                                  </span>
                                )}
                                <span>{pn.homeOdds}</span>
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-1 py-0.5 text-center font-bold leading-tight">
                          <a
                            href={`https://vip.titan007.com/changeDetail/3in1Odds.aspx?id=${match.id}&companyid=3&l=0`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:opacity-80"
                          >
                            {hasCrownLive ? (
                              <span className="text-emerald-200">{formatHandicapLine(effectiveHandicap) || "--"}</span>
                            ) : (
                              <span className={cn(match.handicap ? getHandicapChangeClass(match.id, match.handicapRaw) : "text-gray-600")}>
                                {match.handicap || "--"}
                              </span>
                            )}
                          </a>
                          <div className="text-[11px] text-emerald-500/80 leading-tight">
                            {latestOdds.source}{latestOdds.handicapObservedAt ? ` ${latestOdds.handicapObservedAt}` : ""}
                          </div>
                          {matchNotes?.handicapNote && (() => {
                            const pn = parseHandicapNote(matchNotes.handicapNote);
                            if (!pn || !pn.line) return null;
                            return <div className="text-[11px] text-amber-300 leading-tight">{pn.line}</div>;
                          })()}
                        </td>
                        <td className="px-1 py-0.5 text-left leading-tight">
                          <a
                            href={`https://vip.titan007.com/changeDetail/3in1Odds.aspx?id=${match.id}&companyid=3&l=0`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:opacity-80"
                          >
                            {hasCrownLive ? (
                              <span className="text-emerald-300">{effectiveAwayOdds || "--"}</span>
                            ) : (
                              <span className={cn(match.awayOdds ? getOddsChangeClass(match.id, "awayOdds", match.awayOdds) : "text-gray-600")}>
                                {match.awayOdds || "--"}
                              </span>
                            )}
                          </a>
                          {matchNotes?.handicapNote && !matchNotes.handicapSettled && (() => {
                            const pn = parseHandicapNote(matchNotes.handicapNote);
                            const cmp = computeHandicapComparison(matchNotes.handicapNote, effectiveHomeOdds, effectiveAwayOdds, oddsBaseTotal);
                            if (!pn) return null;
                            return (
                              <div className="text-[11px] text-amber-300 leading-tight flex items-center gap-0.5">
                                <span>{pn.awayOdds}</span>
                                {cmp && pn.side === "客" && (
                                  <span className={cmp.diff >= 0 ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                                    {cmp.diff >= 0 ? "+" : ""}{cmp.diff.toFixed(2)}
                                  </span>
                                )}
                              </div>
                            );
                          })()}
                        </td>

                        {/* Away Team */}
                        <td className="px-2 py-0.5 text-left leading-tight">
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className={cn("font-medium", analysisResults.has(match.id) && analysisResults.get(match.id)!.prediction === "客" ? "text-green-400" : "text-white")}>{match.awayTeam}{match.awayRank && <span className="text-gray-500 text-[11px] ml-0.5">[{match.awayRank}]</span>}</span>
                            {(() => {
                              const aiResult = analysisResults.get(match.id);
                              // Only show diff on AI-recommended side (away)
                              if (!aiResult || aiResult.prediction !== "客") return null;
                              const c12 = crown12OddsFromDb.get(match.id);
                              const diff = c12 && effectiveHomeOdds ? computeCrown12VsLiveDiff(c12, effectiveHomeOdds, effectiveAwayOdds, effectiveHandicapRaw) : null;
                              if (!diff || (diff.awayDiff === 0 && diff.lineChange === 0)) return null;
                              const c12Line2 = c12?.handicapLine ? lineTextToNumber(c12.handicapLine) : 0;
                              const trendLabel2 = diff.lineChange !== 0 && c12Line2 !== null ? getHandicapTrendLabel(c12Line2, c12Line2 + diff.lineChange) : null;
                              return (
                                <span className="text-[11px] font-mono leading-tight flex items-center gap-0.5">
                                  {trendLabel2 && (
                                    <span className={trendLabel2 === "升" ? "text-red-400" : "text-green-400"}>
                                      {trendLabel2}
                                    </span>
                                  )}
                                  {diff.awayDiff !== 0 && (
                                    <span className={diff.awayDiff > 0 ? "text-red-400" : "text-green-400"}>
                                      {diff.awayDiff > 0 ? "+" : ""}{diff.awayDiff}
                                    </span>
                                  )}
                                </span>
                              );
                            })()}
                            {predComp?.predictedSide === "away" && predComp.oddsDiff !== null && (
                              <span
                                className={cn(
                                  "text-[11px] px-1 py-0 rounded font-medium cursor-pointer hover:opacity-80",
                                  predComp.action === "重注" ? "text-red-300 bg-red-900/40" :
                                  predComp.action === "轻注" ? "text-orange-300 bg-orange-900/40" :
                                  "text-blue-300 bg-blue-900/40"
                                )}
                                onClick={() => {
                                  setExpandedCrown((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(match.id)) next.delete(match.id);
                                    else next.add(match.id);
                                    return next;
                                  });
                                }}
                              >
                                {predComp.action}{predComp.oddsDiff >= 0 ? "+" : ""}{predComp.oddsDiff}
                                {predComp.handicapChange && (
                                  <span className="ml-0.5 text-yellow-300">{predComp.handicapChange}</span>
                                )}
                              </span>
                            )}
                            {predComp?.predictedSide === "home" && predComp.handicapChange && (
                              <span className="text-[11px] text-yellow-300">{predComp.handicapChange}</span>
                            )}
                          </div>
                          {expandedCrown.has(match.id) && prediction?.crown_handicap && (
                            <div className="text-[11px] text-cyan-300 mt-0.5">皇冠 {prediction.crown_handicap}</div>
                          )}
                        </td>

                        {/* Total: 大水 | 盘口 | 小水 */}
                        <td className="px-1 py-0.5 text-right leading-tight">
                          <div className="flex items-center justify-end gap-0.5">
                            {analysisResults.has(match.id) && analysisResults.get(match.id)!.totalPrediction === "大" && (
                              <span className="text-[11px] font-bold text-red-400 bg-red-900/30 px-0.5 rounded">大</span>
                            )}
                            {hasCrownLive ? (
                              <span className="text-emerald-300">{effectiveOverOdds || "--"}</span>
                            ) : (
                              <span className={cn(match.overOdds ? getOddsChangeClass(match.id, "overOdds", match.overOdds) : "text-gray-600")}>
                                {match.overOdds || "--"}
                              </span>
                            )}
                          </div>
                          {matchNotes?.totalNote && !matchNotes.totalSettled && (() => {
                            const pn = parseTotalNote(matchNotes.totalNote);
                            const cmp = computeTotalComparison(matchNotes.totalNote, effectiveOverOdds, effectiveUnderOdds, oddsBaseTotal);
                            if (!pn) return null;
                            return (
                              <div className="text-[11px] text-amber-300 leading-tight flex items-center justify-end gap-0.5">
                                {cmp && pn.side === "大" && (
                                  <span className={cmp.diff >= 0 ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                                    {cmp.diff >= 0 ? "+" : ""}{cmp.diff.toFixed(2)}
                                  </span>
                                )}
                                <span>{pn.overOdds}</span>
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-1 py-0.5 text-center font-bold leading-tight">
                          {hasCrownLive ? (
                            <span className="text-emerald-200">{formatHandicapLine(effectiveTotalLine) || "--"}</span>
                          ) : (
                            <span className={cn(match.totalLine ? getTotalLineChangeClass(match.id, match.totalLineRaw) : "text-gray-600")}>
                              {match.totalLine || "--"}
                            </span>
                          )}
                          <div className="text-[11px] text-emerald-500/80 leading-tight">
                            {latestOdds.totalObservedAt || "最新"}
                          </div>
                          {matchNotes?.totalNote && (() => {
                            const pn = parseTotalNote(matchNotes.totalNote);
                            if (!pn || !pn.line) return null;
                            return <div className="text-[11px] text-amber-300 leading-tight">{pn.line}</div>;
                          })()}
                        </td>
                        <td className="px-1 py-0.5 text-left leading-tight">
                          <div className="flex items-center gap-0.5">
                            {hasCrownLive ? (
                              <span className="text-emerald-300">{effectiveUnderOdds || "--"}</span>
                            ) : (
                              <span className={cn(match.underOdds ? getOddsChangeClass(match.id, "underOdds", match.underOdds) : "text-gray-600")}>
                                {match.underOdds || "--"}
                              </span>
                            )}
                            {analysisResults.has(match.id) && analysisResults.get(match.id)!.totalPrediction === "小" && (
                              <span className="text-[11px] font-bold text-blue-400 bg-blue-900/30 px-0.5 rounded">小</span>
                            )}
                          </div>
                          {matchNotes?.totalNote && !matchNotes.totalSettled && (() => {
                            const pn = parseTotalNote(matchNotes.totalNote);
                            const cmp = computeTotalComparison(matchNotes.totalNote, effectiveOverOdds, effectiveUnderOdds, oddsBaseTotal);
                            if (!pn) return null;
                            return (
                              <div className="text-[11px] text-amber-300 leading-tight flex items-center gap-0.5">
                                <span>{pn.underOdds}</span>
                                {cmp && pn.side === "小" && (
                                  <span className={cmp.diff >= 0 ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                                    {cmp.diff >= 0 ? "+" : ""}{cmp.diff.toFixed(2)}
                                  </span>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                      </tr>

                      {/* Company odds rows - show when expanded */}
                      {expandedCompanies.has(match.id) && (() => {
                        const cod = dbCompanyOddsMap.get(match.id);
                        // Show loading state while fetching
                        if (!cod) {
                          return (
                            <tr className="border-b border-gray-800/30 bg-gray-900/40">
                              <td colSpan={15} className="px-4 py-2 text-center text-gray-500 text-[11px]">
                                {fetchingMatches.has(match.id) ? "抓取中..." : "无赔率数据"}
                              </td>
                            </tr>
                          );
                        }
                        const codCompanies = Array.isArray(cod.companies) ? cod.companies : [];
                        if (codCompanies.length === 0) {
                          return (
                            <tr className="border-b border-gray-800/30 bg-gray-900/40">
                              <td colSpan={15} className="px-4 py-2 text-center text-gray-500 text-[11px]">
                                {fetchingMatches.has(match.id) ? "抓取中..." : "无赔率数据"}
                              </td>
                            </tr>
                          );
                        }
                        const selectedCompanies = codCompanies
                          .filter(c => monitorCompanyIds.includes(c.companyId))
                          .sort((a, b) => {
                            const ta = normalizeOpenTime(a.openTime);
                            const tb = normalizeOpenTime(b.openTime);
                            return ta.localeCompare(tb);
                          });
                        const defaultCompanies = selectedCompanies.filter(c => DEFAULT_COMPANY_IDS.includes(c.companyId));
                        const extraCompanies = selectedCompanies.filter(c => !DEFAULT_COMPANY_IDS.includes(c.companyId));
                        // All companies available in data but not currently selected
                        const unselectedCompanies = codCompanies
                          .filter(c => !monitorCompanyIds.includes(c.companyId));
                        const showExtra = expandedCrown.has(match.id);
                        const companiesToShow = showExtra ? selectedCompanies : defaultCompanies;
                        const hasExtra = extraCompanies.length > 0 || unselectedCompanies.length > 0;

                        return companiesToShow.length > 0 ? (
                          <tr className="border-b border-gray-800/30 bg-gray-900/40">
                            <td colSpan={15} className="p-0">
                              <div className="px-4 py-1">
                                <table className="w-full text-[11px]">
                                  <thead>
                                    <tr className="text-gray-500 border-b border-gray-800/40">
                                      <th className="px-1.5 py-0.5 text-left font-normal w-20">开盘时间</th>
                                      <th className="px-1.5 py-0.5 text-left font-normal w-12">公司</th>
                                      <th className="px-1.5 py-0.5 text-center font-normal text-blue-400/60" colSpan={3}>全场亚盘(最新)</th>
                                      <th className="px-1.5 py-0.5 text-center font-normal text-purple-400/60" colSpan={3}>欧转亚盘(初)</th>
                                      <th className="px-1.5 py-0.5 text-center font-normal text-amber-400/60" colSpan={3}>进球数(最新)</th>
                                      <th className="px-1.5 py-0.5 text-center font-normal text-emerald-400/60" colSpan={3}>新数据(亚盘)</th>
                                      <th className="px-1.5 py-0.5 text-center font-normal text-teal-400/60" colSpan={3}>新数据(进球)</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {companiesToShow.map((c) => {
                                      const companyLatest = getCompanyLatestOdds(c);
                                      const latestClass = companyLatest.hasLive ? "text-emerald-300" : "text-gray-400";
                                      return (
                                        <Fragment key={c.companyId}>
                                        <tr className="border-b border-gray-800/20 hover:bg-gray-800/20">
                                          <td className="px-1.5 py-0.5 text-gray-500 whitespace-nowrap">{c.openTime}</td>
                                          <td className="px-1.5 py-0.5 text-cyan-300 font-medium whitespace-nowrap">{c.companyName}</td>
                                          {/* Full-time handicap (latest) */}
                                          <td className={cn("px-1 py-0.5 text-right", latestClass)}>{companyLatest.handicapHome || "--"}</td>
                                          <td className={cn("px-1 py-0.5 text-center font-medium", companyLatest.hasLive ? "text-emerald-200" : "text-white")}>{companyLatest.handicapLine || "--"}</td>
                                          <td className={cn("px-1 py-0.5 text-left", latestClass)}>{companyLatest.handicapAway || "--"}</td>
                                          {/* Euro-to-Asian (initial) */}
                                          <td className="px-1 py-0.5 text-right text-gray-400">{c.euroAsianHome || "--"}</td>
                                          <td className="px-1 py-0.5 text-center text-purple-300 font-medium">{c.euroAsianLine || "--"}</td>
                                          <td className="px-1 py-0.5 text-left text-gray-400">{c.euroAsianAway || "--"}</td>
                                          {/* Total (latest) */}
                                          <td className={cn("px-1 py-0.5 text-right", latestClass)}>{companyLatest.totalOver || "--"}</td>
                                          <td className={cn("px-1 py-0.5 text-center font-medium", companyLatest.hasLive ? "text-emerald-200" : "text-amber-300")}>{companyLatest.totalLine || "--"}</td>
                                          <td className={cn("px-1 py-0.5 text-left", latestClass)}>{companyLatest.totalUnder || "--"}</td>
                                          {/* Crown new data (新数据) - only for Crown (companyId=3) */}
                                          {c.companyId === "3" && (() => {
                                            const c12 = crown12OddsFromDb.get(match.id);
                                            return c12 ? (
                                              <>
                                                <td className="px-1 py-0.5 text-right text-emerald-400">{c12.handicapHome || "--"}</td>
                                                <td className="px-1 py-0.5 text-center text-emerald-300 font-medium">{c12.handicapLine || "--"}</td>
                                                <td className="px-1 py-0.5 text-left text-emerald-400">{c12.handicapAway || "--"}</td>
                                                <td className="px-1 py-0.5 text-right text-teal-400">{c12.totalOver || "--"}</td>
                                                <td className="px-1 py-0.5 text-center text-teal-300 font-medium">{c12.totalLine || "--"}</td>
                                                <td className="px-1 py-0.5 text-left text-teal-400">{c12.totalUnder || "--"}</td>
                                              </>
                                            ) : (
                                              <>
                                                <td className="px-1 py-0.5 text-center text-gray-600" colSpan={6}>--</td>
                                              </>
                                            );
                                          })()}
                                          {c.companyId !== "3" && (
                                            <td className="px-1 py-0.5 text-center text-gray-700" colSpan={6}>--</td>
                                          )}
                                        </tr>
                                        {/* Crown terminal odds (终盘) sub-row */}
                                        {c.companyId === "3" && (() => {
                                          const cl = crownLiveOddsFromDb.get(match.id);
                                          if (!cl || (!cl.handicapLine && !cl.totalLine)) return null;
                                          return (
                                            <tr className="border-b border-gray-800/10 bg-gray-900/20">
                                              <td className="px-1.5 py-0.5 text-right text-gray-500 text-[11px] italic" colSpan={11}>终盘</td>
                                              <td className="px-1 py-0.5 text-right text-gray-400">{cl.handicapHome || "--"}</td>
                                              <td className="px-1 py-0.5 text-center text-gray-300 font-medium">{cl.handicapLine || "--"}</td>
                                              <td className="px-1 py-0.5 text-left text-gray-400">{cl.handicapAway || "--"}</td>
                                              <td className="px-1 py-0.5 text-right text-gray-400">{cl.totalOver || "--"}</td>
                                              <td className="px-1 py-0.5 text-center text-gray-300 font-medium">{cl.totalLine || "--"}</td>
                                              <td className="px-1 py-0.5 text-left text-gray-400">{cl.totalUnder || "--"}</td>
                                            </tr>
                                          );
                                        })()}
                                        </Fragment>
                                      );
                                    })}
                                  </tbody>
                                </table>
                                {hasExtra && (
                                  <div className="mt-1 flex flex-wrap items-center gap-1">
                                    <button
                                      className="text-[11px] text-blue-400 hover:text-blue-300 underline mr-2"
                                      onClick={() => {
                                        setExpandedCrown(prev => {
                                          const next = new Set(prev);
                                          if (next.has(match.id)) next.delete(match.id);
                                          else next.add(match.id);
                                          return next;
                                        });
                                      }}
                                    >
                                      {showExtra ? "收起" : `展开已选公司 (+${extraCompanies.length})`}
                                    </button>
                                    {/* Company selector: show unselected companies as toggle buttons */}
                                    {unselectedCompanies.length > 0 && (
                                      <>
                                        <span className="text-[11px] text-gray-600">添加公司:</span>
                                        {unselectedCompanies
                                          .sort((a, b) => {
                                            const ta = normalizeOpenTime(a.openTime);
                                            const tb = normalizeOpenTime(b.openTime);
                                            return ta.localeCompare(tb);
                                          })
                                          .map(c => (
                                            <button
                                              key={c.companyId}
                                              className="text-[11px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-500 hover:text-cyan-300 hover:border-cyan-600 transition-colors"
                                              onClick={() => {
                                                setMonitorCompanyIds(prev => [...prev, c.companyId]);
                                              }}
                                            >
                                              {c.companyName}
                                            </button>
                                          ))
                                        }
                                      </>
                                    )}
                                    {/* Show selected extra companies with remove option */}
                                    {extraCompanies.length > 0 && showExtra && (
                                      <>
                                        <span className="text-[11px] text-gray-600 ml-2">已选:</span>
                                        {extraCompanies.map(c => (
                                          <button
                                            key={c.companyId}
                                            className="text-[11px] px-1.5 py-0.5 rounded border border-cyan-700 text-cyan-300 hover:text-red-300 hover:border-red-600 transition-colors"
                                            onClick={() => {
                                              setMonitorCompanyIds(prev => prev.filter(id => id !== c.companyId));
                                            }}
                                          >
                                            {c.companyName} ✕
                                          </button>
                                        ))}
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        ) : null;
                      })()}
                      {/* AI Analysis result row in odds monitor - only shown when expanded */}
                      {analysisResults.has(match.id) && analysisExpanded === match.id && (
                        <tr className="border-b border-border/70 bg-surface-1/60">
                          <td colSpan={15} className="p-2 sm:p-3">
                            {(() => {
                              const ar = analysisResults.get(match.id)!;
                              return (
                                <AIAnalysisResultPanel
                                  panelId={`odds-monitor-${match.id}`}
                                  analysis={ar}
                                  analyzedAtLabel={formatAnalysisTime(ar.analyzedAt)}
                                  purchaseAdvice={buildPurchaseAdvice(ar, latestOdds)}
                                  patterns={evolutionStats?.topPatterns}
                                  messages={chatMessages.get(match.id) || []}
                                  isDetailExpanded
                                  isChatOpen={chatOpen === match.id}
                                  chatInput={chatOpen === match.id ? chatInput : ""}
                                  chatStreaming={chatStreaming}
                                  onToggleDetail={() => setAnalysisExpanded(null)}
                                  onToggleChat={() => setChatOpen(chatOpen === match.id ? null : match.id)}
                                  onChatInputChange={setChatInput}
                                  onSendChat={() => sendChatMessage(match.id, chatInput)}
                                />
                              );
                            })()}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Legend + base total */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="odds-status-chip"><span className="text-red-300" aria-hidden="true">↑</span> 上升</span>
          <span className="odds-status-chip"><span className="text-emerald-300" aria-hidden="true">↓</span> 下降</span>
          <label className="odds-status-chip">
            <span>赔率基准</span>
            <input
              type="number"
              step="0.01"
              min="1"
              className="h-6 w-16 rounded border border-border bg-surface-3 px-1.5 text-center font-mono text-xs text-foreground outline-none focus:border-ring"
              value={oddsBaseTotal}
              onChange={(e) => setOddsBaseTotal(parseFloat(e.target.value) || 1.90)}
            />
          </label>
        </div>

        {/* Completed pinned matches section */}
        {completedPinnedMatches.length > 0 && (
          <div className="mt-4">
            <div className="match-group-title">
              <MatchStatusBadge state="-1" />
              <span>已完场置顶赛事</span>
              <strong>{completedPinnedMatches.length}</strong>
            </div>
            <div className="odds-table-wrap">
              <table className="w-full text-xs">
                <tbody>
                  {completedPinnedMatches.map((pm) => {
                    const pmNotes = notes.get(pm.id);
                    return (
                      <tr key={pm.id} className="match-row--finished border-b border-gray-800/30">
                        <td className="px-1 py-0.5 text-center w-7">
                          <button
                            className="inline-flex items-center justify-center w-5 h-5 rounded hover:bg-gray-700/50 text-blue-400"
                            onClick={() => togglePin(pm.id)}
                            title="取消置顶"
                          >
                            <Pin className="w-3 h-3" />
                          </button>
                        </td>
                        <td className="px-1 py-0.5 text-center w-7">
                          <MatchStatusBadge state="-1" />
                        </td>
                        <td className="px-1 py-0.5 text-center w-7">
                          {pmNotes && (
                            <button
                              className="inline-flex items-center justify-center w-5 h-5 rounded hover:bg-gray-700/50 text-emerald-400"
                              onClick={() => openNoteDialog(pm.id)}
                              title="编辑笔记"
                            >
                              <StickyNote className="w-3 h-3" />
                            </button>
                          )}
                        </td>
                        <td className="px-2 py-0.5">
                          <div className="flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: `#${pm.leagueColor}` }} />
                            <span className="text-gray-500 truncate max-w-[80px] leading-tight">{pm.league}</span>
                          </div>
                        </td>
                        <td className="px-2 py-0.5 text-center font-mono text-gray-500 leading-tight w-12">
                          {pm.time}
                        </td>
                        <td className="px-2 py-0.5 text-right leading-tight">
                          <span className="text-gray-400">{pm.homeTeam}</span>
                        </td>
                        <td className="px-2 py-0.5 text-center leading-tight w-[110px]">
                          <div className="flex flex-col items-center">
                            <span className="text-gray-500 whitespace-nowrap">
                              {pm.handicap || "--"} | {pm.homeOdds || "--"}/{pm.awayOdds || "--"}
                            </span>
                            {pmNotes?.handicapNote && (
                              <span className="text-[11px] text-amber-300/70 bg-amber-900/20 px-1.5 rounded mt-0.5 truncate max-w-full leading-snug">
                                {pmNotes.handicapNote}{pmNotes.handicapAmount ? ` (${pmNotes.handicapAmount})` : ""}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-0.5 text-left leading-tight">
                          <span className="text-gray-400">{pm.awayTeam}</span>
                        </td>
                        <td className="px-2 py-0.5 text-center leading-tight w-[110px]">
                          <div className="flex flex-col items-center">
                            <span className="text-gray-500 whitespace-nowrap">
                              {pm.totalLine || "--"} | {pm.overOdds || "--"}/{pm.underOdds || "--"}
                            </span>
                            {pmNotes?.totalNote && (
                              <span className="text-[11px] text-amber-300/70 bg-amber-900/20 px-1.5 rounded mt-0.5 truncate max-w-full leading-snug">
                                {pmNotes.totalNote}{pmNotes.totalAmount ? ` (${pmNotes.totalAmount})` : ""}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* In-progress / finished matches section */}
        {otherStateMatches.length > 0 && (
          <div className="mt-4">
            <div className="match-group-title">
              <span>其他赛况</span>
              <strong>{otherStateMatches.length}</strong>
              <span>包含进行、中场、完场及未知状态</span>
            </div>
            <div className="odds-table-wrap">
              <table className="w-full text-xs">
                <tbody>
                  {otherStateMatches.map((match) => {
                    const isPinned = pinnedMatches.has(match.id);
                    const matchNotes = notes.get(match.id);
                    const rowClass = getMatchRowClass(match.state);
                    // Prefer Crown liveOdds parsed from the legacy allCompOdds page.
                    const cod = dbCompanyOddsMap.get(match.id);
                    const codCompanies = Array.isArray(cod?.companies) ? cod.companies : [];
                    const crown = codCompanies.find(c => c.companyId === "3");
                    const crownCompanyLive = crown && (crown.ftHandicapLineLive || crown.ftTotalLineLive) ? {
                      handicapHome: crown.ftHandicapHomeLive,
                      handicapLine: crown.ftHandicapLineLive,
                      handicapAway: crown.ftHandicapAwayLive,
                      totalOver: crown.ftTotalOverLive,
                      totalLine: crown.ftTotalLineLive,
                      totalUnder: crown.ftTotalUnderLive,
                    } : null;
                    const storedCrownLive = crownLiveOddsFromDb.get(match.id);
                    const hasStoredCrownLive = !!storedCrownLive && (!!storedCrownLive.handicapLine || !!storedCrownLive.totalLine);
                    const displayOdds = crownCompanyLive || (hasStoredCrownLive ? storedCrownLive : null);
                    // Crown 12 odds (新数据) from DB
                    const crown12Data = crown12OddsFromDb.get(match.id);
                    const hasCrown12 = crown12Data && (crown12Data.handicapLine || crown12Data.totalLine);
                    return (
                      <React.Fragment key={match.id}>
                        <tr className={cn("border-b border-gray-800/30", rowClass)}>
                          <td className="px-0.5 py-0.5 text-center w-5">
                            <button
                              className="inline-flex items-center justify-center w-4 h-5 rounded hover:bg-gray-700/50 text-gray-500 hover:text-gray-300 transition-transform"
                              onClick={() => {
                                const isExpanded = expandedCompanies.has(match.id);
                                setExpandedCompanies(prev => {
                                  const next = new Set(prev);
                                  if (next.has(match.id)) next.delete(match.id);
                                  else next.add(match.id);
                                  return next;
                                });
                                const oddsData = dbCompanyOddsMap.get(match.id);
                                const hasCompanies = Array.isArray(oddsData?.companies) && oddsData.companies.length > 0;
                                if (!isExpanded && !hasCompanies && !fetchingMatches.has(match.id)) {
                                  fetchSingleMatchOdds(match.id);
                                }
                              }}
                            >
                              <ChevronDown className={cn("w-3 h-3 transition-transform", expandedCompanies.has(match.id) && "rotate-180")} />
                            </button>
                          </td>
                          <td className="px-1 py-0.5 text-center w-7">
                            <button
                              className={cn(
                                "inline-flex items-center justify-center w-5 h-5 rounded hover:bg-gray-700/50",
                                isPinned ? "text-blue-400" : "text-gray-600"
                              )}
                              onClick={() => togglePin(match.id)}
                              title={isPinned ? "取消置顶" : "置顶"}
                            >
                              <Pin className="w-3 h-3" />
                            </button>
                          </td>
                          <td className="px-1 py-0.5 text-center w-7">
                            <MatchStatusBadge state={match.state} />
                          </td>
                          <td className="px-1 py-0.5 text-center w-7">
                            {matchNotes && (
                              <button
                                className="inline-flex items-center justify-center w-5 h-5 rounded hover:bg-gray-700/50 text-emerald-400"
                                onClick={() => openNoteDialog(match.id)}
                                title="编辑笔记"
                              >
                                <StickyNote className="w-3 h-3" />
                              </button>
                            )}
                          </td>
                          <td className="px-1 py-0.5 text-center w-7">
                            {dataScheduleMode !== "history" && (
                              <button
                                className={cn(
                                  "inline-flex items-center justify-center w-5 h-5 rounded hover:bg-gray-700/50 transition-colors",
                                  analysisResults.has(match.id) ? "text-purple-400" : "text-gray-600 hover:text-purple-400",
                                  analyzingMatchId === match.id && "animate-pulse text-purple-400"
                                )}
                                onClick={() => {
                                  if (analysisResults.has(match.id)) {
                                    const nextExp = analysisExpanded === match.id ? null : match.id; setAnalysisExpanded(nextExp); if (nextExp) loadAnalysisDetail(nextExp);
                                  } else {
                                    analyzeSingleMatch(match.id, true);
                                  }
                                }}
                                disabled={!!analyzingMatchId}
                                title={analyzingMatchId === match.id ? "AI分析中" : "AI分析"}
                              >
                              {analyzingMatchId === match.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                            </button>
                            )}
                          </td>
                          <td className="px-2 py-0.5">
                            <div className="flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: `#${match.leagueColor}` }} />
                              <span className="text-gray-500 truncate max-w-[80px] leading-tight">{match.league}</span>
                            </div>
                          </td>
                          <td className="px-2 py-0.5 text-center leading-tight w-[76px]">
                            <MatchSituation
                              state={match.state}
                              time={match.time}
                              homeScore={match.homeScore}
                              awayScore={match.awayScore}
                              halfHomeScore={match.halfHomeScore}
                              halfAwayScore={match.halfAwayScore}
                              showBadge={false}
                            />
                          </td>
                          <td className="px-2 py-0.5 text-right leading-tight">
                            <span className="text-gray-400">{match.homeTeam}{match.homeRank && <span className="text-gray-600 text-[11px] ml-0.5">[{match.homeRank}]</span>}</span>
                          </td>
                          <td className="px-1 py-0.5 text-right leading-tight">
                            <span className="text-gray-500">{displayOdds ? (displayOdds.handicapHome || "--") : "--"}</span>
                          </td>
                          <td className="px-1 py-0.5 text-center font-bold leading-tight">
                            <a
                              href={`https://vip.titan007.com/changeDetail/3in1Odds.aspx?id=${match.id}&companyid=3&l=0`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:opacity-80"
                            >
                              <span className="text-gray-400">{displayOdds ? (formatHandicapLine(displayOdds.handicapLine || "") || "--") : "--"}</span>
                            </a>
                          </td>
                          <td className="px-1 py-0.5 text-left leading-tight">
                            <span className="text-gray-500">{displayOdds ? (displayOdds.handicapAway || "--") : "--"}</span>
                          </td>
                          <td className="px-2 py-0.5 text-left leading-tight">
                            <span className="text-gray-400">{match.awayTeam}{match.awayRank && <span className="text-gray-600 text-[11px] ml-0.5">[{match.awayRank}]</span>}</span>
                            {hasCrown12 && (
                              <div className="mt-0.5 space-y-0">
                                {crown12Data.handicapHome && (
                                  <a
                                    href={`https://vip.titan007.com/changeDetail/3in1Odds.aspx?id=${match.id}&companyid=3&l=0`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-0.5 text-[11px] text-gray-500 hover:text-gray-300 leading-tight"
                                  >
                                    <span>{crown12Data.handicapHome}</span>
                                    <span className="font-bold text-gray-400">{crown12Data.handicapLine}</span>
                                    <span>{crown12Data.handicapAway}</span>
                                  </a>
                                )}
                                {crown12Data.totalOver && (
                                  <div className="flex items-center gap-0.5 text-[11px] text-gray-500 leading-tight">
                                    <span>{crown12Data.totalOver}</span>
                                    <span className="font-bold text-gray-400">{crown12Data.totalLine}</span>
                                    <span>{crown12Data.totalUnder}</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-1 py-0.5 text-right leading-tight">
                            <span className="text-gray-500">{displayOdds ? (displayOdds.totalOver || "--") : "--"}</span>
                          </td>
                          <td className="px-1 py-0.5 text-center font-bold leading-tight">
                            <span className="text-gray-400">{displayOdds ? (displayOdds.totalLine || "--") : "--"}</span>
                          </td>
                          <td className="px-1 py-0.5 text-left leading-tight">
                            <span className="text-gray-500">{displayOdds ? (displayOdds.totalUnder || "--") : "--"}</span>
                          </td>
                        </tr>
                        {/* Expanded company odds rows */}
                        {expandedCompanies.has(match.id) && (() => {
                          const cod = dbCompanyOddsMap.get(match.id);
                          if (!cod) {
                            return (
                              <tr className="border-b border-gray-800/30 bg-gray-900/40">
                                <td colSpan={15} className="px-4 py-2 text-center text-gray-500 text-[11px]">
                                  {fetchingMatches.has(match.id) ? "抓取中..." : "无赔率数据"}
                                </td>
                              </tr>
                            );
                          }
                          const codCompanies = Array.isArray(cod.companies) ? cod.companies : [];
                          if (codCompanies.length === 0) {
                            return (
                              <tr className="border-b border-gray-800/30 bg-gray-900/40">
                                <td colSpan={15} className="px-4 py-2 text-center text-gray-500 text-[11px]">
                                  {fetchingMatches.has(match.id) ? "抓取中..." : "无赔率数据"}
                                </td>
                              </tr>
                            );
                          }
                          const selectedCompanies = codCompanies
                            .filter(c => monitorCompanyIds.includes(c.companyId))
                            .sort((a, b) => {
                              const ta = normalizeOpenTime(a.openTime);
                              const tb = normalizeOpenTime(b.openTime);
                              return ta.localeCompare(tb);
                            });
                          const defaultCompanies = selectedCompanies.filter(c => DEFAULT_COMPANY_IDS.includes(c.companyId));
                          const extraCompanies = selectedCompanies.filter(c => !DEFAULT_COMPANY_IDS.includes(c.companyId));
                          const showExtra = expandedCrown.has(match.id);
                          const companiesToShow = showExtra ? selectedCompanies : defaultCompanies;
                          const hasExtra = extraCompanies.length > 0;

                          return companiesToShow.length > 0 ? (
                            <tr className="border-b border-gray-800/30 bg-gray-900/40">
                              <td colSpan={15} className="p-0">
                                <div className="px-4 py-1">
                                  <table className="w-full text-[11px]">
                                    <thead>
                                      <tr className="text-gray-500 border-b border-gray-800/40">
                                        <th className="px-1.5 py-0.5 text-left font-normal w-20">开盘时间</th>
                                        <th className="px-1.5 py-0.5 text-left font-normal w-12">公司</th>
                                        <th className="px-1.5 py-0.5 text-center font-normal text-blue-400/60" colSpan={3}>全场亚盘(初)</th>
                                        <th className="px-1.5 py-0.5 text-center font-normal text-purple-400/60" colSpan={3}>欧转亚盘(初)</th>
                                        <th className="px-1.5 py-0.5 text-center font-normal text-amber-400/60" colSpan={3}>进球数(初)</th>
                                        <th className="px-1.5 py-0.5 text-center font-normal text-emerald-400/60" colSpan={3}>新数据(亚盘)</th>
                                        <th className="px-1.5 py-0.5 text-center font-normal text-teal-400/60" colSpan={3}>新数据(进球)</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {companiesToShow.map((c) => (
                                        <Fragment key={c.companyId}>
                                        <tr className="border-b border-gray-800/20 hover:bg-gray-800/20">
                                          <td className="px-1.5 py-0.5 text-gray-500 whitespace-nowrap">{c.openTime}</td>
                                          <td className="px-1.5 py-0.5 text-cyan-300 font-medium whitespace-nowrap">{c.companyName}</td>
                                          <td className="px-1 py-0.5 text-right text-gray-400">{c.ftHandicapHome || "--"}</td>
                                          <td className="px-1 py-0.5 text-center text-white font-medium">{c.ftHandicapLine || "--"}</td>
                                          <td className="px-1 py-0.5 text-left text-gray-400">{c.ftHandicapAway || "--"}</td>
                                          <td className="px-1 py-0.5 text-right text-gray-400">{c.euroAsianHome || "--"}</td>
                                          <td className="px-1 py-0.5 text-center text-purple-300 font-medium">{c.euroAsianLine || "--"}</td>
                                          <td className="px-1 py-0.5 text-left text-gray-400">{c.euroAsianAway || "--"}</td>
                                          <td className="px-1 py-0.5 text-right text-gray-400">{c.ftTotalOver || "--"}</td>
                                          <td className="px-1 py-0.5 text-center text-amber-300 font-medium">{c.ftTotalLine || "--"}</td>
                                          <td className="px-1 py-0.5 text-left text-gray-400">{c.ftTotalUnder || "--"}</td>
                                          {/* Crown new data (新数据) - only for Crown (companyId=3) */}
                                          {c.companyId === "3" && (() => {
                                            const c12 = crown12OddsFromDb.get(match.id);
                                            return c12 ? (
                                              <>
                                                <td className="px-1 py-0.5 text-right text-emerald-400">{c12.handicapHome || "--"}</td>
                                                <td className="px-1 py-0.5 text-center text-emerald-300 font-medium">{c12.handicapLine || "--"}</td>
                                                <td className="px-1 py-0.5 text-left text-emerald-400">{c12.handicapAway || "--"}</td>
                                                <td className="px-1 py-0.5 text-right text-teal-400">{c12.totalOver || "--"}</td>
                                                <td className="px-1 py-0.5 text-center text-teal-300 font-medium">{c12.totalLine || "--"}</td>
                                                <td className="px-1 py-0.5 text-left text-teal-400">{c12.totalUnder || "--"}</td>
                                              </>
                                            ) : (
                                              <>
                                                <td className="px-1 py-0.5 text-center text-gray-600" colSpan={6}>--</td>
                                              </>
                                            );
                                          })()}
                                          {c.companyId !== "3" && (
                                            <td className="px-1 py-0.5 text-center text-gray-700" colSpan={6}>--</td>
                                          )}
                                        </tr>
                                        {/* Crown terminal odds (终盘) sub-row */}
                                        {c.companyId === "3" && (() => {
                                          const cl = crownLiveOddsFromDb.get(match.id);
                                          if (!cl || (!cl.handicapLine && !cl.totalLine)) return null;
                                          return (
                                            <tr className="border-b border-gray-800/10 bg-gray-900/20">
                                              <td className="px-1.5 py-0.5 text-right text-gray-500 text-[11px] italic" colSpan={11}>终盘</td>
                                              <td className="px-1 py-0.5 text-right text-gray-400">{cl.handicapHome || "--"}</td>
                                              <td className="px-1 py-0.5 text-center text-gray-300 font-medium">{cl.handicapLine || "--"}</td>
                                              <td className="px-1 py-0.5 text-left text-gray-400">{cl.handicapAway || "--"}</td>
                                              <td className="px-1 py-0.5 text-right text-gray-400">{cl.totalOver || "--"}</td>
                                              <td className="px-1 py-0.5 text-center text-gray-300 font-medium">{cl.totalLine || "--"}</td>
                                              <td className="px-1 py-0.5 text-left text-gray-400">{cl.totalUnder || "--"}</td>
                                            </tr>
                                          );
                                        })()}
                                        </Fragment>
                                      ))}
                                    </tbody>
                                  </table>
                                  {hasExtra && (
                                    <button
                                      className="mt-0.5 text-[11px] text-blue-400 hover:text-blue-300 underline"
                                      onClick={() => {
                                        setExpandedCrown(prev => {
                                          const next = new Set(prev);
                                          if (next.has(match.id)) next.delete(match.id);
                                          else next.add(match.id);
                                          return next;
                                        });
                                      }}
                                    >
                                      {showExtra ? "收起" : `展开更多公司 (+${extraCompanies.length})`}
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ) : (
                            <tr className="border-b border-gray-800/30 bg-gray-900/40">
                              <td colSpan={15} className="px-4 py-2 text-center text-gray-500 text-[11px]">无赔率数据</td>
                            </tr>
                          );
                        })()}
                      {/* AI Analysis result row for other state matches */}
                      {analysisResults.has(match.id) && (
                        <tr className="border-b border-border/70 bg-surface-1/60">
                          <td colSpan={15} className="p-2 sm:p-3">
                            {(() => {
                              const ar = analysisResults.get(match.id)!;
                              const isExp = analysisExpanded === match.id;
                              return (
                                <AIAnalysisResultPanel
                                  panelId={`other-state-${match.id}`}
                                  analysis={ar}
                                  analyzedAtLabel={formatAnalysisTime(ar.analyzedAt)}
                                  purchaseAdvice={buildPurchaseAdvice(ar, getMatchLatestOdds(match, crown))}
                                  patterns={evolutionStats?.topPatterns}
                                  messages={chatMessages.get(match.id) || []}
                                  isDetailExpanded={isExp}
                                  isChatOpen={chatOpen === match.id}
                                  chatInput={chatOpen === match.id ? chatInput : ""}
                                  chatStreaming={chatStreaming}
                                  showVerification
                                  onToggleDetail={() => {
                                    const next = isExp ? null : match.id;
                                    setAnalysisExpanded(next);
                                    if (next) loadAnalysisDetail(next);
                                  }}
                                  onToggleChat={() => setChatOpen(chatOpen === match.id ? null : match.id)}
                                  onChatInputChange={setChatInput}
                                  onSendChat={() => sendChatMessage(match.id, chatInput)}
                                  verifyingMarket={verifyingMarketKey?.startsWith(`${match.id}:`) ? verifyingMarketKey.split(":")[1] as PredictionMarket : null}
                                  onVerify={(market, value) => manualVerify(match.id, market, value)}
                                />
                              );
                            })()}
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        </>
        )}

        {/* Report Tab */}
        {activeTab === "report" && (
          <div className="space-y-4">
            {/* Report controls */}
            <div className="flex items-center gap-3 flex-wrap">
              <Button
                className="bg-blue-600 hover:bg-blue-700"
                onClick={generateReport}
                disabled={reportLoading}
              >
                {reportLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <FileBarChart className="w-4 h-4 mr-1" />}
                {reportLoading ? "正在生成报表…" : "生成AI报表"}
              </Button>

              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-gray-400" />
                <select
                  className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded px-2 py-1.5"
                  value={selectedReportDate}
                  onChange={(e) => loadReport(e.target.value)}
                >
                  <option value="">选择日期</option>
                  {reportDates.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>

              <Button
                variant="outline"
                size="sm"
                className="text-gray-300 border-gray-700"
                onClick={loadReportTrend}
              >
                刷新趋势
              </Button>
            </div>

            {/* Report content */}
            {filteredReportData && (
              <>
                {/* 双市场加权统计 */}
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                  {([
                    {
                      key: "handicap",
                      title: "让球加权准确率",
                      summary: filteredReportData.summary.markets?.handicap,
                      correct: filteredReportData.summary.correct,
                      wrong: filteredReportData.summary.wrong,
                      total: filteredReportData.summary.total,
                      legacyAccuracy: filteredReportData.summary.accuracy,
                    },
                    {
                      key: "total",
                      title: "进球加权准确率",
                      summary: filteredReportData.summary.markets?.total,
                      correct: filteredReportData.summary.totalCorrect || 0,
                      wrong: filteredReportData.summary.totalWrong || 0,
                      total: filteredReportData.summary.totalTotal || 0,
                      legacyAccuracy: filteredReportData.summary.totalAccuracy || "N/A",
                    },
                  ] as const).map(item => {
                    const accuracy = item.summary?.weightedAccuracy;
                    const accuracyLabel = accuracy === null
                      ? "N/A"
                      : accuracy === undefined ? item.legacyAccuracy : `${(accuracy * 100).toFixed(1)}%`;
                    const weightedCorrect = item.summary?.weightedCorrect ?? item.correct;
                    const weightedWrong = item.summary?.weightedWrong ?? item.wrong;
                    const weightedTotal = item.summary?.weightedTotal ?? item.total;
                    const scored = item.summary?.scoredCounts;
                    return (
                      <section key={item.key} className="odds-metric-card p-3" aria-label={item.title}>
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="text-xs font-medium text-gray-400">{item.title}</div>
                            <div className="mt-1 text-2xl font-bold text-blue-400 tabular-nums">{accuracyLabel}</div>
                          </div>
                          <div className="text-right text-xs text-gray-500">
                            <div>加权正确 <span className="font-semibold text-emerald-400 tabular-nums">{weightedCorrect}</span></div>
                            <div>加权错误 <span className="font-semibold text-red-400 tabular-nums">{weightedWrong}</span></div>
                            <div>加权分母 <span className="font-semibold text-white tabular-nums">{weightedTotal}</span></div>
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-5 gap-1 text-center text-[11px]">
                          {[
                            ["赢盘", scored?.win || 0],
                            ["赢半", scored?.half_win || 0],
                            ["走盘", scored?.push || 0],
                            ["输半", scored?.half_loss || 0],
                            ["输盘", scored?.loss || 0],
                          ].map(([label, value]) => (
                            <div key={label} className="rounded border border-gray-800 bg-gray-950/40 px-1 py-1">
                              <span className="block text-gray-500">{label}</span>
                              <strong className="text-gray-200 tabular-nums">{value}</strong>
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 text-[11px] text-gray-500">
                          普通赛果场次 {item.summary?.eligible ?? 0}；走盘及不可结算记录不进入加权分母
                        </div>
                      </section>
                    );
                  })}
                </div>

                {/* 置信度统计 */}
                <div className="grid grid-cols-1 gap-3">
                  <div className="odds-metric-card p-3">
                    <div className="text-xs text-gray-400 mb-2 font-medium">置信度准确率</div>
                    <div className="flex items-center gap-3 text-xs">
                      <div className="flex items-center gap-1">
                        <span className="text-red-400 font-bold">高</span>
                        <span className="text-white">{filteredReportData.summary.highConf?.accuracy || "0"}%</span>
                        <span className="text-gray-500">({filteredReportData.summary.highConf?.correct || 0}/{filteredReportData.summary.highConf?.total || 0})</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-yellow-400 font-bold">中</span>
                        <span className="text-white">{filteredReportData.summary.midConf?.accuracy || "0"}%</span>
                        <span className="text-gray-500">({filteredReportData.summary.midConf?.correct || 0}/{filteredReportData.summary.midConf?.total || 0})</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-gray-400 font-bold">低</span>
                        <span className="text-white">{filteredReportData.summary.lowConf?.accuracy || "0"}%</span>
                        <span className="text-gray-500">({filteredReportData.summary.lowConf?.correct || 0}/{filteredReportData.summary.lowConf?.total || 0})</span>
                      </div>
                      {((filteredReportData.summary.unverified || 0) > 0) && (
                        <div className="ml-auto text-gray-500">未验证 {filteredReportData.summary.unverified} 场</div>
                      )}
                    </div>
                  </div>
                </div>

                {/* 7天趋势图 */}
                {reportTrend.length > 1 && (
                  <div className="odds-metric-card p-3">
                    <div className="text-xs text-gray-400 mb-2 font-medium">准确率趋势（近14天）</div>
                    <div className="flex items-end gap-1 h-24">
                      {reportTrend.map((t, i) => {
                        const maxH = 100;
                        const h = Math.max(4, (t.accuracy / 100) * maxH);
                        return (
                          <div key={i} className="flex-1 flex flex-col items-center gap-0.5 min-w-0">
                            <span className="text-[11px] text-gray-400">{t.accuracy.toFixed(0)}%</span>
                            <div
                              className={cn(
                                "w-full rounded-t transition-all",
                                t.accuracy >= 60 ? "bg-green-600/60" : t.accuracy >= 40 ? "bg-yellow-600/60" : "bg-red-600/60"
                              )}
                              style={{ height: `${h}px` }}
                            />
                            <span className="text-[11px] text-gray-500 truncate w-full text-center">
                              {t.date.slice(5)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-3 mt-2 text-[11px] text-gray-500">
                      <span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-600/60 rounded-sm inline-block" /> ≥60%</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 bg-yellow-600/60 rounded-sm inline-block" /> 40-60%</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 bg-red-600/60 rounded-sm inline-block" /> &lt;40%</span>
                    </div>
                  </div>
                )}

                {/* Report date */}
                <div className="flex items-center gap-4 text-sm text-gray-400">
                  <span>报表日期: {filteredReportData.date}</span>
                  <span title={filteredReportData.latestAnalysisAt || undefined}>
                    最后分析: {formatAnalysisTime(filteredReportData.latestAnalysisAt)}
                  </span>
                </div>

                {/* Report table */}
                <div className="odds-table-wrap">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-800/80 border-b border-gray-700">
                        <th className="px-0.5 py-1.5 text-center text-gray-400 font-medium w-5"></th>
                        <th className="px-1 py-1.5 text-center text-gray-400 font-medium w-5"></th>
                        <th className="px-2 py-1.5 text-center text-gray-400 font-medium">让球验证</th>
                        <th className="px-2 py-1.5 text-center text-gray-400 font-medium">进球验证</th>
                        <th className="px-2 py-1.5 text-left text-gray-400 font-medium">联赛</th>
                        <th className="px-2 py-1.5 text-center text-gray-400 font-medium">时间</th>
                        <th className="px-2 py-1.5 text-right text-gray-400 font-medium">主队</th>
                        <th className="px-2 py-1.5 text-left text-gray-400 font-medium">客队</th>
                        <th className="px-2 py-1.5 text-center text-gray-400 font-medium">新数据</th>
                        <th className="px-2 py-1.5 text-center text-gray-400 font-medium">终盘</th>
                        <th className="px-2 py-1.5 text-center text-gray-400 font-medium">水位方向</th>
                        <th className="px-2 py-1.5 text-center text-gray-400 font-medium">预测对错</th>
                        <th className="px-2 py-1.5 text-center text-gray-400 font-medium">操作</th>
                        <th className="px-2 py-1.5 text-center text-gray-400 font-medium">大小球</th>
                        <th className="px-2 py-1.5 text-center text-gray-400 font-medium">信心</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredReportData.rows.map((row, idx) => {
                        const rowResult = row.waterResult || row.handicapResult || row.result;
                        return (
                          <React.Fragment key={idx}>
                            <tr className={cn(
                              "border-b border-gray-800/30",
                              rowResult === "-" ? "bg-green-950/10" : rowResult === "+" ? "bg-red-950/10" : "bg-gray-900/10"
                            )}>
                              {/* Expand company odds */}
                              <td className="px-0.5 py-0.5 text-center w-5">
                                <button
                                  className="inline-flex items-center justify-center w-4 h-5 rounded hover:bg-gray-700/50 text-gray-500 hover:text-gray-300 transition-transform"
                                  onClick={() => {
                                    const isExpanded = reportExpandedCompanies.has(row.matchId);
                                    setReportExpandedCompanies(prev => {
                                      const next = new Set(prev);
                                      if (next.has(row.matchId)) next.delete(row.matchId);
                                      else next.add(row.matchId);
                                      return next;
                                    });
                                    const oddsData = dbCompanyOddsMap.get(row.matchId);
                                    const hasCompanies = Array.isArray(oddsData?.companies) && oddsData.companies.length > 0;
                                    if (!isExpanded && !hasCompanies && !fetchingMatches.has(row.matchId)) {
                                      fetchSingleMatchOdds(row.matchId);
                                    }
                                  }}
                                >
                                  <ChevronDown className={cn("w-3 h-3 transition-transform", reportExpandedCompanies.has(row.matchId) && "rotate-180")} />
                                </button>
                              </td>
                              {/* AI Analysis */}
                              <td className="px-1 py-0.5 text-center">
                                {analysisResults.has(row.matchId) ? (
                                  <button
                                    className={cn(
                                      "inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[11px] font-bold transition-colors",
                                      analysisResults.get(row.matchId)!.waterDirection === "主降水" ? "bg-blue-900/30 text-blue-400 hover:bg-blue-900/50" :
                                      analysisResults.get(row.matchId)!.waterDirection === "客降水" ? "bg-orange-900/30 text-orange-400 hover:bg-orange-900/50" :
                                      "bg-gray-700/30 text-gray-400 hover:bg-gray-700/50",
                                      analysisExpanded === row.matchId && "ring-1 ring-purple-500/50"
                                    )}
                                    onClick={() => { const next = analysisExpanded === row.matchId ? null : row.matchId; setAnalysisExpanded(next); if (next) loadAnalysisDetail(next); }}
                                    title={`水位: ${analysisResults.get(row.matchId)!.waterDirection} ${analysisResults.get(row.matchId)!.prediction} · 模型自评 ${analysisResults.get(row.matchId)!.accuracy}`}
                                  >
                                    {analysisResults.get(row.matchId)!.waterDirection === "主降水" ? "▼主" : analysisResults.get(row.matchId)!.waterDirection === "客降水" ? "▼客" : "→"}
                                    {analysisResults.get(row.matchId)!.prediction}
                                  </button>
                                ) : (
                                  <button
                                    className={cn(
                                      "inline-flex items-center justify-center w-5 h-5 rounded hover:bg-gray-700/50 transition-colors text-gray-600 hover:text-purple-400",
                                      analyzingMatchId === row.matchId && "animate-pulse text-purple-400"
                                    )}
                                    onClick={() => analyzeSingleMatch(row.matchId, true)}
                                    disabled={!!analyzingMatchId}
                                    title={analyzingMatchId === row.matchId ? "AI分析中" : "AI分析(点击重新分析)"}
                                  >
                                    {analyzingMatchId === row.matchId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                                  </button>
                                )}
                              </td>
                              {(["handicap", "total"] as const).map(market => {
                                const verification = row.verification?.[market];
                                const manual = verification?.manualIsCorrect ?? (market === "handicap" ? row.manualIsCorrect : null);
                                const effective = verification?.effectiveIsCorrect ?? (market === "handicap"
                                  ? row.waterResult === "-" ? true : row.waterResult === "+" ? false : null
                                  : row.totalResult === "-" ? true : row.totalResult === "+" ? false : null);
                                const outcomeLabel: Record<string, string> = {
                                  win: "赢盘", half_win: "赢半", push: "走盘", half_loss: "输半", loss: "输盘",
                                  pending: "待结算", invalid: "无效", void: "作废", legacy_unknown: "证据不足",
                                };
                                const status = manual !== null && manual !== undefined
                                  ? `人工${manual ? "对" : "错"}`
                                  : verification ? outcomeLabel[verification.autoOutcome] || "未验证" : effective === null ? "未验证" : effective ? "对" : "错";
                                const loading = verifyingMarketKey === `${row.matchId}:${market}`;
                                return (
                                  <td key={market} className="px-2 py-1 text-center">
                                    <span className={cn(
                                      "text-[11px] font-bold px-1 py-0.5 rounded",
                                      effective === true && "bg-green-900/40 text-green-400",
                                      effective === false && "bg-red-900/40 text-red-400",
                                      effective === null && "bg-gray-800/40 text-gray-500",
                                    )}>
                                      {status}
                                    </span>
                                    <div className="mt-0.5 flex justify-center gap-0.5">
                                      {manual === null || manual === undefined ? (
                                        <>
                                          <button
                                            className="rounded border border-green-700/40 px-1 text-[11px] leading-tight text-green-500 hover:bg-green-900/30 disabled:opacity-40"
                                            disabled={loading}
                                            onClick={() => manualVerify(row.matchId, market, true)}
                                            aria-label={`标记${market === "handicap" ? "让球" : "进球"}预测正确`}
                                          >对</button>
                                          <button
                                            className="rounded border border-red-700/40 px-1 text-[11px] leading-tight text-red-500 hover:bg-red-900/30 disabled:opacity-40"
                                            disabled={loading}
                                            onClick={() => manualVerify(row.matchId, market, false)}
                                            aria-label={`标记${market === "handicap" ? "让球" : "进球"}预测错误`}
                                          >错</button>
                                        </>
                                      ) : (
                                        <button
                                          className="rounded border border-gray-700/40 px-1 text-[11px] leading-tight text-gray-500 hover:bg-gray-700/30 disabled:opacity-40"
                                          disabled={loading}
                                          onClick={() => manualVerify(row.matchId, market, null)}
                                          aria-label={`撤回${market === "handicap" ? "让球" : "进球"}人工验证`}
                                        >撤</button>
                                      )}
                                    </div>
                                  </td>
                                );
                              })}
                              <td className="px-2 py-1 text-left text-gray-400">{row.league}</td>
                              <td className="px-2 py-1 text-center text-gray-500 font-mono">{row.time}</td>
                              <td className="px-2 py-1 text-right text-white">{row.homeTeam}</td>
                              <td className="px-2 py-1 text-left text-white">{row.awayTeam}</td>
                              <td className="px-2 py-1 text-center text-cyan-300">{row.crownHandicap || row.initHandicap}</td>
                              <td className="px-2 py-1 text-center text-gray-300">{row.liveHandicap}</td>
                              <td className="px-2 py-1 text-center">
                                <span className={cn(
                                  "text-[11px] px-1.5 py-0.5 rounded",
                                  row.waterDirection === "主降水" ? "text-blue-300 bg-blue-900/30" :
                                  row.waterDirection === "客降水" ? "text-orange-300 bg-orange-900/30" :
                                  "text-gray-400 bg-gray-800/30"
                                )}>
                                  {row.waterDirection}
                                </span>
                              </td>
                              <td className="px-2 py-1 text-center text-yellow-300">{row.prediction}</td>
                              <td className="px-2 py-1 text-center">
                                <span className="text-[11px] text-gray-300">{row.action}</span>
                              </td>
                              <td className="px-2 py-1 text-center">
                                {row.totalPrediction && row.totalPrediction !== "中立" ? (
                                  <span className={cn(
                                    "text-[11px] font-bold",
                                    row.totalPrediction === "大" ? "text-red-400" : "text-blue-400"
                                  )}>
                                    {row.totalPrediction} {row.totalAction}
                                  </span>
                                ) : (
                                  <span className="text-gray-600">-</span>
                                )}
                              </td>
                              <td className="px-2 py-1 text-center">
                                <span className={cn(
                                  "text-[11px] px-1.5 py-0.5 rounded border",
                                  (row.confidenceLevel || row.confidence_level) === "高" ? "text-red-300 border-red-700/50" :
                                  (row.confidenceLevel || row.confidence_level) === "中" ? "text-yellow-300 border-yellow-700/50" :
                                  "text-gray-400 border-gray-700/50"
                                )}>
                                  {row.confidenceLevel || row.confidence_level}
                                </span>
                              </td>
                            </tr>
                            {/* Expanded company odds row */}
                            {reportExpandedCompanies.has(row.matchId) && (() => {
                              const cod = dbCompanyOddsMap.get(row.matchId);
                              if (!cod) {
                                return (
                                  <tr className="border-b border-gray-800/30 bg-gray-900/40">
                                    <td colSpan={15} className="px-4 py-2 text-center text-gray-500 text-[11px]">
                                      {fetchingMatches.has(row.matchId) ? "抓取中..." : "无赔率数据"}
                                    </td>
                                  </tr>
                                );
                              }
                              const codCompanies = Array.isArray(cod.companies) ? cod.companies : [];
                              if (codCompanies.length === 0) {
                                return (
                                  <tr className="border-b border-gray-800/30 bg-gray-900/40">
                                    <td colSpan={15} className="px-4 py-2 text-center text-gray-500 text-[11px]">
                                      {fetchingMatches.has(row.matchId) ? "抓取中..." : "无赔率数据"}
                                    </td>
                                  </tr>
                                );
                              }
                              const selectedCompanies = codCompanies
                                .filter(c => DEFAULT_COMPANY_IDS.includes(c.companyId))
                                .sort((a, b) => {
                                  const ta = normalizeOpenTime(a.openTime);
                                  const tb = normalizeOpenTime(b.openTime);
                                  return ta.localeCompare(tb);
                                });
                              const extraCompanies = codCompanies
                                .filter(c => !DEFAULT_COMPANY_IDS.includes(c.companyId) && monitorCompanyIds.includes(c.companyId));
                              const unselectedCompanies = codCompanies
                                .filter(c => !DEFAULT_COMPANY_IDS.includes(c.companyId) && !monitorCompanyIds.includes(c.companyId));
                              const showExtra = reportExpandedCrown.has(row.matchId);
                              const companiesToShow = showExtra ? [...selectedCompanies, ...extraCompanies] : selectedCompanies;
                              const hasExtra = extraCompanies.length > 0 || unselectedCompanies.length > 0;

                              return companiesToShow.length > 0 ? (
                                <tr className="border-b border-gray-800/30 bg-gray-900/40">
                                  <td colSpan={15} className="p-0">
                                    <div className="px-4 py-1">
                                      <table className="w-full text-[11px]">
                                        <thead>
                                          <tr className="text-gray-500 border-b border-gray-800/40">
                                            <th className="px-1.5 py-0.5 text-left font-normal w-20">开盘时间</th>
                                            <th className="px-1.5 py-0.5 text-left font-normal w-12">公司</th>
                                            <th className="px-1.5 py-0.5 text-center font-normal text-blue-400/60" colSpan={3}>全场亚盘(初)</th>
                                            <th className="px-1.5 py-0.5 text-center font-normal text-purple-400/60" colSpan={3}>欧转亚盘(初)</th>
                                            <th className="px-1.5 py-0.5 text-center font-normal text-amber-400/60" colSpan={3}>进球数(初)</th>
                                            <th className="px-1.5 py-0.5 text-center font-normal text-emerald-400/60" colSpan={3}>新数据(亚盘)</th>
                                            <th className="px-1.5 py-0.5 text-center font-normal text-teal-400/60" colSpan={3}>新数据(进球)</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {companiesToShow.map((c) => {
                                            return (
                                              <Fragment key={c.companyId}>
                                              <tr className="border-b border-gray-800/20 hover:bg-gray-800/20">
                                                <td className="px-1.5 py-0.5 text-gray-500 whitespace-nowrap">{c.openTime}</td>
                                                <td className="px-1.5 py-0.5 text-cyan-300 font-medium whitespace-nowrap">{c.companyName}</td>
                                                <td className="px-1 py-0.5 text-right text-gray-400">{c.ftHandicapHome || "--"}</td>
                                                <td className="px-1 py-0.5 text-center text-white font-medium">{c.ftHandicapLine || "--"}</td>
                                                <td className="px-1 py-0.5 text-left text-gray-400">{c.ftHandicapAway || "--"}</td>
                                                <td className="px-1 py-0.5 text-right text-gray-400">{c.euroAsianHome || "--"}</td>
                                                <td className="px-1 py-0.5 text-center text-purple-300 font-medium">{c.euroAsianLine || "--"}</td>
                                                <td className="px-1 py-0.5 text-left text-gray-400">{c.euroAsianAway || "--"}</td>
                                                <td className="px-1 py-0.5 text-right text-gray-400">{c.ftTotalOver || "--"}</td>
                                                <td className="px-1 py-0.5 text-center text-amber-300 font-medium">{c.ftTotalLine || "--"}</td>
                                                <td className="px-1 py-0.5 text-left text-gray-400">{c.ftTotalUnder || "--"}</td>
                                                {c.companyId === "3" && (() => {
                                                  const c12 = crown12OddsFromDb.get(row.matchId);
                                                  return c12 ? (
                                                    <>
                                                      <td className="px-1 py-0.5 text-right text-emerald-400">{c12.handicapHome || "--"}</td>
                                                      <td className="px-1 py-0.5 text-center text-emerald-300 font-medium">{c12.handicapLine || "--"}</td>
                                                      <td className="px-1 py-0.5 text-left text-emerald-400">{c12.handicapAway || "--"}</td>
                                                      <td className="px-1 py-0.5 text-right text-teal-400">{c12.totalOver || "--"}</td>
                                                      <td className="px-1 py-0.5 text-center text-teal-300 font-medium">{c12.totalLine || "--"}</td>
                                                      <td className="px-1 py-0.5 text-left text-teal-400">{c12.totalUnder || "--"}</td>
                                                    </>
                                                  ) : (
                                                    <td className="px-1 py-0.5 text-center text-gray-600" colSpan={6}>--</td>
                                                  );
                                                })()}
                                                {c.companyId !== "3" && (
                                                  <td className="px-1 py-0.5 text-center text-gray-700" colSpan={6}>--</td>
                                                )}
                                              </tr>
                                              {/* Crown terminal odds (终盘) sub-row */}
                                              {c.companyId === "3" && (() => {
                                                const cl = crownLiveOddsFromDb.get(row.matchId);
                                                if (!cl || (!cl.handicapLine && !cl.totalLine)) return null;
                                                return (
                                                  <tr className="border-b border-gray-800/10 bg-gray-900/20">
                                                    <td className="px-1.5 py-0.5 text-right text-gray-500 text-[11px] italic" colSpan={11}>终盘</td>
                                                    <td className="px-1 py-0.5 text-right text-gray-400">{cl.handicapHome || "--"}</td>
                                                    <td className="px-1 py-0.5 text-center text-gray-300 font-medium">{cl.handicapLine || "--"}</td>
                                                    <td className="px-1 py-0.5 text-left text-gray-400">{cl.handicapAway || "--"}</td>
                                                    <td className="px-1 py-0.5 text-right text-gray-400">{cl.totalOver || "--"}</td>
                                                    <td className="px-1 py-0.5 text-center text-gray-300 font-medium">{cl.totalLine || "--"}</td>
                                                    <td className="px-1 py-0.5 text-left text-gray-400">{cl.totalUnder || "--"}</td>
                                                  </tr>
                                                );
                                              })()}
                                              </Fragment>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                      {hasExtra && (
                                        <div className="mt-1 flex flex-wrap items-center gap-1">
                                          <button
                                            className="text-[11px] text-blue-400 hover:text-blue-300 underline mr-2"
                                            onClick={() => {
                                              setReportExpandedCrown(prev => {
                                                const next = new Set(prev);
                                                if (next.has(row.matchId)) next.delete(row.matchId);
                                                else next.add(row.matchId);
                                                return next;
                                              });
                                            }}
                                          >
                                            {showExtra ? "收起" : `展开已选公司 (+${extraCompanies.length})`}
                                          </button>
                                          {unselectedCompanies.length > 0 && (
                                            <>
                                              <span className="text-[11px] text-gray-600">添加公司:</span>
                                              {unselectedCompanies
                                                .sort((a, b) => {
                                                  const ta = normalizeOpenTime(a.openTime);
                                                  const tb = normalizeOpenTime(b.openTime);
                                                  return ta.localeCompare(tb);
                                                })
                                                .map(c => (
                                                  <button
                                                    key={c.companyId}
                                                    className="text-[11px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-500 hover:text-cyan-300 hover:border-cyan-600 transition-colors"
                                                    onClick={() => {
                                                      setMonitorCompanyIds(prev => [...prev, c.companyId]);
                                                    }}
                                                  >
                                                    {c.companyName}
                                                  </button>
                                                ))
                                              }
                                            </>
                                          )}
                                          {extraCompanies.length > 0 && showExtra && (
                                            <>
                                              <span className="text-[11px] text-gray-600 ml-2">已选:</span>
                                              {extraCompanies.map(c => (
                                                <button
                                                  key={c.companyId}
                                                  className="text-[11px] px-1.5 py-0.5 rounded border border-cyan-700 text-cyan-300 hover:text-red-300 hover:border-red-600 transition-colors"
                                                  onClick={() => {
                                                    setMonitorCompanyIds(prev => prev.filter(id => id !== c.companyId));
                                                  }}
                                                >
                                                  {c.companyName} ✕
                                                </button>
                                              ))}
                                            </>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              ) : null;
                            })()}
                            {/* AI Analysis result row */}
                            {analysisResults.has(row.matchId) && analysisExpanded === row.matchId && (
                              <tr className="border-b border-border/70 bg-surface-1/60">
                                <td colSpan={15} className="p-2 sm:p-3">
                                  {(() => {
                                    const ar = analysisResults.get(row.matchId)!;
                                    const matchObj = dataTabMatches.find(m => m.id === row.matchId) || matchesRef.current.find(m => m.id === row.matchId);
                                    const matchState = matchObj?.state;
                                    return (
                                      <AIAnalysisResultPanel
                                        panelId={`prediction-report-${row.matchId}`}
                                        analysis={ar}
                                        analyzedAtLabel={formatAnalysisTime(ar.analyzedAt)}
                                        patterns={evolutionStats?.topPatterns}
                                        messages={chatMessages.get(row.matchId) || []}
                                        isDetailExpanded
                                        isChatOpen={chatOpen === row.matchId}
                                        chatInput={chatOpen === row.matchId ? chatInput : ""}
                                        chatStreaming={chatStreaming}
                                        showVerification={Boolean(matchState && matchState !== "0")}
                                        onToggleDetail={() => setAnalysisExpanded(null)}
                                        onToggleChat={() => setChatOpen(chatOpen === row.matchId ? null : row.matchId)}
                                        onChatInputChange={setChatInput}
                                        onSendChat={() => sendChatMessage(row.matchId, chatInput)}
                                        verifyingMarket={verifyingMarketKey?.startsWith(`${row.matchId}:`) ? verifyingMarketKey.split(":")[1] as PredictionMarket : null}
                                        onVerify={(market, value) => manualVerify(row.matchId, market, value)}
                                      />
                                    );
                                  })()}
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {!reportData && !reportLoading && (
              <div className="text-center text-gray-500 py-12">
                <FileBarChart className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p>{'点击"生成AI报表"生成预测报表'}</p>
                <p className="text-xs mt-1">基于prediction_results表的AI预测数据</p>
                <p className="text-xs mt-1">或选择日期查看历史报表</p>
              </div>
            )}
          </div>
        )}

        {/* Data Tab - Company odds per match */}
        {activeTab === "data" && (
          <div className="space-y-3">
            {/* Schedule mode switcher + date picker + league filter */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* Schedule mode tabs */}
              <div className="flex items-center bg-gray-800/60 rounded-lg p-0.5">
                {([
                  { key: "today" as const, label: "今日赛程" },
                  { key: "history" as const, label: "历史赛程" },
                  { key: "future" as const, label: "未来赛程" },
                ]).map((tab) => (
                  <button
                    key={tab.key}
                    className={cn(
                      "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                      dataScheduleMode === tab.key ? "bg-blue-600 text-white" : "text-gray-400 hover:text-gray-200"
                    )}
                    onClick={() => {
                      setDataScheduleMode(tab.key);
                      // Reset league selection when switching mode
                      setDataSelectedLeagues(new Set());
                      setDataFilterLetter("热");
                      setDataCurrentPage(1);
                      setLeagueInputText("");
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Date picker for history/future */}
              {dataScheduleMode !== "today" && (
                <div className="flex items-center gap-1.5">
                  <CalendarDays className="w-3.5 h-3.5 text-gray-500" />
                  <input
                    type="date"
                    value={dataDate}
                    onChange={(e) => setDataDate(e.target.value)}
                    className="bg-gray-800/60 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
                  />
                  {dataScheduleMode === "history" && (
                    <>
                      <span className="text-gray-500 text-xs">~</span>
                      <input
                        type="date"
                        value={dataDateEnd}
                        onChange={(e) => setDataDateEnd(e.target.value)}
                        className="bg-gray-800/60 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
                      />
                    </>
                  )}
                </div>
              )}

              {/* League quick input */}
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-gray-500 whitespace-nowrap">联赛:</span>
                <input
                  type="text"
                  value={leagueInputText}
                  onChange={(e) => setLeagueInputText(e.target.value)}
                  placeholder="联赛名称/拼音，逗号分隔"
                  className="bg-gray-800/60 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500 w-48 placeholder:text-gray-600"
                />
                {leagueInputText && (
                  <span className="text-[11px] text-gray-500">
                    {dataSelectedLeagues.size > 0 ? `${dataSelectedLeagues.size}联赛` : "无匹配"}
                  </span>
                )}
                {leagueInputText && (
                  <button
                    className="text-gray-500 hover:text-gray-300 text-xs"
                    onClick={() => setLeagueInputText("")}
                    title="清除"
                  >✕</button>
                )}
              </div>

              {/* League filter popover */}
              <Popover open={dataLeagueFilterOpen} onOpenChange={setDataLeagueFilterOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="border-gray-700 text-gray-300 hover:bg-gray-800 h-7">
                    <Filter className="w-3.5 h-3.5 mr-1" />
                    赛事筛选
                    {dataSelectedMatchCount > 0 && dataSelectedMatchCount < dataTotalMatchCount && (
                      <Badge className="ml-1 bg-red-600 text-white px-1.5 py-0 text-[11px]">
                        {dataSelectedMatchCount}
                      </Badge>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[640px] odds-popover p-0" align="start">
                  {/* Header: title + close */}
                  <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
                    <span className="text-sm font-bold text-blue-400">赛事筛选</span>
                    <button className="text-gray-500 hover:text-gray-300" onClick={() => setDataLeagueFilterOpen(false)}>
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Category tabs: 所有比赛 / 足彩 / 竞足 / 单场 */}
                  <div className="flex border-b border-gray-700/50 px-4">
                    {[
                      { key: "all" as const, label: "所有比赛" },
                      { key: "zucai" as const, label: "足彩" },
                      { key: "jingzu" as const, label: "竞足" },
                      { key: "danchang" as const, label: "单场" },
                    ].map((tab) => (
                      <button
                        key={tab.key}
                        className={cn(
                          "px-3 py-1.5 text-xs font-medium transition-colors relative",
                          dataFilterCategory === tab.key
                            ? "text-blue-400"
                            : "text-gray-500 hover:text-gray-300"
                        )}
                        onClick={() => setDataFilterCategory(tab.key)}
                      >
                        {tab.label}
                        {dataFilterCategory === tab.key && (
                          <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />
                        )}
                      </button>
                    ))}
                  </div>

                  {/* Status tabs: 全部 / 滚球赛事 / 未开场 / 已完场 / 进行中 */}
                  <div className="flex gap-1 px-4 py-1.5 border-b border-gray-700/50">
                    {[
                      { key: "all" as const, label: "全部" },
                      { key: "rolling" as const, label: "滚球赛事" },
                      { key: "upcoming" as const, label: "未开场" },
                      { key: "finished" as const, label: "已完场" },
                      { key: "playing" as const, label: "进行中" },
                    ].map((tab) => (
                      <button
                        key={tab.key}
                        className={cn(
                          "px-2 py-0.5 rounded text-[11px] transition-colors",
                          dataFilterStatus === tab.key
                            ? "bg-blue-500/20 text-blue-300"
                            : "bg-gray-800/40 text-gray-500 hover:text-gray-300"
                        )}
                        onClick={() => setDataFilterStatus(tab.key)}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {/* Main body: leagues + letter index */}
                  <div className="flex" style={{ height: "380px" }}>
                    {/* Left: league list */}
                    <div className="flex-1 overflow-y-auto p-3">
                      {/* Hot leagues section */}
                      {dataFilterLetter === "热" && (
                        <div className="mb-3">
                          <div className="text-[11px] text-gray-500 mb-1.5 font-medium">热门</div>
                          <div className="grid grid-cols-5 gap-x-2 gap-y-1">
                            {hotLeagues.map((league) => {
                              const isSelected = dataSelectedLeagues.size === 0 || isLeagueSelected(league.name, dataSelectedLeagues);
                              return (
                                <label key={league.id} className="flex items-center gap-1 cursor-pointer py-0.5">
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => {
                                      setDataSelectedLeagues(prev => {
                                        const next = new Set(prev);
                                        next.delete("__NONE__");
                                        if (next.has(league.name)) {
                                          next.delete(league.name);
                                          if (next.size === 0) next.add("__NONE__");
                                        } else {
                                          next.add(league.name);
                                        }
                                        return next;
                                      });
                                    }}
                                    className={cn(
                                      "rounded w-3 h-3 border",
                                      isSelected ? "border-red-500 bg-red-500/80" : "border-gray-600 bg-transparent"
                                    )}
                                  />
                                  <span className={cn("text-[11px] truncate", isSelected ? "text-gray-200" : "text-gray-600")}>
                                    {league.name}
                                  </span>
                                  <span className="text-[11px] text-gray-600">[{league.count}]</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Letter-grouped leagues */}
                      {(dataFilterLetter === "热" ? availableLetters : [dataFilterLetter]).map((letter) => {
                        const group = leagueLetterGroups[letter];
                        if (!group || group.length === 0) return null;
                        return (
                          <div key={letter} className="mb-2">
                            {dataFilterLetter === "热" && (
                              <div className="flex items-center gap-1.5 mb-1">
                                <span className="text-xs font-bold text-blue-400 w-5">{letter}</span>
                                <div className="flex-1 h-px bg-gray-700/50" />
                              </div>
                            )}
                            <div className={cn(
                              dataFilterLetter === "热" ? "grid grid-cols-5 gap-x-2 gap-y-0.5 pl-5" : "grid grid-cols-5 gap-x-2 gap-y-1"
                            )}>
                              {group.map((league) => {
                                const isSelected = dataSelectedLeagues.size === 0 || isLeagueSelected(league.name, dataSelectedLeagues);
                                return (
                                  <label key={league.id} className="flex items-center gap-1 cursor-pointer py-0.5">
                                    <input
                                      type="checkbox"
                                      checked={isSelected}
                                      onChange={() => {
                                        setDataSelectedLeagues(prev => {
                                          const next = new Set(prev);
                                          next.delete("__NONE__");
                                          if (next.has(league.name)) {
                                            next.delete(league.name);
                                            if (next.size === 0) next.add("__NONE__");
                                          } else {
                                            next.add(league.name);
                                          }
                                          return next;
                                        });
                                      }}
                                      className={cn(
                                        "rounded w-3 h-3 border",
                                        isSelected ? "border-red-500 bg-red-500/80" : "border-gray-600 bg-transparent"
                                      )}
                                    />
                                    <span className={cn("text-[11px] truncate", isSelected ? "text-gray-200" : "text-gray-600")}>
                                      {league.name}
                                    </span>
                                    <span className="text-[11px] text-gray-600">[{league.count}]</span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Right: letter index bar */}
                    <div className="w-6 flex flex-col items-center py-1 border-l border-gray-700/50 bg-gray-900/30 overflow-y-auto shrink-0">
                      <button
                        className={cn(
                          "text-[11px] py-0.5 w-full text-center",
                          dataFilterLetter === "热" ? "text-blue-400 font-bold" : "text-gray-500 hover:text-gray-300"
                        )}
                        onClick={() => setDataFilterLetter("热")}
                      >热</button>
                      {"ABCDEFGHJKLMNPQRSTWXYZ".split("").map((letter) => (
                        <button
                          key={letter}
                          className={cn(
                            "text-[11px] py-0.5 w-full text-center",
                            dataFilterLetter === letter
                              ? "text-blue-400 font-bold"
                              : availableLetters.includes(letter)
                                ? "text-gray-500 hover:text-gray-300"
                                : "text-gray-800"
                          )}
                          onClick={() => setDataFilterLetter(letter)}
                        >{letter}</button>
                      ))}
                    </div>
                  </div>

                  {/* Footer: selected count + action buttons */}
                  <div className="flex items-center justify-between px-4 py-2 border-t border-gray-700">
                    <span className="text-xs text-gray-500">
                      选中<span className="text-white font-medium">{dataSelectedMatchCount}</span>场赛事
                    </span>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="outline" className="text-[11px] h-6 px-2 border-gray-700 text-gray-400 hover:text-gray-200"
                        onClick={() => {
                          // Select only hot leagues and switch view to hot
                          setDataSelectedLeagues(new Set(hotLeagues.map(l => l.name)));
                          setDataFilterLetter("热");
                        }}>热门</Button>
                      <Button size="sm" variant="outline" className="text-[11px] h-6 px-2 border-gray-700 text-gray-400 hover:text-gray-200"
                        onClick={() => setDataSelectedLeagues(new Set())}>全选</Button>
                      <Button size="sm" variant="outline" className="text-[11px] h-6 px-2 border-gray-700 text-gray-400 hover:text-gray-200"
                        onClick={() => {
                          setDataSelectedLeagues(prev => {
                            const allNames = new Set(dataTabLeagues.map(l => l.name));
                            const next = new Set<string>();
                            next.delete("__NONE__");
                            // If all selected, deselect all. If some selected, select all.
                            if (prev.size === 0) {
                              // Currently all selected → deselect all
                              next.add("__NONE__");
                            } else {
                              // Toggle: previously unselected → selected, previously selected → unselected
                              for (const name of allNames) {
                                if (!prev.has(name)) next.add(name);
                              }
                              if (next.size === 0) next.add("__NONE__");
                            }
                            return next;
                          });
                        }}>反选</Button>
                      <Button size="sm" className="text-[11px] h-6 px-3 bg-blue-600 hover:bg-blue-500 text-white"
                        onClick={() => setDataLeagueFilterOpen(false)}>确定</Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>

              {/* Company selector */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="border-gray-700 text-gray-300 hover:bg-gray-800 h-7">
                    <Building2 className="w-3.5 h-3.5 mr-1" />
                    公司
                    <ChevronDown className="w-3 h-3 ml-0.5 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-56 odds-popover" align="end">
                  <div className="space-y-2">
                    <Label className="text-gray-300 text-xs">选择赔率公司</Label>
                    <div className="space-y-1">
                      {["3:皇冠", "35:盈禾", "42:18博", "47:平博", "12:易胜博", "17:明升", "31:利记", "1:澳门", "8:36bet", "14:伟德", "24:12BET", "50:1xbet"].map((item) => {
                        const [id, name] = item.split(":");
                        const isSelected = dataCompanyIds.includes(id);
                        return (
                          <label key={id} className="flex items-center gap-2 cursor-pointer hover:bg-gray-800/50 px-1 py-0.5 rounded">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {
                                setDataCompanyIds(prev =>
                                  isSelected ? prev.filter(x => x !== id) : [...prev, id]
                                );
                              }}
                              className="rounded border-gray-600"
                            />
                            <span className={cn("text-sm", isSelected ? "text-gray-200" : "text-gray-500")}>{name}</span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" variant="ghost" className="text-xs text-blue-400 h-6 px-2"
                        onClick={() => setDataCompanyIds(DEFAULT_COMPANY_IDS)}>默认5家</Button>
                      <Button size="sm" variant="ghost" className="text-xs text-blue-400 h-6 px-2"
                        onClick={() => setDataCompanyIds(["3","35","42","47","12","17","31","1","8","14","24","50"])}>全选</Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            {/* Schedule info bar */}
            <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap">
              {dataScheduleMode === "today" && <span>今日赛程 - {matchDate || "加载中..."}</span>}
              {dataScheduleMode === "history" && <span>历史赛程 - {dataDate || "请选择日期"}{dataDateEnd && ` ~ ${dataDateEnd}`}</span>}
              {dataScheduleMode === "future" && <span>未来赛程 - {dataDate || "请选择日期"}</span>}
              {scheduleLoading && <span className="text-yellow-400">加载中...</span>}
              <span className="text-gray-700">|</span>
              <span>热门赛事<span className="text-white font-medium">{totalHotMatchCount}</span>场</span>
              <span className="text-gray-700">|</span>
              <span>全部赛事<span className="text-white font-medium">{dataTotalMatchCount}</span>场</span>
              <span className="text-gray-700">|</span>
              <button
                className="text-[11px] text-amber-400 hover:text-amber-300"
                onClick={openFocusedLeagueDialog}
              >
                白名单({userFocusedLeagues.size})
              </button>
              <span className="text-gray-700">|</span>
              <button
                className="text-[11px] text-sky-400 hover:text-sky-300"
                onClick={() => { loadFeishuSettings(); setFeishuDialogOpen(true); }}
              >
                飞书
              </button>
              <span className="text-gray-700">|</span>
              <span>已抓取<span className="text-white font-medium">{fetchedMatches.size}</span>场</span>
              {autoFetchRunning && <span className="text-green-400 animate-pulse">自动抓取中...</span>}
              {batchProgress && (
                <span className="text-blue-400">
                  {batchProgress.phase} {batchProgress.done}/{batchProgress.total}
                </span>
              )}
              <span className="text-gray-700">|</span>
              <button
                className="text-[11px] text-blue-400 hover:text-blue-300 disabled:text-gray-600"
                onClick={() => fetchAllVisibleOdds()}
                disabled={dataLoading}
              >
                刷新最新赔率
              </button>
              {/* Supplement fetch dropdown */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    className="text-[11px] text-yellow-400 hover:text-yellow-300 disabled:text-gray-600"
                    disabled={dataLoading || fetchedMatches.size === 0}
                    onClick={() => refreshMissingCounts()}
                  >
                    补充抓取 ▾
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-44 odds-popover p-1" align="start">
                  <button
                    className="w-full text-left text-[11px] text-gray-300 hover:bg-gray-800 px-2 py-1.5 rounded"
                    onClick={() => supplementFetch("odds")}
                  >
                    缺失赔率 ({missingCounts.odds}场)
                  </button>
                  <button
                    className="w-full text-left text-[11px] text-gray-300 hover:bg-gray-800 px-2 py-1.5 rounded"
                    onClick={() => supplementFetch("opentimes")}
                  >
                    缺失开盘时间 ({missingCounts.opentimes}场)
                  </button>
                  <button
                    className="w-full text-left text-[11px] text-gray-300 hover:bg-gray-800 px-2 py-1.5 rounded"
                    onClick={() => supplementFetch("crownOpen")}
                  >
                    缺失新数据 ({missingCounts.crownOpen}场)
                  </button>
                  <button
                    className="w-full text-left text-[11px] text-gray-300 hover:bg-gray-800 px-2 py-1.5 rounded"
                    onClick={() => supplementFetch("crownFinal")}
                  >
                    缺失终盘 ({missingCounts.crownFinal}场)
                  </button>
                  <div className="border-t border-gray-700 my-1" />
                  <button
                    className="w-full text-left text-[11px] text-yellow-400 hover:bg-gray-800 px-2 py-1.5 rounded"
                    onClick={() => supplementFetch("revalidate")}
                  >
                    数据校验 (已抓取赛事)
                  </button>
                  <div className="border-t border-gray-700 my-1" />
                  <button
                    className="w-full text-left text-[11px] text-blue-400 hover:bg-gray-800 px-2 py-1.5 rounded"
                    onClick={() => refreshMissingCounts()}
                  >
                    刷新检测
                  </button>
                </PopoverContent>
              </Popover>
              {/* Abort button */}
              {(dataLoading || autoFetchRunning) && (
                <button
                  className="text-[11px] text-red-400 hover:text-red-300"
                  onClick={abortFetch}
                >
                  中止抓取
                </button>
              )}
              <button
                className="text-[11px] text-green-400 hover:text-green-300"
                onClick={() => exportToExcel()}
              >
                导出Excel
              </button>
              <span className="text-gray-700">|</span>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    className={cn(
                      "text-[11px] transition-colors",
                      (analyzingMatchId || batchAIProgress.total > 0 || dataScheduleMode === "history") ? "text-gray-600 cursor-wait" : "text-purple-400 hover:text-purple-300"
                    )}
                    disabled={!!analyzingMatchId || batchAIProgress.total > 0 || dataScheduleMode === "history"}
                  >
                    {analyzingMatchId ? "AI分析中…" : batchAIProgress.total > 0 ? "批量分析中…" : dataScheduleMode === "history" ? "AI验证" : "AI分析"}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-40 odds-popover p-1" side="bottom" align="start">
                  <div className="px-2 py-1.5 border-b border-gray-700/60 mb-1">
                    <label className="flex items-center justify-between gap-2 text-[11px] text-gray-400">
                      <span>并发数</span>
                      <input
                        type="number"
                        min={1}
                        max={8}
                        className="w-14 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[11px] text-purple-300 text-center outline-none focus:border-purple-600"
                        value={aiConcurrency}
                        disabled={batchAIProgress.total > 0}
                        onChange={(e) => setAiConcurrency(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                      />
                    </label>
                  </div>
                  <button
                    className="w-full text-left text-[11px] text-purple-400 hover:bg-gray-800 px-2 py-1.5 rounded"
                    disabled={!!analyzingMatchId || batchAIProgress.total > 0}
                    onClick={() => {
                      const firstMatch = dataMatchRows.notStarted[0];
                      if (firstMatch) {
                        analyzeSingleMatch(firstMatch.match.id, true);
                      } else {
                        toast.info("当前没有可分析的赛事", { description: "请调整筛选条件或等待赛事数据加载" });
                      }
                    }}
                  >
                    分析首场赛事
                  </button>
                  <button
                    className="w-full text-left text-[11px] text-purple-400 hover:bg-gray-800 px-2 py-1.5 rounded"
                    disabled={!!analyzingMatchId || batchAIProgress.total > 0}
                    onClick={() => {
                      const analyzable = dataMatchRows.notStarted
                        .map((r: DataMatchRow) => ({ id: r.match.id, homeTeam: r.match.homeTeam, awayTeam: r.match.awayTeam }));
                      if (analyzable.length === 0) {
                        toast.info("没有可分析的赛事", { description: "当前列表中没有符合条件的赛事" });
                        return;
                      }
                      batchAnalyzeAll(analyzable, true);
                    }}
                  >
                    批量AI分析
                  </button>
                </PopoverContent>
              </Popover>
              {batchAIProgress.total > 0 && (
                <span className="text-[11px] text-purple-300 flex items-center gap-1" title={`最近处理：${batchAIProgress.matchName}`}>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {batchAIProgress.current}/{batchAIProgress.total}
                  <span className="text-green-400">成功{batchAIProgress.succeeded}</span>
                  <span className="text-red-400">失败{batchAIProgress.failed}</span>
                  <button className="text-red-400 hover:text-red-300" onClick={stopBatchAI}>停止后续</button>
                </span>
              )}
              {evolutionStats && evolutionStats.totalPredictions > 0 && (
                <span className="text-[11px] text-gray-500" title={`已验证${evolutionStats.totalPredictions}场，命中${evolutionStats.correctPredictions}场`}>
                  [{evolutionStats.overallAccuracy}]
                </span>
              )}
              <button
                className="text-[11px] text-gray-500 hover:text-blue-400 transition-colors"
                onClick={async () => {
                  // Verify yesterday's predictions then learn
                  const now = new Date();
                  const beijingOffset = 8 * 60;
                  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
                  const beijingNow = new Date(utcMs + beijingOffset * 60000);
                  const yesterday = new Date(beijingNow);
                  yesterday.setDate(yesterday.getDate() - 1);
                  const yd = yesterday.toISOString().slice(0, 10).replace(/-/g, "");
                  try {
                    const vr = await fetch(`/api/analysis/verify?startDate=${yd}&endDate=${yd}`);
                    const vj = await vr.json();
                    const lr = await fetch("/api/analysis/learn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ league: "ALL", minSamples: 3 }) });
                    const lj = await lr.json();
                    await loadEvolutionStats();
                    toast.success("验证与学习完成", { description: `验证 ${vj.verified || 0} 场 · 命中 ${vj.correct || 0} 场 · 新增 ${lj.patternsFound || 0} 个模式` });
                  } catch (err) { toast.error("验证学习失败", { description: err instanceof Error ? err.message : "网络请求失败", duration: 8000 }); }
                }}
              >
                验证+学习
              </button>
            </div>

            {/* Match list - flat layout with odds to the right */}
            {dataTabMatches.length === 0 ? (
              <div className="text-center text-gray-500 py-12">
                <p className="text-sm">{scheduleLoading ? "加载中..." : dataScheduleMode !== "today" && !dataDate ? "请选择日期" : scheduleError || "暂无赛事数据"}</p>
              </div>
            ) : (
              <div className="odds-table-wrap">
                <table className="w-full text-[11px] border-collapse">
                  <thead>
                    <tr className="text-gray-500 bg-gray-900/80 border-b border-gray-700/50">
                      <th className="px-2 py-1.5 text-center font-normal w-20">开盘时间</th>
                      <th className="px-2 py-1.5 text-center font-normal w-14">联赛</th>
                      <th className="px-2 py-1.5 text-center font-normal w-24">赛况</th>
                      {dataScheduleMode === "history" && <th className="px-1 py-1.5 text-center font-normal w-10">比分</th>}
                      {dataScheduleMode === "history" && <th className="px-1 py-1.5 text-center font-normal w-10">半场</th>}
                      <th className="px-2 py-1.5 text-center font-normal">主队</th>
                      <th className="px-2 py-1.5 text-center font-normal">客队</th>
                      <th className="px-2 py-1.5 text-center font-normal w-12">公司</th>
                      <th className="px-1 py-1.5 text-center font-normal text-blue-400/70" colSpan={3}>亚盘(初)</th>
                      <th className="px-1 py-1.5 text-center font-normal text-purple-400/70" colSpan={3}>欧转亚盘(初)</th>
                      <th className="px-1 py-1.5 text-center font-normal text-amber-400/70" colSpan={3}>进球数(初)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const { notStarted, otherStates } = dataMatchRows;
                      const isHistory = dataScheduleMode === "history";

                      // Pagination
                      const PAGE_SIZE = 200;
                      const allRows = [...notStarted, ...otherStates];
                      const totalPages = Math.max(1, Math.ceil(allRows.length / PAGE_SIZE));
                      const safePage = Math.min(dataCurrentPage, totalPages);
                      const pagedRows = allRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
                      // Split paged rows back into not-started vs other for separator rendering
                      const pagedNotStarted = pagedRows.filter(r => r.match.state === "0");
                      const pagedOtherStates = pagedRows.filter(r => r.match.state !== "0");

                      const renderMatchRow = (row: DataMatchRow) => {
                        const { match, isFetched, isFetching, openTime, companies, crownFinal, crown12 } = row;

                        // For history mode: show crown_final under home, crown_12 under away
                        // For today/future: show 皇冠 live odds (from DB) under home, fall back to goalBf3
                        const renderHomeOdds = () => {
                          // Today mode + not started: show live odds
                          // Future mode: show live odds
                          // History mode or today's in-progress/finished: show 终盘
                          const showLiveOdds = (dataScheduleMode === "today" && match.state === "0") || dataScheduleMode === "future";
                          if (showLiveOdds) {
                            // PRIORITY: Use 皇冠 live odds from DB (companies array) over goalBf3.xml
                            // goalBf3.xml is NOT 皇冠's odds — it's the website's generic live data source
                            const crownLive = isFetched ? companies.find(c => c.companyId === "3") : null;
                            const hasCrownLive = crownLive && (crownLive.ftHandicapLineLive || crownLive.ftHandicapLine);
                            const hasGoalBf3 = match.handicap || match.totalLine;

                            if (hasCrownLive) {
                              // Use 皇冠 live odds from /analysis/odds/ (more accurate than goalBf3.xml)
                              const hHome = crownLive!.ftHandicapHomeLive || crownLive!.ftHandicapHome || "";
                              const hLine = crownLive!.ftHandicapLineLive || crownLive!.ftHandicapLine || "";
                              const hAway = crownLive!.ftHandicapAwayLive || crownLive!.ftHandicapAway || "";
                              const tOver = crownLive!.ftTotalOverLive || crownLive!.ftTotalOver || "";
                              const tLine = crownLive!.ftTotalLineLive || crownLive!.ftTotalLine || "";
                              const tUnder = crownLive!.ftTotalUnderLive || crownLive!.ftTotalUnder || "";
                              return (
                                <div className="flex flex-col items-center mt-0.5 text-[11px] leading-tight">
                                  <a
                                    href={`https://vip.titan007.com/changeDetail/3in1Odds.aspx?id=${match.id}&companyid=3&l=0`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-0.5 whitespace-nowrap hover:opacity-80 cursor-pointer"
                                  >
                                    <span className="text-right w-8 text-emerald-300">{hHome || "--"}</span>
                                    <span className="font-bold text-center min-w-[40px] text-emerald-200">{formatHandicapLine(hLine) || "--"}</span>
                                    <span className="text-left w-8 text-emerald-300">{hAway || "--"}</span>
                                  </a>
                                  <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
                                    <span className="text-right w-8 text-emerald-300">{tOver || "--"}</span>
                                    <span className="font-bold text-center min-w-[40px] text-emerald-200">{formatHandicapLine(tLine) || "--"}</span>
                                    <span className="text-left w-8 text-emerald-300">{tUnder || "--"}</span>
                                  </span>
                                </div>
                              );
                            }

                            // Fallback: goalBf3.xml data (may not be 皇冠's odds)
                            if (hasGoalBf3) {
                              return (
                                <div className="flex flex-col items-center mt-0.5 text-[11px] leading-tight">
                                  <a
                                    href={`https://vip.titan007.com/changeDetail/3in1Odds.aspx?id=${match.id}&companyid=3&l=0`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-0.5 whitespace-nowrap hover:opacity-80 cursor-pointer"
                                  >
                                    <span className={cn("text-right w-8", match.homeOdds ? getOddsChangeClass(match.id, "homeOdds", match.homeOdds) : "text-gray-600")}>
                                      {match.homeOdds || "--"}
                                    </span>
                                    <span className={cn("font-bold text-center min-w-[40px]", match.handicap ? getHandicapChangeClass(match.id, match.handicapRaw) : "text-gray-600")}>
                                      {match.handicap || "--"}
                                    </span>
                                    <span className={cn("text-left w-8", match.awayOdds ? getOddsChangeClass(match.id, "awayOdds", match.awayOdds) : "text-gray-600")}>
                                      {match.awayOdds || "--"}
                                    </span>
                                  </a>
                                  <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
                                    <span className={cn("text-right w-8", match.overOdds ? getOddsChangeClass(match.id, "overOdds", match.overOdds) : "text-gray-600")}>
                                      {match.overOdds || "--"}
                                    </span>
                                    <span className={cn("font-bold text-center min-w-[40px]", match.totalLine ? getTotalLineChangeClass(match.id, match.totalLineRaw) : "text-gray-600")}>
                                      {match.totalLine || "--"}
                                    </span>
                                    <span className={cn("text-left w-8", match.underOdds ? getOddsChangeClass(match.id, "underOdds", match.underOdds) : "text-gray-600")}>
                                      {match.underOdds || "--"}
                                    </span>
                                  </span>
                                </div>
                              );
                            }
                          }
                          // History mode or today's in-progress/finished: show 终盘 (crown_final)
                          const showFinalOdds = isHistory || (dataScheduleMode === "today" && match.state !== "0");
                          if (showFinalOdds && crownFinal) {
                            return (
                              <div className="flex flex-col items-center mt-0.5 text-[11px] leading-tight">
                                <span className="text-gray-400 text-[11px]">终盘</span>
                                <a
                                  href={`https://vip.titan007.com/changeDetail/3in1Odds.aspx?id=${match.id}&companyid=3&l=0`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-0.5 whitespace-nowrap hover:opacity-80 cursor-pointer"
                                >
                                  <span className="text-right w-8 text-gray-400">{crownFinal.handicapHome || "--"}</span>
                                  <span className="font-bold text-center min-w-[40px] text-gray-300">{formatHandicapLine(crownFinal.handicapLine || "--")}</span>
                                  <span className="text-left w-8 text-gray-400">{crownFinal.handicapAway || "--"}</span>
                                </a>
                                <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
                                  <span className="text-right w-8 text-gray-400">{crownFinal.totalOver || "--"}</span>
                                  <span className="font-bold text-center min-w-[40px] text-gray-300">{crownFinal.totalLine || "--"}</span>
                                  <span className="text-left w-8 text-gray-400">{crownFinal.totalUnder || "--"}</span>
                                </span>
                              </div>
                            );
                          }
                          return null;
                        };

                        const renderAwayOdds = () => {
                          // 皇冠新数据: 今日仅12:00后有, 历史任意时间, 未来暂不显示
                          if (crown12 && (isHistory || dataScheduleMode === "today")) {
                            return (
                              <div className="flex flex-col items-center mt-0.5 text-[11px] leading-tight">
                                <a
                                  href={`https://vip.titan007.com/changeDetail/3in1Odds.aspx?id=${match.id}&companyid=3&l=0`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-0.5 whitespace-nowrap hover:opacity-80 cursor-pointer"
                                >
                                  <span className="text-right w-8 text-gray-400">{crown12.handicapHome || "--"}</span>
                                  <span className="font-bold text-center min-w-[40px] text-gray-300">{crown12.handicapLine || "--"}</span>
                                  <span className="text-left w-8 text-gray-400">{crown12.handicapAway || "--"}</span>
                                </a>
                                <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
                                  <span className="text-right w-8 text-gray-400">{crown12.totalOver || "--"}</span>
                                  <span className="font-bold text-center min-w-[40px] text-gray-300">{crown12.totalLine || "--"}</span>
                                  <span className="text-left w-8 text-gray-400">{crown12.totalUnder || "--"}</span>
                                </span>
                              </div>
                            );
                          }
                          return null;
                        };

                        if (!isFetched || companies.length === 0) {
                          // Single row: match info + fetch button
                          return (
                            <tr key={match.id} className={cn("border-b border-gray-800/30 hover:bg-gray-800/20", getMatchRowClass(match.state))}>
                              <td className="px-2 py-1 text-center text-gray-500 whitespace-nowrap">{openTime}</td>
                              <td className="px-2 py-1 text-center text-blue-300">{match.league}</td>
                              <td className="px-2 py-1 text-center whitespace-nowrap">
                                <MatchSituation state={match.state} time={match.time} display="time" />
                              </td>
                              {isHistory && <td className="px-1 py-1 text-center text-gray-400 whitespace-nowrap">{match.homeScore && match.awayScore ? `${match.homeScore}-${match.awayScore}` : ""}</td>}
                              {isHistory && <td className="px-1 py-1 text-center text-gray-500 whitespace-nowrap text-[11px]">{match.halfHomeScore && match.halfAwayScore ? `${match.halfHomeScore}-${match.halfAwayScore}` : ""}</td>}
                              <td className="px-2 py-1 text-center align-middle">
                                <div className="text-white font-medium">{match.homeTeam}{match.homeRank && <span className="text-gray-500 text-[11px] ml-0.5">[{match.homeRank}]</span>}</div>
                                {renderHomeOdds()}
                              </td>
                              <td className="px-2 py-1 text-center align-middle">
                                <div className="text-white font-medium">{match.awayTeam}{match.awayRank && <span className="text-gray-500 text-[11px] ml-0.5">[{match.awayRank}]</span>}</div>
                                {renderAwayOdds()}
                              </td>
                              {/* Fetch button */}
                              <td className="px-2 py-1 text-center" colSpan={isHistory ? 12 : 10}>
                                <div className="flex items-center justify-center gap-2">
                                  <button
                                    className={cn(
                                      "text-[11px] px-2 py-0.5 rounded transition-colors",
                                      isFetching
                                        ? "bg-yellow-600/20 text-yellow-400 cursor-wait"
                                        : "bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 hover:text-blue-300"
                                    )}
                                    onClick={() => {
                                      setFailedMatches(prev => { const next = new Map(prev); next.delete(match.id); return next; });
                                      fetchSingleMatchOdds(match.id);
                                    }}
                                    disabled={isFetching}
                                  >
                                    {isFetching ? "抓取中..." : failedMatches.has(match.id) ? "重试抓取" : "抓取赔率"}
                                  </button>
                                  {dataScheduleMode !== "history" && (
                                    <button
                                      className={cn(
                                        "text-[11px] px-2 py-0.5 rounded transition-colors",
                                        analyzingMatchId === match.id
                                          ? "bg-purple-600/20 text-purple-400 cursor-wait"
                                          : "bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 hover:text-purple-300"
                                      )}
                                      onClick={() => analyzeSingleMatch(match.id, true)}
                                      disabled={!!analyzingMatchId}
                                    >
                                      {analyzingMatchId === match.id ? "AI中..." : "AI"}
                                    </button>
                                  )}
                                  {failedMatches.has(match.id) && (
                                    <span className="text-[11px] text-red-400">{failedMatches.get(match.id)}</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        }

                        // Multiple rows: match info merged + company odds rows
                        return companies.map((c, idx) => (
                          <tr key={`${match.id}-${c.companyId}`} className={cn("border-b border-gray-800/20 hover:bg-gray-800/10", getMatchRowClass(match.state))}>
                            {/* Each company's open time */}
                            <td className="px-2 py-1 text-center text-gray-500 whitespace-nowrap">{c.openTime || ""}</td>
                            {/* Match info - merged for first row */}
                            {idx === 0 && <td className="px-2 py-1 text-center text-blue-300 align-middle" rowSpan={companies.length}>{match.league}</td>}
                            {idx === 0 && <td className="px-2 py-1 text-center whitespace-nowrap align-middle" rowSpan={companies.length}>
                              <MatchSituation state={match.state} time={match.time} display="time" />
                            </td>}
                            {idx === 0 && isHistory && <td className="px-1 py-1 text-center text-gray-400 whitespace-nowrap align-middle" rowSpan={companies.length}>{match.homeScore && match.awayScore ? `${match.homeScore}-${match.awayScore}` : ""}</td>}
                            {idx === 0 && isHistory && <td className="px-1 py-1 text-center text-gray-500 whitespace-nowrap text-[11px] align-middle" rowSpan={companies.length}>{match.halfHomeScore && match.halfAwayScore ? `${match.halfHomeScore}-${match.halfAwayScore}` : ""}</td>}
                            {idx === 0 && <td className="px-2 py-1 text-center align-middle" rowSpan={companies.length}>
                                <div className="text-white font-medium">{match.homeTeam}{match.homeRank && <span className="text-gray-500 text-[11px] ml-0.5">[{match.homeRank}]</span>}</div>
                                {renderHomeOdds()}
                            </td>}
                            {idx === 0 && <td className="px-2 py-1 text-center align-middle" rowSpan={companies.length}>
                                <div className="text-white font-medium">{match.awayTeam}{match.awayRank && <span className="text-gray-500 text-[11px] ml-0.5">[{match.awayRank}]</span>}</div>
                                {renderAwayOdds()}
                            </td>}
                            {/* Company name */}
                            <td className="px-2 py-1 text-center text-cyan-300 font-medium whitespace-nowrap">{c.companyName}</td>
                            {/* Full-time Asian handicap (initial) */}
                            <td className="px-1 py-1 text-right text-gray-400">{c.ftHandicapHome || "--"}</td>
                            <td className="px-1 py-1 text-center text-white font-medium">{c.ftHandicapLine || "--"}</td>
                            <td className="px-1 py-1 text-left text-gray-400">{c.ftHandicapAway || "--"}</td>
                            {/* Euro-to-Asian handicap (initial) - from website's original data */}
                            <td className="px-1 py-1 text-right text-gray-400">{c.euroAsianHome || "--"}</td>
                            <td className="px-1 py-1 text-center text-purple-300 font-medium">{c.euroAsianLine || "--"}</td>
                            <td className="px-1 py-1 text-left text-gray-400">{c.euroAsianAway || "--"}</td>
                            {/* Total goals (initial) */}
                            <td className="px-1 py-1 text-right text-gray-400">{c.ftTotalOver || "--"}</td>
                            <td className="px-1 py-1 text-center text-amber-300 font-medium">{c.ftTotalLine || "--"}</td>
                            <td className="px-1 py-1 text-left text-gray-400">{c.ftTotalUnder || "--"}</td>
                          </tr>
                        ));
                      };

                      return (
                        <>
                          {/* Not-started matches (paged) */}
                          {pagedNotStarted.map(row => {
                            const result = analysisResults.get(row.match.id);
                            const isExpanded = analysisExpanded === row.match.id;
                            return (
                              <Fragment key={row.match.id}>
                                {renderMatchRow(row)}
                                {/* AI analysis result row */}
                                {result && (
                                  <tr className="border-b border-border/70 bg-surface-1/60">
                                    <td colSpan={dataScheduleMode === "history" ? 17 : 15} className="p-2 sm:p-3">
                                      <AIAnalysisResultPanel
                                        panelId={`data-center-${row.match.id}`}
                                        analysis={result}
                                        analyzedAtLabel={formatAnalysisTime(result.analyzedAt)}
                                        patterns={evolutionStats?.topPatterns}
                                        messages={chatMessages.get(row.match.id) || []}
                                        isDetailExpanded={isExpanded}
                                        isChatOpen={chatOpen === row.match.id}
                                        chatInput={chatOpen === row.match.id ? chatInput : ""}
                                        chatStreaming={chatStreaming}
                                        onToggleDetail={() => {
                                          const next = isExpanded ? null : row.match.id;
                                          setAnalysisExpanded(next);
                                          if (next) loadAnalysisDetail(next);
                                        }}
                                        onToggleChat={() => setChatOpen(chatOpen === row.match.id ? null : row.match.id)}
                                        onChatInputChange={setChatInput}
                                        onSendChat={() => sendChatMessage(row.match.id, chatInput)}
                                      />
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                          {/* Separator for finished/in-progress matches */}
                          {pagedOtherStates.length > 0 && (
                            <tr>
                              <td colSpan={dataScheduleMode === "history" ? 17 : 15} className="py-2 px-3 border-t border-b border-border bg-surface-2/80">
                                <div className="match-group-title mb-0">
                                  <span>其他赛况</span>
                                  <strong>{otherStates.length}</strong>
                                  <span>进行、中场、完场及未知状态</span>
                                </div>
                              </td>
                            </tr>
                          )}
                          {/* Finished / in-progress matches (paged) */}
                          {pagedOtherStates.map(row => renderMatchRow(row))}
                          {/* Pagination controls */}
                          {totalPages > 1 && (
                            <tr>
                              <td colSpan={dataScheduleMode === "history" ? 17 : 15} className="py-2 px-3">
                                <div className="flex items-center justify-center gap-2 text-xs text-gray-400">
                                  <button
                                    className="px-2 py-1 rounded bg-gray-700/50 hover:bg-gray-600/50 disabled:opacity-30"
                                    onClick={() => setDataCurrentPage(p => Math.max(1, p - 1))}
                                    disabled={safePage <= 1}
                                  >上一页</button>
                                  <span>{safePage} / {totalPages} 页 (共{allRows.length}场)</span>
                                  <button
                                    className="px-2 py-1 rounded bg-gray-700/50 hover:bg-gray-600/50 disabled:opacity-30"
                                    onClick={() => setDataCurrentPage(p => Math.min(totalPages, p + 1))}
                                    disabled={safePage >= totalPages}
                                  >下一页</button>
                                  <select
                                    className="bg-gray-700/50 rounded px-1 py-0.5 text-gray-300 border border-gray-600/50"
                                    value={safePage}
                                    onChange={(e) => setDataCurrentPage(Number(e.target.value))}
                                  >
                                    {Array.from({ length: totalPages }, (_, i) => (
                                      <option key={i + 1} value={i + 1}>第{i + 1}页</option>
                                    ))}
                                  </select>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })()}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Comparison Tab */}
        {activeTab === "comparison" && (
          <div className="space-y-4">
            {oddsComparisonSummary.matchCount > 0 ? (
              <div className={cn(
                "rounded-lg p-4 border",
                oddsComparisonSummary.totalDiff > oddsAlertThreshold
                  ? "bg-red-900/20 border-red-700/50"
                  : "bg-gray-800/50 border-gray-700"
              )}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-medium text-white">笔记赔率对比汇总</span>
                    <span className="text-xs text-gray-400">({oddsComparisonSummary.matchCount} 项)</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-gray-400">基准总赔率:</span>
                      <input
                        type="number"
                        step="0.01"
                        min="1"
                        className="bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1 w-16"
                        value={oddsBaseTotal}
                        onChange={(e) => setOddsBaseTotal(parseFloat(e.target.value) || 1.90)}
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-gray-400">报警阈值:</span>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        className="bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1 w-16"
                        value={oddsAlertThreshold}
                        onChange={(e) => setOddsAlertThreshold(parseFloat(e.target.value) || 0.5)}
                      />
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 mb-4 lg:grid-cols-4">
                  <div className="text-center bg-gray-900/40 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-1">总超值</div>
                    <div className={cn(
                      "text-2xl font-bold",
                      oddsComparisonSummary.totalDiff > oddsAlertThreshold ? "text-red-400" : oddsComparisonSummary.totalDiff < 0 ? "text-red-400" : "text-green-400"
                    )}>
                      {oddsComparisonSummary.totalDiff >= 0 ? "+" : ""}{oddsComparisonSummary.totalDiff.toFixed(2)}
                    </div>
                  </div>
                  <div className="text-center bg-gray-900/40 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-1">基准</div>
                    <div className="text-2xl font-bold text-gray-300">{oddsBaseTotal.toFixed(2)}</div>
                  </div>
                  <div className="text-center bg-gray-900/40 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-1">阈值</div>
                    <div className="text-2xl font-bold text-gray-300">{oddsAlertThreshold.toFixed(1)}</div>
                  </div>
                  <div className="text-center bg-gray-900/40 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-1">状态</div>
                    <div className={cn(
                      "text-2xl font-bold",
                      oddsComparisonSummary.totalDiff > oddsAlertThreshold ? "text-red-400" : "text-green-400"
                    )}>
                      {oddsComparisonSummary.totalDiff > oddsAlertThreshold ? "偏差大!" : "正常"}
                    </div>
                  </div>
                </div>

                {/* Detail table */}
                <div className="odds-table-wrap">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-900/60 border-b border-gray-700/50">
                        <th className="px-3 py-2 text-left text-gray-400 font-medium">类型</th>
                        <th className="px-3 py-2 text-left text-gray-400 font-medium">赛事</th>
                        <th className="px-3 py-2 text-center text-gray-400 font-medium">笔记赔率</th>
                        <th className="px-3 py-2 text-center text-gray-400 font-medium">即时对方</th>
                        <th className="px-3 py-2 text-center text-gray-400 font-medium">总水</th>
                        <th className="px-3 py-2 text-center text-gray-400 font-medium">差值</th>
                      </tr>
                    </thead>
                    <tbody>
                      {oddsComparisonSummary.details.map((d, i) => (
                        <tr key={i} className={cn(
                          "border-b border-gray-800/30",
                          d.diff > oddsAlertThreshold / oddsComparisonSummary.matchCount
                            ? "bg-red-950/10"
                            : "bg-gray-900/20"
                        )}>
                          <td className="px-3 py-2">
                            <span className={cn(
                              "px-1.5 py-0.5 rounded text-[11px]",
                              d.type === "handicap" ? "bg-blue-900/30 text-blue-300" : "bg-purple-900/30 text-purple-300"
                            )}>
                              {d.type === "handicap" ? "让球" : "大小"}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-gray-300">{d.home} vs {d.away}</td>
                          <td className="px-3 py-2 text-center text-amber-300">{d.predictedOdds.toFixed(2)}</td>
                          <td className="px-3 py-2 text-center text-cyan-300">{d.currentOdds.toFixed(2)}</td>
                          <td className="px-3 py-2 text-center text-gray-300">{d.sumTotal.toFixed(2)}</td>
                          <td className="px-3 py-2 text-center">
                            <span className={cn(
                              "font-bold",
                              d.diff > 0 ? "text-green-400" : d.diff < 0 ? "text-red-400" : "text-gray-400"
                            )}>
                              {d.diff >= 0 ? "+" : ""}{d.diff.toFixed(2)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="text-center text-gray-500 py-12">
                <p className="text-sm">暂无笔记赔率对比数据</p>
                <p className="text-xs mt-2 text-gray-600">在赔率监控页面为赛事添加笔记后，系统会自动对比笔记赔率与实时赔率</p>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Alert Config Dialog */}
      <Dialog open={alertDialogOpen} onOpenChange={setAlertDialogOpen}>
        <DialogContent className="odds-dialog text-gray-100 max-w-lg" aria-describedby="alert-config-description">
          <DialogHeader>
            <DialogTitle className="text-gray-100">设置赔率提醒</DialogTitle>
          </DialogHeader>
          <p id="alert-config-description" className="sr-only">配置赛事赔率变化的提醒阈值</p>
          {currentAlertMatchId && (
            <div className="space-y-4">
              <div className="text-sm text-gray-400">
                {matches.find((m) => m.id === currentAlertMatchId)?.homeTeam} vs {matches.find((m) => m.id === currentAlertMatchId)?.awayTeam}
              </div>
              <Separator className="bg-gray-700" />

              {/* Handicap alerts */}
              <div>
                <Label className="text-gray-300 mb-2 block">让球盘口变化提醒</Label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="text-xs text-gray-500">升多少提醒</Label>
                    <Input type="number" step="0.25" placeholder="如 0.25" className="bg-gray-800 border-gray-700 text-gray-200 mt-1"
                      value={alertConfigs.get(currentAlertMatchId)?.handicapUp || ""}
                      onChange={(e) => updateAlertConfig("handicapUp", e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500">降多少提醒</Label>
                    <Input type="number" step="0.25" placeholder="如 0.25" className="bg-gray-800 border-gray-700 text-gray-200 mt-1"
                      value={alertConfigs.get(currentAlertMatchId)?.handicapDown || ""}
                      onChange={(e) => updateAlertConfig("handicapDown", e.target.value)} />
                  </div>
                </div>
              </div>

              {/* Total line alerts */}
              <div>
                <Label className="text-gray-300 mb-2 block">大小球盘口变化提醒</Label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="text-xs text-gray-500">升多少提醒</Label>
                    <Input type="number" step="0.25" placeholder="如 0.25" className="bg-gray-800 border-gray-700 text-gray-200 mt-1"
                      value={alertConfigs.get(currentAlertMatchId)?.totalLineUp || ""}
                      onChange={(e) => updateAlertConfig("totalLineUp", e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500">降多少提醒</Label>
                    <Input type="number" step="0.25" placeholder="如 0.25" className="bg-gray-800 border-gray-700 text-gray-200 mt-1"
                      value={alertConfigs.get(currentAlertMatchId)?.totalLineDown || ""}
                      onChange={(e) => updateAlertConfig("totalLineDown", e.target.value)} />
                  </div>
                </div>
              </div>

              {/* Odds alerts */}
              <div>
                <Label className="text-gray-300 mb-2 block">赔率变化提醒</Label>
                <div className="space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <Label className="text-xs text-gray-500">主队赔率升</Label>
                      <Input type="number" step="0.05" placeholder="如 0.10" className="bg-gray-800 border-gray-700 text-gray-200 mt-1"
                        value={alertConfigs.get(currentAlertMatchId)?.homeOddsUp || ""}
                        onChange={(e) => updateAlertConfig("homeOddsUp", e.target.value)} />
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500">主队赔率降</Label>
                      <Input type="number" step="0.05" placeholder="如 0.10" className="bg-gray-800 border-gray-700 text-gray-200 mt-1"
                        value={alertConfigs.get(currentAlertMatchId)?.homeOddsDown || ""}
                        onChange={(e) => updateAlertConfig("homeOddsDown", e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <Label className="text-xs text-gray-500">客队赔率升</Label>
                      <Input type="number" step="0.05" placeholder="如 0.10" className="bg-gray-800 border-gray-700 text-gray-200 mt-1"
                        value={alertConfigs.get(currentAlertMatchId)?.awayOddsUp || ""}
                        onChange={(e) => updateAlertConfig("awayOddsUp", e.target.value)} />
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500">客队赔率降</Label>
                      <Input type="number" step="0.05" placeholder="如 0.10" className="bg-gray-800 border-gray-700 text-gray-200 mt-1"
                        value={alertConfigs.get(currentAlertMatchId)?.awayOddsDown || ""}
                        onChange={(e) => updateAlertConfig("awayOddsDown", e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <Label className="text-xs text-gray-500">大球赔率升</Label>
                      <Input type="number" step="0.05" placeholder="如 0.10" className="bg-gray-800 border-gray-700 text-gray-200 mt-1"
                        value={alertConfigs.get(currentAlertMatchId)?.overOddsUp || ""}
                        onChange={(e) => updateAlertConfig("overOddsUp", e.target.value)} />
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500">大球赔率降</Label>
                      <Input type="number" step="0.05" placeholder="如 0.10" className="bg-gray-800 border-gray-700 text-gray-200 mt-1"
                        value={alertConfigs.get(currentAlertMatchId)?.overOddsDown || ""}
                        onChange={(e) => updateAlertConfig("overOddsDown", e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <Label className="text-xs text-gray-500">小球赔率升</Label>
                      <Input type="number" step="0.05" placeholder="如 0.10" className="bg-gray-800 border-gray-700 text-gray-200 mt-1"
                        value={alertConfigs.get(currentAlertMatchId)?.underOddsUp || ""}
                        onChange={(e) => updateAlertConfig("underOddsUp", e.target.value)} />
                    </div>
                    <div>
                      <Label className="text-xs text-gray-500">小球赔率降</Label>
                      <Input type="number" step="0.05" placeholder="如 0.10" className="bg-gray-800 border-gray-700 text-gray-200 mt-1"
                        value={alertConfigs.get(currentAlertMatchId)?.underOddsDown || ""}
                        onChange={(e) => updateAlertConfig("underOddsDown", e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <Button variant="destructive" size="sm" onClick={() => { removeAlertConfig(currentAlertMatchId); setAlertDialogOpen(false); }}>删除提醒</Button>
                <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => setAlertDialogOpen(false)}>确认保存</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Feishu Settings Dialog */}
      <Dialog open={feishuDialogOpen} onOpenChange={setFeishuDialogOpen}>
        <DialogContent className="odds-dialog text-gray-100 max-w-lg" aria-describedby="feishu-settings-description">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="text-lg">🤖</span> 飞书机器人设置
            </DialogTitle>
            <p id="feishu-settings-description" className="sr-only">配置飞书群机器人Webhook</p>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm text-gray-400 mb-1 block">Webhook URL</label>
              <input
                type="text"
                value={feishuWebhookUrl}
                onChange={e => setFeishuWebhookUrl(e.target.value)}
                placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxx"
                className="w-full bg-[#0d1117] border border-gray-600 rounded px-3 py-2 text-sm text-gray-100 focus:border-sky-500 focus:outline-none"
              />
              <p className="text-xs text-gray-500 mt-1">
                飞书群 → 设置 → 群机器人 → 添加机器人 → 复制Webhook地址
              </p>
            </div>

            <div>
              <label className="text-sm text-gray-400 mb-2 block">通知场景</label>
              <div className="space-y-1 text-xs text-gray-300">
                <div className="flex items-center gap-2">
                  <span className="text-green-400">●</span> AI分析完成 — 每次AI分析自动推送水位方向结果
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-green-400">●</span> 批量AI分析完成 — 推送分析进度和结果摘要
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-green-400">●</span> 定时任务完成 — 赔率抓取/AI分析/验证学习
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-green-400">●</span> 赔率提醒 — 阈值触发时推送告警
                </div>
              </div>
            </div>

            {feishuTestResult && (
              <div className={`text-sm px-3 py-2 rounded ${feishuTestResult.startsWith("✅") ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}>
                {feishuTestResult}
              </div>
            )}

            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={testFeishuNotification}
                disabled={feishuTesting || !feishuWebhookUrl}
                className="px-4 py-1.5 text-sm bg-sky-700 hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed rounded"
              >
                {feishuTesting ? "发送中..." : "测试通知"}
              </button>
              <button
                onClick={saveFeishuSettings}
                disabled={feishuSaving}
                className="px-4 py-1.5 text-sm bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded"
              >
                {feishuSaving ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Focused Leagues Whitelist Dialog */}
      <Dialog open={focusedLeagueDialogOpen} onOpenChange={setFocusedLeagueDialogOpen}>
        <DialogContent className="odds-dialog text-gray-100 max-w-lg max-h-[80vh]" aria-describedby="focused-leagues-dialog-description">
          <DialogHeader>
            <DialogTitle className="text-gray-100">
              用户关注联赛白名单
              <span className="text-xs text-gray-400 ml-2">
                (当前{focusedLeagueEditing.size}个联赛 | 今日赛程显示全部，历史/未来只显示白名单)
              </span>
            </DialogTitle>
          </DialogHeader>
          <p id="focused-leagues-dialog-description" className="sr-only">管理用户关注的联赛白名单</p>
          <div className="flex flex-col gap-3">
            {/* Search + actions */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="搜索联赛..."
                value={focusedLeagueSearch}
                onChange={(e) => setFocusedLeagueSearch(e.target.value)}
                className="flex-1 h-8 bg-gray-800 border border-gray-700 rounded px-3 text-sm text-gray-200 placeholder-gray-500"
              />
              <Button
                size="sm" variant="ghost"
                className="text-xs text-blue-400 hover:text-blue-300 h-8 px-2"
                onClick={() => setFocusedLeagueEditing(new Set(allKnownLeagues))}
              >
                全选
              </Button>
              <Button
                size="sm" variant="ghost"
                className="text-xs text-red-400 hover:text-red-300 h-8 px-2"
                onClick={() => setFocusedLeagueEditing(new Set())}
              >
                全不选
              </Button>
            </div>
            {/* Add new league */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="手动添加联赛名..."
                id="focused-league-add-input"
                className="flex-1 h-8 bg-gray-800 border border-gray-700 rounded px-3 text-sm text-gray-200 placeholder-gray-500"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (val && !focusedLeagueEditing.has(val)) {
                      setFocusedLeagueEditing(prev => new Set([...prev, val]));
                      if (!allKnownLeagues.includes(val)) {
                        setAllKnownLeagues(prev => [...prev, val].sort());
                      }
                      (e.target as HTMLInputElement).value = "";
                    }
                  }
                }}
              />
              <Button
                size="sm" variant="ghost"
                className="text-xs text-green-400 hover:text-green-300 h-8 px-2"
                onClick={() => {
                  const input = document.getElementById("focused-league-add-input") as HTMLInputElement;
                  const val = input?.value.trim();
                  if (val && !focusedLeagueEditing.has(val)) {
                    setFocusedLeagueEditing(prev => new Set([...prev, val]));
                    if (!allKnownLeagues.includes(val)) {
                      setAllKnownLeagues(prev => [...prev, val].sort());
                    }
                    input.value = "";
                  }
                }}
              >
                +添加
              </Button>
            </div>
            {/* League list */}
            <ScrollArea className="h-[400px] border border-gray-700 rounded">
              <div className="p-2 space-y-0.5">
                {allKnownLeagues
                  .filter(l => !focusedLeagueSearch || l.includes(focusedLeagueSearch))
                  .map(league => {
                    const checked = focusedLeagueEditing.has(league);
                    return (
                      <label
                        key={league}
                        className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer text-sm ${
                          checked ? "bg-amber-900/30 text-amber-300" : "text-gray-400 hover:bg-gray-800"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = new Set(focusedLeagueEditing);
                            if (e.target.checked) next.add(league);
                            else next.delete(league);
                            setFocusedLeagueEditing(next);
                          }}
                          className="accent-amber-500"
                        />
                        <span>{league}</span>
                      </label>
                    );
                  })}
                {allKnownLeagues.filter(l => !focusedLeagueSearch || l.includes(focusedLeagueSearch)).length === 0 && (
                  <div className="text-gray-500 text-sm text-center py-4">无匹配联赛</div>
                )}
              </div>
            </ScrollArea>
            {/* Save button */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">
                保存后自动同步历史赛程和预测报表
              </span>
              <Button
                onClick={saveFocusedLeagues}
                disabled={focusedLeagueSaving}
                className="bg-amber-600 hover:bg-amber-700 text-white h-8 px-4"
              >
                {focusedLeagueSaving ? "保存中..." : "保存白名单"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Note Dialog */}
      <Dialog open={noteDialogOpen} onOpenChange={setNoteDialogOpen}>
        <DialogContent className="odds-dialog text-gray-100 max-w-md" aria-describedby="note-dialog-description">
          <DialogHeader>
            <DialogTitle className="text-gray-100">编辑笔记</DialogTitle>
          </DialogHeader>
          <p id="note-dialog-description" className="sr-only">编辑赛事让球和大小球笔记</p>
          {noteMatchId && (() => {
            const m = matches.find((x) => x.id === noteMatchId);
            if (!m) return null;
            const handicapOddsText = `${m.handicap || "--"} ${m.homeOdds || "--"}/${m.awayOdds || "--"}`;
            const totalOddsText = `${m.totalLine || "--"} ${m.overOdds || "--"}/${m.underOdds || "--"}`;
            return (
              <div className="space-y-4">
                <div className="text-sm text-gray-400">
                  {m.homeTeam} vs {m.awayTeam}
                </div>

                <Separator className="bg-gray-700" />

                {/* Handicap note */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <Label className="text-gray-300">让球笔记</Label>
                    <span className="text-xs text-gray-500">{handicapOddsText}</span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      className="bg-gray-800 border-gray-700 text-gray-200 text-sm flex-1"
                      placeholder="输入让球笔记..."
                      value={editHandicapNote}
                      onChange={(e) => setEditHandicapNote(e.target.value)}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-gray-700 text-gray-400 hover:text-gray-200 shrink-0 h-9"
                      onClick={() => setEditHandicapNote(handicapOddsText)}
                      title="填入当前让球赔率"
                    >
                      填入
                    </Button>
                  </div>
                  {/* Quick insert buttons for handicap */}
                  <div className="flex gap-1.5 mt-1.5">
                    <button
                      className="px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-400 hover:text-blue-300 hover:border-blue-600 transition-colors"
                      onClick={() => setEditHandicapNote(editHandicapNote + (editHandicapNote ? " " : "") + "主")}
                    >主</button>
                    <button
                      className="px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-400 hover:text-blue-300 hover:border-blue-600 transition-colors"
                      onClick={() => setEditHandicapNote(editHandicapNote + (editHandicapNote ? " " : "") + "客")}
                    >客</button>
                    <button
                      className="px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-400 hover:text-red-300 hover:border-red-600 transition-colors"
                      onClick={() => setEditHandicapNote(editHandicapNote + (editHandicapNote ? " " : "") + "大")}
                    >大</button>
                    <button
                      className="px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-400 hover:text-green-300 hover:border-green-600 transition-colors"
                      onClick={() => setEditHandicapNote(editHandicapNote + (editHandicapNote ? " " : "") + "小")}
                    >小</button>
                    <button
                      className="px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
                      onClick={() => setEditHandicapNote("")}
                    >清空</button>
                  </div>
                  {/* Amount input + settled checkbox for handicap */}
                  <div className="flex items-center gap-3 mt-2">
                    <Input
                      className="bg-gray-800 border-gray-700 text-gray-200 text-sm h-7 flex-1"
                      placeholder="金额..."
                      value={editHandicapAmount}
                      onChange={(e) => setEditHandicapAmount(e.target.value)}
                    />
                    <label className="flex items-center gap-1 cursor-pointer shrink-0">
                      <input
                        type="checkbox"
                        className="accent-blue-500 w-4 h-4"
                        checked={editHandicapSettled}
                        onChange={(e) => setEditHandicapSettled(e.target.checked)}
                      />
                      <span className={cn("text-xs", editHandicapSettled ? "text-green-400" : "text-gray-500")}>已补</span>
                    </label>
                  </div>
                </div>

                {/* Total line note */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <Label className="text-gray-300">大小球笔记</Label>
                    <span className="text-xs text-gray-500">{totalOddsText}</span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      className="bg-gray-800 border-gray-700 text-gray-200 text-sm flex-1"
                      placeholder="输入大小球笔记..."
                      value={editTotalNote}
                      onChange={(e) => setEditTotalNote(e.target.value)}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-gray-700 text-gray-400 hover:text-gray-200 shrink-0 h-9"
                      onClick={() => setEditTotalNote(totalOddsText)}
                      title="填入当前大小球赔率"
                    >
                      填入
                    </Button>
                  </div>
                  {/* Quick insert buttons for total */}
                  <div className="flex gap-1.5 mt-1.5">
                    <button
                      className="px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-400 hover:text-blue-300 hover:border-blue-600 transition-colors"
                      onClick={() => setEditTotalNote(editTotalNote + (editTotalNote ? " " : "") + "主")}
                    >主</button>
                    <button
                      className="px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-400 hover:text-blue-300 hover:border-blue-600 transition-colors"
                      onClick={() => setEditTotalNote(editTotalNote + (editTotalNote ? " " : "") + "客")}
                    >客</button>
                    <button
                      className="px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-400 hover:text-red-300 hover:border-red-600 transition-colors"
                      onClick={() => setEditTotalNote(editTotalNote + (editTotalNote ? " " : "") + "大")}
                    >大</button>
                    <button
                      className="px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-400 hover:text-green-300 hover:border-green-600 transition-colors"
                      onClick={() => setEditTotalNote(editTotalNote + (editTotalNote ? " " : "") + "小")}
                    >小</button>
                    <button
                      className="px-2 py-0.5 text-[11px] rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
                      onClick={() => setEditTotalNote("")}
                    >清空</button>
                  </div>
                  {/* Amount input + settled checkbox for total */}
                  <div className="flex items-center gap-3 mt-2">
                    <Input
                      className="bg-gray-800 border-gray-700 text-gray-200 text-sm h-7 flex-1"
                      placeholder="金额..."
                      value={editTotalAmount}
                      onChange={(e) => setEditTotalAmount(e.target.value)}
                    />
                    <label className="flex items-center gap-1 cursor-pointer shrink-0">
                      <input
                        type="checkbox"
                        className="accent-blue-500 w-4 h-4"
                        checked={editTotalSettled}
                        onChange={(e) => setEditTotalSettled(e.target.checked)}
                      />
                      <span className={cn("text-xs", editTotalSettled ? "text-green-400" : "text-gray-500")}>已补</span>
                    </label>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2">
                  <Button variant="destructive" size="sm" onClick={() => { clearMatchNotes(noteMatchId); setNoteDialogOpen(false); }}>
                    删除笔记
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="border-gray-700 text-gray-400" onClick={() => setNoteDialogOpen(false)}>取消</Button>
                    <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={saveNotes}>保存</Button>
                  </div>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Paste JSON Dialog */}
      <Dialog open={pasteDialogOpen} onOpenChange={setPasteDialogOpen}>
        <DialogContent className="odds-dialog text-gray-100 max-w-lg" aria-describedby="paste-json-description">
          <DialogHeader>
            <DialogTitle className="text-gray-100">预测数据</DialogTitle>
          </DialogHeader>
          <p id="paste-json-description" className="sr-only">按日期管理预测 JSON 数据</p>
          <div className="space-y-3">
            {/* Date selector */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400">日期:</label>
              <input
                type="text"
                className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded px-2 py-1 w-28 font-mono"
                placeholder="YYYYMMDD"
                value={selectedPredDate}
                onChange={(e) => {
                  const d = e.target.value;
                  setSelectedPredDate(d);
                  if (d.length === 8) loadPredictionByDate(d);
                }}
              />
              {predictionDates.length > 0 && (
                <select
                  className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded px-2 py-1"
                  value={selectedPredDate}
                  onChange={(e) => {
                    const d = e.target.value;
                    setSelectedPredDate(d);
                    if (d) {
                      loadPredictionByDate(d);
                      fetch(`/api/prediction?date=${d}`)
                        .then((res) => res.json())
                        .then((json) => setPastedJson(json.data || ""))
                        .catch(() => {});
                    }
                  }}
                >
                  <option value="">选择已有日期</option>
                  {predictionDates.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              )}
            </div>

            {/* URL fetch */}
            <div className="space-y-1.5">
              <label className="text-xs text-gray-400">从链接抓取 (Coze分享链接等):</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded px-2 py-1 flex-1"
                  placeholder="粘贴分享链接..."
                  value={fetchUrlInput}
                  onChange={(e) => { setFetchUrlInput(e.target.value); setFetchError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") fetchUrlAndExtract(); }}
                />
                <Button
                  size="sm"
                  className="bg-emerald-600 hover:bg-emerald-700 shrink-0"
                  disabled={fetchLoading || !fetchUrlInput.trim()}
                  onClick={fetchUrlAndExtract}
                >
                  {fetchLoading ? "抓取中..." : "抓取"}
                </Button>
              </div>
              {fetchError && (
                <div className="text-[11px] text-red-400">{fetchError}</div>
              )}
            </div>

            <div className="border-t border-gray-700 pt-2">
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-gray-400">或直接粘贴 JSON:</label>
                <button
                  className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1"
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText();
                      if (text) setPastedJson(text);
                    } catch {
                      // clipboard API not available
                    }
                  }}
                >
                  <ClipboardPaste className="w-3 h-3" />
                  从剪贴板粘贴
                </button>
              </div>
            </div>

            <textarea
              className="w-full h-60 bg-gray-800 border border-gray-700 rounded-md p-3 text-xs text-gray-200 font-mono resize-y focus:outline-none focus:border-blue-500"
              placeholder='粘贴 JSON 数据到这里...'
              value={pastedJson}
              onChange={(e) => setPastedJson(e.target.value)}
            />
            {pastedJson && (() => {
              try {
                const parsed = JSON.parse(pastedJson);
                let arr: unknown[];
                if (Array.isArray(parsed)) {
                  arr = parsed;
                } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).matches)) {
                  arr = (parsed as Record<string, unknown>).matches as unknown[];
                } else if (parsed && typeof parsed === "object" && ((parsed as Record<string, string>).home)) {
                  arr = [parsed];
                } else {
                  arr = [];
                }
                const predCount = arr.filter((item) => item && typeof item === "object" && (item as Record<string, string>).home && (item as Record<string, string>).away).length;
                return (
                  <div className="text-[11px] text-green-400 flex items-center gap-1">
                    <span>JSON 格式正确</span>
                    <span className="text-gray-500">|</span>
                    <span className="text-gray-400">{predCount} 条赛事数据可匹配</span>
                  </div>
                );
              } catch {
                return (
                  <div className="text-[11px] text-red-400">JSON 格式错误，请检查</div>
                );
              }
            })()}
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="border-gray-700 text-gray-400"
                  onClick={() => { setPastedJson(""); }}
                >
                  清空
                </Button>
                {selectedPredDate && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={async () => {
                      await fetch(`/api/prediction?date=${selectedPredDate}`, { method: "DELETE" });
                      setPredictionDates((prev) => prev.filter((d) => d !== selectedPredDate));
                      setPastedJson("");
                      setSavedJson("");
                      setPredictionDates((prev) => prev);
                    }}
                  >
                    删除此日期
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="border-gray-700 text-gray-400" onClick={() => setPasteDialogOpen(false)}>取消</Button>
                <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => {
                  setSavedJson(pastedJson);
                  savePredictionToServer(pastedJson, selectedPredDate || new Date().toISOString().slice(0, 10).replace(/-/g, ""));
                  setPasteDialogOpen(false);
                }}>保存</Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div ref={alertsEndRef} />
    </Tabs>
  );
}
