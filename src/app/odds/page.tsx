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
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { AIAnalysisResultPanel } from "./_components/ai-analysis-result-panel";
import { MatchSituation, MatchStatusBadge, getMatchRowClass, getMatchStatus, type MatchStatusKind } from "./_components/match-status";
import type {
  AnalysisResultData,
  CompanyOddsData,
  CompanyOddsItem,
  CrownStoredOdds,
  DataMatchRow,
  LeagueData,
  MatchData,
  MatchNotes,
  PinnedMatchInfo,
  ReportData,
} from "@/features/odds/contracts";
import {
  DEFAULT_COMPANY_IDS,
  DEFAULT_FOCUSED_LEAGUES,
} from "@/features/odds/constants";
import {
  buildPurchaseAdvice,
  computePredictionComparison,
  getCompanyLatestOdds,
  getMatchLatestOdds,
} from "@/features/odds/analysis-view-model";
import {
  computeCrown12VsLiveDiff,
  computeHandicapComparison,
  computeTotalComparison,
  getHandicapTrendLabel,
  lineTextToNumber,
  parseHandicapNote,
  parseTotalNote,
} from "@/features/odds/odds-note-parser";
import {
  getLeagueInitial,
  isLeagueSelected,
  matchLeague,
} from "@/features/odds/league-matching";
import {
  automationStatusText,
  previousBeijingDateKey,
} from "@/features/odds/automation-view-model";
import { useOddsRefresh } from "@/features/odds/hooks/use-odds-refresh";
import { useAutomationStatus } from "@/features/odds/hooks/use-automation-status";
import { useOddsWorkstation } from "@/features/odds/hooks/use-odds-workstation";
import {
  createOddsFetchCoordinator,
  createOddsRefreshQueue,
  createSerializedExecutor,
  runOddsFetchBatch,
  type OddsFetchSourceResult,
} from "@/features/odds/odds-fetch-orchestrator";
import {
  applyMatchDetailScore,
  fetchMatchOddsSource,
  persistMatchOdds,
  type MatchDetailScore,
  type MatchOddsData,
} from "@/features/odds/match-odds-client";
import {
  countSupplementalTargets,
  fetchSupplementalOdds,
  persistSupplementalOdds,
  runSupplementalBatch,
  runSupplementalOddsUpdate,
  selectSupplementalTargets,
  type SupplementalFetchType,
} from "@/features/odds/supplemental-odds-client";
import { createAutomaticOddsFetchLifecycle } from "@/features/odds/automatic-odds-fetch";
import {
  fetchAnalysisList,
  fetchEvolutionStats,
  requestAnalysis,
  requestAnalysisChat,
  requestLearning,
  requestManualVerification,
  requestVerification,
  type AnalysisChatMessage,
} from "@/features/odds/analysis-client";
import {
  appendAssistantMessage,
  appendUserMessage,
  createBatchAnalysisController,
  prepareAnalysisRequest,
  runAnalysisBatch,
  runAnalysisCommand,
  runVerificationLearning,
  type AnalysisBatchController,
} from "@/features/odds/analysis-orchestrator";
import {
  buildOddsExportRows,
  countOddsExportRows,
  fetchReport,
  fetchReportDates,
  fetchReportTrend,
  filterReportByLeagues,
  generateReport as requestGeneratedReport,
  runReportCommand,
} from "@/features/odds/reporting";
import { buildExcelExportDocument, decideExcelExportRows } from "@/features/odds/excel-export-document";
import {
  createDebouncedLeagueSelectionSaver,
  fetchFocusedLeagues,
  loadLeagueSelections as fetchLeagueSelections,
  saveFocusedLeagues as persistFocusedLeagues,
} from "@/features/odds/league-settings";
import {
  createOddsAlerts,
  shouldPlayThresholdAlert,
  type AlertConfig,
  type AlertItem,
  type OddsSnapshot,
} from "@/features/odds/alerts";
import {
  formatHandicapLine,
  normalizeMatchDateKey,
  normalizeOpenTime,
  parsePredictions,
} from "@/features/odds/workstation-domain";
import {
  createGenerationDatabaseLoadController,
  dateKeysInRange,
  fetchDatabaseOddsDate,
  fetchDatabaseOddsRange,
  projectDatabaseOddsApplication,
  type DatabaseOddsMeta,
} from "@/features/odds/database-odds-workflow";
import {
  buildOddsComparisonSummary,
  projectOtherMatches,
  projectScheduledMatches,
  type WorkstationOtherMatchFilter,
} from "@/features/odds/workstation-projections";
import {
  aggregateScheduleRange,
  countHotMatches,
  createLatestScheduleLoadController,
  createScheduleLoadPlan,
  fetchSchedule,
  runIncrementalOddsFetch,
  selectIncrementalOddsTargets,
  type ScheduleAggregate,
  type ScheduleLoadPlan,
} from "@/features/odds/schedule-orchestrator";
import type { SettlementSummary, PredictionMarket } from "@/lib/verification";
import {
  ODDS_STALE_AFTER_MS,
  isOddsStale,
  type SourceTimestamp,
} from "@/lib/odds-refresh";

// --- Types ---
type OtherMatchFilter = WorkstationOtherMatchFilter;

const OTHER_MATCH_FILTERS: Array<{ key: OtherMatchFilter; label: string; description: string }> = [
  { key: "all", label: "全部", description: "全部其他赛况" },
  { key: "live", label: "进行", description: "正在进行的比赛" },
  { key: "halftime", label: "中场", description: "中场休息的比赛" },
  { key: "finished", label: "完场", description: "已经结束的比赛" },
  { key: "unknown", label: "未知", description: "状态待确认的比赛" },
];

const OTHER_MATCH_STATUS_PRIORITY: Record<Exclude<MatchStatusKind, "scheduled">, number> = {
  live: 0,
  halftime: 1,
  unknown: 2,
  finished: 3,
};



// AI analysis result data (from /api/analysis)


function formatAnalysisTime(value?: string | null): string {
  if (!value) return "未知（历史数据）";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "未知（历史数据）"
    : date.toLocaleString("zh-CN", { hour12: false });
}

type OddsSourceMeta = DatabaseOddsMeta & { sourceObservedAt: SourceTimestamp };

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
async function syncHistoricalScores(dateKey: string): Promise<{ persistedResults: number; status: string }> {
  const response = await fetch(`/api/schedule?date=${dateKey}&mode=history`);
  const json = await response.json();
  if (!response.ok || !json.success) {
    throw new Error(json.error || "赛果同步失败");
  }
  return {
    persistedResults: Number(json.data?.ingestion?.persistence?.persistedResults || json.data?.ingestion?.cached?.finishedResultCount || 0),
    status: String(json.data?.ingestion?.status || "unknown"),
  };
}

export default function OddsMonitorPage() {
  const [matches, setMatches] = useState<MatchData[]>([]);
  const matchesRef = useRef<MatchData[]>([]);
  matchesRef.current = matches;
  const [leagues, setLeagues] = useState<LeagueData[]>([]);
  const [hotMatchCount, setHotMatchCount] = useState(0); // Total hot matches across ALL states
  const [selectedLeagues, setSelectedLeagues] = useState<Set<string>>(new Set());
  const [otherMatchFilter, setOtherMatchFilter] = useState<OtherMatchFilter>("all");
  const [pinnedMatches, setPinnedMatches] = useState<Set<string>>(new Set());
  const [pinnedMatchInfo, setPinnedMatchInfo] = useState<Map<string, PinnedMatchInfo>>(new Map());
  const [minOddsSum, setMinOddsSum] = useState("1.84");
  const [refreshInterval, setRefreshInterval] = useState(10);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<number>(0);
  const [matchDate, setMatchDate] = useState("");
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertConfigs, setAlertConfigs] = useState<Map<string, AlertConfig>>(new Map());
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
  const oddsRefreshQueueRef = useRef<ReturnType<typeof createOddsRefreshQueue> | null>(null);
  const oddsCoordinatorRef = useRef<ReturnType<typeof createOddsFetchCoordinator> | null>(null);
  const oddsRefreshCoreRef = useRef<(matchId: string, generation: number, signal?: AbortSignal) => Promise<boolean>>(async () => false);
  const detailedScheduleRef = useRef<() => void>(() => {});
  const [oddsQueueStatus, setOddsQueueStatus] = useState({ queued: 0, inFlight: 0, lastSuccessAt: 0 });
  const [oddsStatusNow, setOddsStatusNow] = useState(Date.now());
  useEffect(() => {
    dbCompanyOddsMapRef.current = dbCompanyOddsMap;
  }, [dbCompanyOddsMap]);

  const oddsSourceSerializationRef = useRef(createSerializedExecutor());
  const runSerializedOddsSourceTask = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    return oddsSourceSerializationRef.current(task);
  }, []);

  if (!oddsRefreshQueueRef.current) {
    oddsRefreshQueueRef.current = createOddsRefreshQueue({
      run: (matchId, generation) => runSerializedOddsSourceTask(() => oddsRefreshCoreRef.current(matchId, generation)),
      onStatus: setOddsQueueStatus,
    });
  }

  const enqueueOddsRefresh = useCallback((matchId: string, priority = 0): Promise<boolean> => {
    return oddsRefreshQueueRef.current!.enqueue(matchId, priority, oddsGenerationRef.current);
  }, []);

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
  const scheduleLoadControllerRef = useRef<ReturnType<typeof createLatestScheduleLoadController<ScheduleAggregate>> | null>(null);
  const databaseLoadControllerRef = useRef(createGenerationDatabaseLoadController());
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
  // Server-side automation status is owned by useAutomationStatus below.
  // All leagues ever seen (for the picker UI) - union of DB whitelist + schedule leagues
  const [allKnownLeagues, setAllKnownLeagues] = useState<string[]>([]);

  // Report state
  const [activeTab, setActiveTab] = useState<"odds" | "data" | "comparison" | "report">("odds");
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [reportDates, setReportDates] = useState<string[]>([]);
  const [selectedReportDate, setSelectedReportDate] = useState("");
  const [reportTrend, setReportTrend] = useState<Array<{ date: string; total: number; correct: number; accuracy: number; totalCorrect: number; totalAccuracy: string }>>([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportExpandedCompanies, setReportExpandedCompanies] = useState<Set<string>>(new Set());
  const [reportExpandedCrown, setReportExpandedCrown] = useState<Set<string>>(new Set());

  const alertsEndRef = useRef<HTMLDivElement>(null);
  const alertConfigsRef = useRef(alertConfigs);
  const oddsSnapshotsRef = useRef(oddsSnapshots);
  const alertObservationKeysRef = useRef(new Set<string>());
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

  const { actions: workstationActions } = useOddsWorkstation<PinnedMatchInfo, MatchNotes, AlertConfig>({
    settings: {
      pinnedMatches,
      pinnedMatchInfo,
      notes,
      setPinnedMatches,
      setPinnedMatchInfo,
      setNotes,
      alertConfigs,
      setAlertConfigs,
      soundEnabled,
      setSoundEnabled,
      refreshInterval,
      setRefreshInterval,
    },
  });

  // --- Load pasted JSON from server on mount ---
  useEffect(() => {
    // Load prediction JSON from server
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    setSelectedPredDate(today);
    workstationActions.fetchPredictions(today)
      .then((content) => setSavedJson(content))
      .catch(() => {});
    workstationActions.fetchPredictionDates()
      .then(setPredictionDates)
      .catch(() => {});

    // Load user focused leagues whitelist from DB with the established default fallback.
    fetchFocusedLeagues(fetch, [...DEFAULT_FOCUSED_LEAGUES])
      .then((items) => setUserFocusedLeagues(new Set(items)));
  }, [workstationActions]);
  const loadPredictionByDate = useCallback(async (dateKey: string) => {
    if (!dateKey || dateKey.length !== 8) return;
    try {
      setSavedJson(await workstationActions.fetchPredictions(dateKey));
    } catch {
      // ignore
    }
  }, [workstationActions]);

  // --- Save prediction JSON to server (only on explicit user action, not auto-load) ---
  const savePredictionToServer = useCallback(async (data: string, dateKey: string) => {
    try {
      await workstationActions.savePredictions(dateKey, data);
      setPredictionDates(await workstationActions.fetchPredictionDates());
    } catch {
      // ignore
    }
  }, [workstationActions]);

  // --- Fetch URL and extract JSON ---
  const fetchUrlAndExtract = useCallback(async () => {
    if (!fetchUrlInput.trim()) return;
    setFetchLoading(true);
    setFetchError("");
    try {
      const result = await workstationActions.fetchRemoteText(fetchUrlInput.trim());
      if (result.detectedDate && !selectedPredDate) {
        setSelectedPredDate(result.detectedDate);
      }
      if (result.extractedJson) {
        setPastedJson(result.extractedJson);
      } else {
        if (result.error) {
          setFetchError(result.error);
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
  }, [fetchUrlInput, selectedPredDate, workstationActions]);

  // --- Check alerts (uses refs to avoid dependency cycles) ---
  const checkAlerts = useCallback((newMatches: MatchData[]) => {
    const newAlerts = createOddsAlerts({
      configs: alertConfigsRef.current,
      snapshots: oddsSnapshotsRef.current,
      matches: newMatches,
      now: Date.now(),
      seen: alertObservationKeysRef.current,
    });
    if (newAlerts.length === 0) return;
    setAlerts((previous) => [...previous, ...newAlerts]);
    if (soundEnabledRef.current) playAlertSound();
  }, []);

  // --- Fetch data ---
  const loadOddsSnapshot = useCallback(async () => {
    const res = await fetch("/api/odds");
    const json = await res.json();
    if (!json.success) {
      throw new Error(json.error || "获取数据失败");
    }
    return {
      matches: (json.data.matches || []) as MatchData[],
      leagues: (json.data.leagues || []) as LeagueData[],
      hotMatchCount: json.data.hotMatchCount || 0,
      matchDate: json.data.matchDate || "",
    };
  }, []);

  const applyOddsSnapshot = useCallback((snapshot: {
    matches: MatchData[];
    leagues: LeagueData[];
    hotMatchCount: number;
    matchDate: string;
  }) => {
    const newMatches = snapshot.matches;
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
    setLeagues(snapshot.leagues);
    setHotMatchCount(snapshot.hotMatchCount);
    setMatchDate(snapshot.matchDate);
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
  }, [checkAlerts]);

  // --- Auto refresh ---
  const handleRefreshError = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : "网络错误");
  }, []);
  const handleRefreshStart = useCallback(() => {
    setLoading(true);
    setError("");
  }, []);
  const handleRefreshSettled = useCallback(() => setLoading(false), []);
  const { refresh: refreshOdds } = useOddsRefresh({
    load: loadOddsSnapshot,
    onData: applyOddsSnapshot,
    onError: handleRefreshError,
    onStart: handleRefreshStart,
    onSettled: handleRefreshSettled,
    intervalMs: refreshInterval * 1000,
  });

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
  const autoFetchAbortRef = useRef<AbortController | null>(null);
  const automaticOddsLifecycleRef = useRef<ReturnType<typeof createAutomaticOddsFetchLifecycle> | null>(null);
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
      const prediction = await workstationActions.fetchAnalysisDetail(date, matchId);
      if (prediction) {
        setAnalysisResults(prev => {
          const next = new Map(prev);
          next.set(matchId, prediction);
          return next;
        });
      }
    } catch {
      // Non-critical
    }
  }, [analysisResults, workstationActions]);
  // Chat state
  const [chatOpen, setChatOpen] = useState<string | null>(null); // matchId of open chat
  const [chatMessages, setChatMessages] = useState<Map<string, AnalysisChatMessage[]>>(new Map());
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);
  // Evolution stats
  const [evolutionStats, setEvolutionStats] = useState<{ totalPredictions: number; correctPredictions: number; overallAccuracy: string; topPatterns: { key: string; description: string; hitRate: string; total: number }[] } | null>(null);

  // --- Get current effective date for DB queries (YYYYMMDD format) ---
  const currentDbDate = useMemo(() => {
    if (dataScheduleMode === "today") {
      if (!matchDate) return "";
      return normalizeMatchDateKey(matchDate);
    }
    if (dataDate) return dataDate.replace(/-/g, "");
    return "";
  }, [dataScheduleMode, matchDate, dataDate]);
  useEffect(() => { currentDbDateRef.current = currentDbDate; }, [currentDbDate]);

  const verificationDateKeys = useMemo(() => {
    const keys = new Set<string>();
    if (currentDbDate) keys.add(currentDbDate);
    for (const match of dataTabMatches) {
      const dateKey = normalizeMatchDateKey(match.matchDate);
      if (dateKey) keys.add(dateKey);
    }
    if (keys.size === 0) keys.add(previousBeijingDateKey());
    return Array.from(keys).sort();
  }, [currentDbDate, dataTabMatches]);

  useEffect(() => {
    oddsGenerationRef.current += 1;
    databaseLoadControllerRef.current.beginGeneration();
    oddsCoordinatorRef.current?.setGeneration(oddsGenerationRef.current);
    oddsRefreshQueueRef.current?.clear();
    latestOddsRequestRef.current = new Map();
    oddsSourceMetaRef.current = new Map();
    matchRefreshVersionRef.current = new Map();
    matchPersistedVersionRef.current = new Map();
    dbCompanyOddsMapRef.current = new Map();
    setDbCompanyOddsMap(new Map());
    setFetchedMatches(new Set());
    setOddsQueueStatus(previous => ({ ...previous, queued: 0 }));
  }, [dataScheduleMode, currentDbDate]);

  // --- Generation-scoped DB readiness ---
  // Automated tasks may run only after odds and predictions both settle in the
  // active schedule generation. Older completions cannot satisfy this gate.
  const isDbLoadReady = useCallback((date: string) => databaseLoadControllerRef.current.isReady(date), []);

  // --- Load odds from DB for a given date ---
  const applyDatabaseOdds = useCallback((results: Awaited<ReturnType<typeof fetchDatabaseOddsRange>>, requestStartVersion: number, loadGeneration: number) => {
    if (loadGeneration !== oddsGenerationRef.current) return;
    const merged = projectDatabaseOddsApplication({
      results,
      currentMetadata: oddsSourceMetaRef.current,
      requestStartVersion,
      refreshVersions: matchRefreshVersionRef.current,
      persistedVersions: matchPersistedVersionRef.current,
    });
    setDbCompanyOddsMap(previous => {
      const next = new Map(previous);
      for (const [matchId, oddsData] of merged.odds) {
        next.set(matchId, oddsData);
        oddsSourceMetaRef.current.set(matchId, merged.metadata.get(matchId) || { source: null, sourceObservedAt: null });
      }
      dbCompanyOddsMapRef.current = next;
      return next;
    });
    setFetchedMatches(previous => new Set([...previous, ...merged.fetched]));
    const mergeSnapshots = (previous: Map<string, CrownStoredOdds>, values: Map<string, CrownStoredOdds>) => {
      const next = new Map(previous);
      for (const [matchId, value] of values) next.set(matchId, value);
      return next;
    };
    if (merged.crownLive.size) setCrownLiveOddsFromDb(previous => mergeSnapshots(previous, merged.crownLive));
    if (merged.crownOpen.size) setCrown12OddsFromDb(previous => mergeSnapshots(previous, merged.crownOpen));
    merged.readyDates.forEach(date => databaseLoadControllerRef.current.markOddsReady(date, loadGeneration));
  }, []);

  const loadOddsFromDb = useCallback(async (date: string) => {
    if (!date) return;
    const requestStartVersion = oddsRefreshSequenceRef.current;
    const loadGeneration = oddsGenerationRef.current;
    try {
      const result = await fetchDatabaseOddsDate(fetch, date);
      if (result) applyDatabaseOdds([result], requestStartVersion, loadGeneration);
    } catch (error) {
      console.error("[DataTab] Load from DB error:", error);
    }
  }, [applyDatabaseOdds]);

  // Load existing AI predictions from DB for a date
  const loadPredictionsFromDb = useCallback(async (date: string) => {
    if (!date) return;
    const generation = databaseLoadControllerRef.current.currentGeneration();
    await databaseLoadControllerRef.current.loadPredictions(
      date,
      generation,
      () => fetchAnalysisList(fetch, date),
      predictions => {
        const newMap = new Map<string, AnalysisResultData>(Object.entries(predictions));
        console.log(`[loadPredictionsFromDb] date=${date}, loaded ${newMap.size} predictions from DB`);
        if (newMap.size === 0) return;
        setAnalysisResults(previous => {
          const next = new Map(previous);
          for (const [matchId, prediction] of newMap) next.set(matchId, prediction);
          analysisResultsRef.current = next;
          return next;
        });
      },
    );
  }, []);

  // --- League selection persistence ---
  const prevSelectedLeaguesRef = useRef<Set<string>>(new Set());

  const leagueSelectionSaverRef = useRef(createDebouncedLeagueSelectionSaver(fetch));

  // --- Load league selections from DB ---
  const leagueLoadingFromDbRef = useRef(false);
  const loadLeagueSelections = useCallback(async (dateKey: string, mode: string) => {
    if (!dateKey) return;
    leagueLoadingFromDbRef.current = true;
    const loadedSet = await fetchLeagueSelections(fetch, dateKey, mode);
    setDataSelectedLeagues(loadedSet);
    prevSelectedLeaguesRef.current = loadedSet;
    setTimeout(() => { leagueLoadingFromDbRef.current = false; }, 100);
  }, []);

  useEffect(() => () => leagueSelectionSaverRef.current.dispose(), []);
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
      const leagueArr = await persistFocusedLeagues(fetch, focusedLeagueEditing);
      setUserFocusedLeagues(new Set(leagueArr));
      setFocusedLeagueDialogOpen(false);
      if (activeTab === "report" && selectedReportDate) {
        fetchReport(fetch, selectedReportDate).then(data => setReportData(data as unknown as ReportData)).catch(() => {});
      }
    } catch { /* ignore */ }
    setFocusedLeagueSaving(false);
  }, [focusedLeagueEditing, activeTab, selectedReportDate]);

  // Feishu settings functions
  const loadFeishuSettings = useCallback(async () => {
    try {
      setFeishuWebhookUrl(await workstationActions.loadFeishuWebhook());
    } catch { /* ignore */ }
  }, [workstationActions]);
  const saveFeishuSettings = useCallback(async () => {
    setFeishuSaving(true);
    try {
      await workstationActions.saveFeishuWebhook(feishuWebhookUrl);
      setFeishuDialogOpen(false);
    } catch { /* ignore */ }
    setFeishuSaving(false);
  }, [feishuWebhookUrl, workstationActions]);

  const testFeishuNotification = useCallback(async () => {
    setFeishuTesting(true);
    setFeishuTestResult(null);
    try {
      const result = await workstationActions.testFeishuWebhook();
      setFeishuTestResult(result.success ? "✅ 发送成功！" : `❌ 发送失败: ${result.error || "未知错误"}`);
    } catch (err) {
      setFeishuTestResult(`❌ 请求失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
    setFeishuTesting(false);
  }, [workstationActions]);

  // Load feishu settings on mount
  useEffect(() => { loadFeishuSettings(); }, [loadFeishuSettings]);

  const saveLeagueSelections = useCallback((leagues: Set<string>, dateKey: string, mode: string) => {
    leagueSelectionSaverRef.current.schedule(leagues, dateKey, mode);
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

  // Batch load DB data for a date range with a shared decoder and freshness projection.
  const loadOddsFromDbRange = useCallback(async (startDate: string, endDate: string) => {
    const requestStartVersion = oddsRefreshSequenceRef.current;
    const loadGeneration = oddsGenerationRef.current;
    const results = await fetchDatabaseOddsRange(fetch, startDate, endDate);
    applyDatabaseOdds(results, requestStartVersion, loadGeneration);
  }, [applyDatabaseOdds]);

  // Fetch one match through the shared coordinator. It owns request identity and
  // checks request/generation freshness before every UI write and persistence.
  if (!oddsCoordinatorRef.current) {
    oddsCoordinatorRef.current = createOddsFetchCoordinator({
      fetchMatch: async (matchId, signal) => {
        const result = await fetchMatchOddsSource(fetch, matchId, dbCompanyOddsMapRef.current.get(matchId), signal);
        return {
          data: result.data as MatchOddsData & Record<string, unknown>,
          source: result.source,
          sourceObservedAt: result.sourceObservedAt,
          score: result.score,
        } as OddsFetchSourceResult & { score: MatchDetailScore | null };
      },
      persistMatch: (request, signal) => persistMatchOdds(fetch, {
        ...request,
        oddsData: request.oddsData as unknown as MatchOddsData,
      }, signal),
      onRequestStart: (matchId, requestVersion) => {
        latestOddsRequestRef.current.set(matchId, requestVersion);
        matchRefreshVersionRef.current.set(matchId, requestVersion);
      },
      onApplyMatch: (raw, requestVersion) => {
        const result = raw as OddsFetchSourceResult & { score?: MatchDetailScore | null };
        if (result.score) {
          setMatches(previous => applyMatchDetailScore(previous, result.score || null));
          setScheduleMatches(previous => applyMatchDetailScore(previous, result.score || null));
        }
        const entry = result.data as unknown as MatchOddsData;
        oddsSourceMetaRef.current.set(entry.matchId, { source: result.source, sourceObservedAt: result.sourceObservedAt });
        setDbCompanyOddsMap(() => {
          const next = new Map(dbCompanyOddsMapRef.current);
          next.set(entry.matchId, entry);
          dbCompanyOddsMapRef.current = next;
          return next;
        });
        setFetchedMatches(previous => new Set(previous).add(entry.matchId));
        setFailedMatches(previous => {
          const next = new Map(previous);
          next.delete(entry.matchId);
          return next;
        });
        latestOddsRequestRef.current.set(entry.matchId, requestVersion);
      },
      onPersistedMatch: (matchId, requestVersion, saved, request) => {
        matchPersistedVersionRef.current.set(matchId, requestVersion);
        oddsSourceMetaRef.current.set(matchId, {
          source: request.source,
          sourceObservedAt: saved.sourceObservedAt || request.sourceObservedAt,
          writeToken: request.writeToken,
        });
      },
      onFailure: (matchId, message) => {
        setFailedMatches(previous => new Map(previous).set(matchId, message));
      },
    });
  }

  const fetchSingleMatchOddsCore = useCallback(async (
    matchId: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    setFetchingMatches(previous => new Set(previous).add(matchId));
    try {
      const matchData = matchesRef.current.find(match => match.id === matchId);
      let matchDateForSave = matchData?.matchDate || currentDbDateRef.current;
      const cnMatch = matchDateForSave?.match(/(\d{1,2})月(\d{1,2})日/);
      if (cnMatch) {
        const now = new Date();
        matchDateForSave = `${now.getFullYear()}${cnMatch[1].padStart(2, "0")}${cnMatch[2].padStart(2, "0")}`;
      }
      if (!matchDateForSave) return false;
      oddsCoordinatorRef.current!.setGeneration(oddsGenerationRef.current);
      return await oddsCoordinatorRef.current!.fetchMatch(matchId, generation, {
        matchDate: matchDateForSave,
        companyIds: dataCompanyIds,
      }, signal);
    } finally {
      setFetchingMatches(previous => {
        const next = new Set(previous);
        next.delete(matchId);
        return next;
      });
    }
  }, [dataCompanyIds]);
  oddsRefreshCoreRef.current = fetchSingleMatchOddsCore;

  const fetchSingleMatchOdds = useCallback((matchId: string, signal?: AbortSignal) => {
    if (signal) return runSerializedOddsSourceTask(() => fetchSingleMatchOddsCore(matchId, oddsGenerationRef.current, signal));
    const priority = pinnedMatchesRef.current.has(matchId) || expandedCrown.has(matchId) || expandedCompanies.has(matchId) ? 100 : 10;
    return enqueueOddsRefresh(matchId, priority);
  }, [enqueueOddsRefresh, expandedCrown, expandedCompanies, fetchSingleMatchOddsCore, runSerializedOddsSourceTask]);
  const fetchSingleMatchOddsRef = useRef(fetchSingleMatchOdds);
  fetchSingleMatchOddsRef.current = fetchSingleMatchOdds;

  // Refresh missing counts for supplement fetch dropdown (must be before fetchAllVisibleOdds)
  const refreshMissingCounts = useCallback(() => {
    setMissingCounts(countSupplementalTargets({
      matches: dataTabMatches,
      selectedLeagues: dataSelectedLeagues,
      scheduleMode: dataScheduleMode,
      fetchedMatchIds: fetchedMatches,
      oddsByMatch: dbCompanyOddsMap,
      crownOpenByMatch: crown12OddsFromDb,
    }));
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
  const filteredReportData = useMemo(
    () => filterReportByLeagues(reportData, userFocusedLeagues) as ReportData | null,
    [reportData, userFocusedLeagues],
  );

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
    // Sort both groups by status priority, original website order (orderIndex)
    notStarted.sort((a, b) => a.match.orderIndex - b.match.orderIndex);
    otherStates.sort((a, b) => {
      const aKind = getMatchStatus(a.match.state).kind;
      const bKind = getMatchStatus(b.match.state).kind;
      const aPriority = aKind === "scheduled" ? 99 : OTHER_MATCH_STATUS_PRIORITY[aKind];
      const bPriority = bKind === "scheduled" ? 99 : OTHER_MATCH_STATUS_PRIORITY[bKind];
      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.match.orderIndex - b.match.orderIndex;
    });
    return { notStarted, otherStates };
  }, [dataTabMatches, dataSelectedLeagues, fetchedMatches, fetchingMatches, dbCompanyOddsMap, crownLiveOddsFromDb, crown12OddsFromDb, dataCompanyIds]);

  // --- Batch AI analysis for all visible matches ---
  const [batchAIProgress, setBatchAIProgress] = useState({ current: 0, total: 0, matchName: "", succeeded: 0, failed: 0 });
  const batchAIControllerRef = useRef<AnalysisBatchController | null>(null);

  // Ref to track analysis results without causing re-creation of callbacks
  const analysisResultsRef = useRef(analysisResults);
  useEffect(() => { analysisResultsRef.current = analysisResults; }, [analysisResults]);

  // Internal analyze without setState - returns null only when an existing result is skipped
  const analyzeSingleMatchCore = useCallback(async (matchId: string, forceReanalyze = false): Promise<AnalysisResultData | null> => {
    if (!forceReanalyze && analysisResultsRef.current.has(matchId)) return null;
    const match = dataTabMatches.find(item => item.id === matchId) || matches.find(item => item.id === matchId);
    if (!match) throw new Error("找不到该赛事");
    const request = await prepareAnalysisRequest({
      match,
      matchDate: currentDbDate,
      scheduleMode: dataScheduleMode,
      memoryOdds: dbCompanyOddsMapRef.current.get(matchId),
      crownOpen: crown12OddsFromDb.get(matchId),
      loadDatabaseCompanies: async () => {
        const result = await fetchDatabaseOddsDate(fetch, currentDbDate);
        const companies = result?.oddsMap[matchId]?.companies;
        return Array.isArray(companies) ? companies as unknown as Record<string, unknown>[] : [];
      },
      refreshLiveOdds: async () => {
        await fetchSingleMatchOddsRef.current(matchId);
        return dbCompanyOddsMapRef.current.get(matchId);
      },
      onFallbackError: error => console.warn("[AIAnalysis] Live odds fallback failed:", error),
    });
    return requestAnalysis(fetch, request);
  }, [dataTabMatches, matches, crown12OddsFromDb, currentDbDate, dataScheduleMode]);

  const analyzeSingleMatch = useCallback(async (matchId: string, forceReanalyze = false) => {
    if (analyzingMatchId) return;
    const match = dataTabMatches.find(item => item.id === matchId) || matches.find(item => item.id === matchId);
    let toastId: string | number;
    await runAnalysisCommand({
      matchId,
      forceReanalyze,
      start: id => {
        toastId = toast.loading("AI 正在分析赛事", {
          description: match ? `${match.homeTeam} vs ${match.awayTeam}` : "正在准备赔率与赛事数据",
        });
        setAnalyzingMatchId(id);
      },
      analyze: analyzeSingleMatchCore,
      apply: (id, result) => setAnalysisResults(previous => {
        const next = new Map(previous).set(id, result);
        analysisResultsRef.current = next;
        return next;
      }),
      expand: setAnalysisExpanded,
      skipped: () => toast.info("已有最新分析结果", { id: toastId, description: "无需重复分析" }),
      success: result => {
        const strategyText = String((result as { llmPrediction?: { strategy?: string }; strategy?: string }).llmPrediction?.strategy || (result as { strategy?: string }).strategy || "");
        if (strategyText.includes("规则引擎兜底") || strategyText.includes("LLM调用失败")) {
          toast.warning("规则引擎已出结果（LLM 超时/失败，可重试）", {
            id: toastId,
            description: `${result.homeTeam} vs ${result.awayTeam} · ${formatAnalysisTime(result.analyzedAt)}`,
            duration: 8000,
          });
        } else {
          toast.success("AI 分析完成", {
            id: toastId,
            description: `${result.homeTeam} vs ${result.awayTeam} · ${formatAnalysisTime(result.analyzedAt)}`,
          });
        }
      },
      error: error => {
        const message = error instanceof Error ? error.message : "AI分析失败";
        toast.error("AI 分析失败", { id: toastId, description: `${message}。可稍后重新点击 AI 分析。`, duration: 8000 });
      },
      settle: () => setAnalyzingMatchId(null),
    });
  }, [analyzeSingleMatchCore, analyzingMatchId, dataTabMatches, matches]);

  const batchAnalyzeAll = useCallback(async (matchList: { id: string; homeTeam: string; awayTeam: string }[], forceReanalyze = false) => {
    if (matchList.length === 0) return;
    const controller = createBatchAnalysisController();
    batchAIControllerRef.current = controller;
    const batchToastId = toast.loading("批量 AI 分析进行中", {
      description: `0/${matchList.length} · 正在准备赛事数据`,
    });
    setBatchAIProgress({ current: 0, total: matchList.length, matchName: `${matchList[0].homeTeam} vs ${matchList[0].awayTeam}`, succeeded: 0, failed: 0 });

    const summary = await runAnalysisBatch({
      items: matchList,
      concurrency: aiConcurrency,
      controller,
      analyze: item => analyzeSingleMatchCore(item.id, forceReanalyze),
      onResults: results => {
        setAnalysisResults(prev => {
          const next = new Map(prev);
          results.forEach((value, key) => next.set(key, value));
          analysisResultsRef.current = next;
          return next;
        });
      },
      onProgress: progress => {
        setBatchAIProgress(progress);
        if (progress.current > 0) {
          toast.loading("批量 AI 分析进行中", {
            id: batchToastId,
            description: `${progress.current}/${progress.total} · 成功 ${progress.succeeded} · 失败 ${progress.failed}`,
          });
        }
      },
      onError: (item, error) => console.error(`[AIAnalysis] ${item.homeTeam} vs ${item.awayTeam}:`, error),
    });

    if (summary.cancelled) {
      toast.info("已停止批量 AI 分析", { id: batchToastId, description: `已处理 ${summary.completed}/${matchList.length} · 成功 ${summary.succeeded} · 失败 ${summary.failed}` });
    } else if (summary.failed === 0) {
      toast.success("批量 AI 分析完成", { id: batchToastId, description: `已成功分析 ${summary.succeeded} 场赛事` });
    } else if (summary.succeeded > 0) {
      toast.warning("批量 AI 分析部分完成", { id: batchToastId, description: `成功 ${summary.succeeded} · 失败 ${summary.failed}，失败赛事可稍后重试`, duration: 8000 });
    } else {
      toast.error("批量 AI 分析失败", { id: batchToastId, description: `${summary.failed} 场赛事均未完成，请检查分析服务后重试`, duration: 8000 });
    }
    if (batchAIControllerRef.current === controller) batchAIControllerRef.current = null;
    setBatchAIProgress({ current: 0, total: 0, matchName: "", succeeded: 0, failed: 0 });
  }, [analyzeSingleMatchCore, aiConcurrency]);

  const stopBatchAI = useCallback(() => {
    batchAIControllerRef.current?.cancel();
  }, []);

  // --- Manual verification of prediction correctness ---
  const manualVerify = useCallback(async (matchId: string, market: PredictionMarket, isCorrect: boolean | null) => {
    const result = analysisResults.get(matchId);
    const matchDate = result?.matchDate || currentDbDate;
    const marketLabel = market === "handicap" ? "让球" : "进球";
    setVerifyingMarketKey(`${matchId}:${market}`);
    try {
      const data = await requestManualVerification(fetch, { matchId, matchDate, market, isCorrect });

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
    const newMessages = appendUserMessage(currentMessages, message);
    setChatMessages(prev => new Map(prev).set(matchId, newMessages));
    setChatInput("");
    setChatStreaming(true);

    // Build analysis context from results
    const result = analysisResults.get(matchId);
    const analysisContext = result
      ? `水位预测: ${result.waterDirection} / 方向: ${result.prediction} / 置信度: ${result.confidenceLevel} / 策略: ${result.strategy}\n指标: ${result.indicators.map(i => `${i.name}=${i.signal}(${i.reasoning})`).join(", ")}\n推理: ${result.reasoning}`
      : undefined;

    try {
      setChatMessages(prev => new Map(prev).set(matchId, appendAssistantMessage(prev.get(matchId) || [], "")));
      await requestAnalysisChat(fetch, {
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
      }, content => {
        setChatMessages(prev => new Map(prev).set(
          matchId,
          appendAssistantMessage(prev.get(matchId) || [], content, true),
        ));
      });
    } catch (error) {
      const message = error instanceof Error && error.message === "连接失败" ? "连接失败" : "请求失败";
      setChatMessages(prev => new Map(prev).set(
        matchId,
        appendAssistantMessage(prev.get(matchId) || [], message, true),
      ));
    } finally {
      setChatStreaming(false);
    }
  }, [chatStreaming, chatMessages, dataTabMatches, matches, analysisResults, loadAnalysisDetail, dbCompanyOddsMap]);

  // --- Load evolution stats ---
  const loadEvolutionStats = useCallback(async () => {
    try {
      const stats = await fetchEvolutionStats(fetch);
      if (stats) setEvolutionStats(stats);
    } catch {
      // silently fail
    }
  }, []);

  const verifyAndLearn = useCallback(async () => {
    try {
      const summary = await runVerificationLearning({
        dateKeys: verificationDateKeys,
        syncScores: syncHistoricalScores,
        verify: dateKey => requestVerification(fetch, dateKey),
        reloadPredictions: loadPredictionsFromDb,
        learn: market => requestLearning(fetch, market),
        refreshStats: loadEvolutionStats,
      });
      toast.success("验证与学习完成", { description: `日期 ${verificationDateKeys.join(", ")} · 同步赛果 ${summary.synced} 场 · 验证 ${summary.verified} 场 · 命中 ${summary.correct} 场 · 新增 ${summary.learnedPatterns} 个模式` });
    } catch (err) {
      toast.error("验证学习失败", { description: err instanceof Error ? err.message : "网络请求失败", duration: 8000 });
    }
  }, [loadEvolutionStats, loadPredictionsFromDb, verificationDateKeys]);

  // Load evolution stats on mount
  useEffect(() => {
    loadEvolutionStats();
  }, [loadEvolutionStats]);

  // Batch fetch for visible matches, serialized to protect the Titan source IP.
  const fetchAllVisibleOdds = useCallback(async (matchIds?: string[]) => {
    setDataLoading(true);
    const controller = new AbortController();
    autoFetchAbortRef.current?.abort();
    autoFetchAbortRef.current = controller;
    try {
      const targetMatches = matchIds
        ? dataTabMatches.filter(m => matchIds.includes(m.id))
        : dataTabMatches.filter(m => {
          if (dataSelectedLeagues.size > 0 && !isLeagueSelected(m.league, dataSelectedLeagues)) return false;
          if (dataScheduleMode !== "history" && m.state !== "0") return false;
          return true;
        });

      if (targetMatches.length === 0) return;
      console.log(`[BatchFetch] Refreshing latest odds: ${targetMatches.length} matches, concurrency=1`);
      await runOddsFetchBatch({
        matchIds: targetMatches.map(match => match.id),
        signal: controller.signal,
        phase: "刷新最新赔率",
        delayMs: 100,
        fetchOne: fetchSingleMatchOdds,
        onProgress: setBatchProgress,
      });
      if (!controller.signal.aborted) {
        setScheduleError("");
        refreshMissingCounts();
      }
    } catch (err) {
      console.error("[DataTab] Fetch all odds error:", err);
    } finally {
      if (autoFetchAbortRef.current === controller) {
        autoFetchAbortRef.current = null;
        setDataLoading(false);
        setBatchProgress(null);
      }
    }
  }, [dataTabMatches, dataSelectedLeagues, dataScheduleMode, fetchSingleMatchOdds, refreshMissingCounts]);

  // Supplement fetch: fetch specific missing data types for already-fetched matches
  const supplementFetch = useCallback(async (type: SupplementalFetchType) => {
    setDataLoading(true);
    const controller = new AbortController();
    autoFetchAbortRef.current?.abort();
    autoFetchAbortRef.current = controller;
    try {
      const toFetch = selectSupplementalTargets({
        type, matches: dataTabMatches, selectedLeagues: dataSelectedLeagues, scheduleMode: dataScheduleMode,
        fetchedMatchIds: fetchedMatches, oddsByMatch: dbCompanyOddsMap, crownOpenByMatch: crown12OddsFromDb,
      });

      if (toFetch.length === 0) {
        setDataLoading(false);
        refreshMissingCounts();
        return;
      }

      const phaseLabel = type === "opentimes" ? "开盘时间" : type === "crownOpen" ? "新数据" : type === "crownFinal" ? "终盘" : type === "revalidate" ? "数据校验" : "赔率";
      console.log(`[SupplementFetch] Starting: ${toFetch.length} matches, type=${type}`);
      setBatchProgress({ done: 0, total: toFetch.length, phase: phaseLabel });

      await runSupplementalBatch({
        type,
        targets: toFetch,
        signal: controller.signal,
        fetchMatch: fetchSingleMatchOdds,
        updateSupplement: async (match, signal) => {
          const supplementGeneration = oddsGenerationRef.current;
          const cod = dbCompanyOddsMapRef.current.get(match.id);
          const codCompanies = Array.isArray(cod?.companies) ? cod.companies : [];
          const companyIds = codCompanies.length > 0 ? codCompanies.map(company => company.companyId) : dataCompanyIds;
          return runSerializedOddsSourceTask(() => runSupplementalOddsUpdate({
            match,
            currentDate: currentDbDate,
            companyIds,
            includeCrownOpen: type === "crownOpen",
            generation: supplementGeneration,
            currentGeneration: () => oddsGenerationRef.current,
            readOdds: matchId => dbCompanyOddsMapRef.current.get(matchId),
            fetch: request => fetchSupplementalOdds(fetch, request, signal),
            persist: request => persistSupplementalOdds(fetch, request, signal),
          }));
        },
        apply: outcome => {
          if (outcome.odds) setDbCompanyOddsMap(() => {
            const next = new Map(dbCompanyOddsMapRef.current).set(outcome.matchId, outcome.odds!);
            dbCompanyOddsMapRef.current = next;
            return next;
          });
          if (outcome.crownOpen) setCrown12OddsFromDb(previous => new Map(previous).set(outcome.matchId, outcome.crownOpen!));
          if (outcome.crownFinal) setCrownLiveOddsFromDb(previous => new Map(previous).set(outcome.matchId, outcome.crownFinal!));
        },
        progress: done => setBatchProgress({ done, total: toFetch.length, phase: phaseLabel }),
      });
      // Refresh counts after completion
      refreshMissingCounts();
    } catch (err) {
      console.error("[SupplementFetch] Error:", err);
    } finally {
      if (autoFetchAbortRef.current === controller) {
        autoFetchAbortRef.current = null;
        setDataLoading(false);
        setBatchProgress(null);
      }
    }
  }, [dataTabMatches, dataSelectedLeagues, dataScheduleMode, fetchedMatches, dbCompanyOddsMap, crown12OddsFromDb, dataCompanyIds, fetchSingleMatchOdds, currentDbDate, refreshMissingCounts, runSerializedOddsSourceTask]);

  // Abort all ongoing fetches
  const abortFetch = useCallback(() => {
    autoFetchAbortRef.current?.abort();
    automaticOddsLifecycleRef.current?.cancel();
    autoFetchAbortRef.current = null;
    oddsRefreshQueueRef.current?.clear();
    setAutoFetchRunning(false);
    setDataLoading(false);
    setBatchProgress(null);
    setScheduleError("");
  }, []);

  const [excelExporting, setExcelExporting] = useState(false);
  const excelExportingRef = useRef(false);

  // Export data to Excel. ExcelJS is loaded only after this client-side click path starts.
  const exportToExcel = useCallback(async () => {
    if (excelExportingRef.current) return;
    excelExportingRef.current = true;
    setExcelExporting(true);
    try {
    const companyOdds = new Map<string, CompanyOddsItem[]>();
    for (const [matchId, value] of dbCompanyOddsMap) companyOdds.set(matchId, Array.isArray(value.companies) ? value.companies : []);
    const companyIds = new Set(dataCompanyIds);
    const estimatedRows = countOddsExportRows({
      matches: dataTabMatches,
      selectedLeagues: dataSelectedLeagues,
      companyIds,
      companyOdds,
    });
    const decision = decideExcelExportRows(estimatedRows);
    if (!decision.allowed) throw new Error(decision.message);
    const rows = buildOddsExportRows({
      matches: dataTabMatches,
      selectedLeagues: dataSelectedLeagues,
      scheduleMode: dataScheduleMode,
      companyIds,
      companyOdds,
      crownOpenOdds: crown12OddsFromDb,
      crownFinalOdds: crownLiveOddsFromDb,
    });
    if (rows.length === 0) throw new Error("当前范围没有可导出的数据");
    const dateRange = dataDateEnd ? `${dataDate.replace(/-/g, "")}-${dataDateEnd.replace(/-/g, "")}` : (currentDbDate || "data");
    const document = buildExcelExportDocument(rows, dateRange);
    const { downloadExcelExport } = await import("@/features/odds/excel-export-client");
    await downloadExcelExport(document);
    } catch (error) {
      console.error("[ExcelExport] Error:", error);
      toast.error(error instanceof Error ? error.message : "Excel 导出失败，请重试");
    } finally {
      excelExportingRef.current = false;
      setExcelExporting(false);
    }
  }, [dataTabMatches, dataSelectedLeagues, dataScheduleMode, dbCompanyOddsMap, crownLiveOddsFromDb, crown12OddsFromDb, dataCompanyIds, dataDate, dataDateEnd, currentDbDate]);

  // Fetch schedule data; the feature layer owns decoding, aggregation and hot selection.
  const applyScheduleData = useCallback((data: { matches: MatchData[]; leagues: LeagueData[]; hotMatchCount?: number }) => {
    setScheduleMatches(data.matches);
    setScheduleLeagues(data.leagues);
    setScheduleHotMatchCount(data.hotMatchCount ?? countHotMatches(data));
  }, []);

  if (!scheduleLoadControllerRef.current) {
    scheduleLoadControllerRef.current = createLatestScheduleLoadController<ScheduleAggregate>({
      load: async (plan: ScheduleLoadPlan, signal, isLatest) => {
        const request = plan.schedule;
        if (!request) return { matches: [], leagues: [], hotMatchCount: 0 };
        if (request.mode === "history" && request.endDate) {
          const dates = dateKeysInRange(request.startDate, request.endDate);
          if (dates.length === 0) throw new Error("日期范围无效");
          return aggregateScheduleRange(
            dates,
            date => fetchSchedule(fetch, "history", date, signal),
            (loaded, total) => { if (isLatest()) setScheduleError(`加载中 ${loaded}/${total} 天...`); },
          );
        }
        const data = await fetchSchedule(fetch, request.mode, request.startDate, signal);
        return { ...data, hotMatchCount: countHotMatches(data) };
      },
      apply: data => {
        applyScheduleData(data);
        setScheduleError("");
      },
      onError: error => {
        console.error("[DataTab] Fetch schedule error:", error);
        setScheduleError(error instanceof Error ? error.message : "获取赛程数据失败");
        applyScheduleData({ matches: [], leagues: [] });
      },
      onStart: () => {
        setScheduleLoading(true);
        setScheduleError("");
      },
      onSettled: () => setScheduleLoading(false),
    });
  }

  useEffect(() => () => {
    scheduleLoadControllerRef.current?.dispose();
    scheduleLoadControllerRef.current = null;
  }, []);

  // Effect: consume the feature-owned mode/date plan while keeping state application route-local.
  useEffect(() => {
    const plan = createScheduleLoadPlan({
      mode: dataScheduleMode,
      currentDate: currentDbDate,
      date: dataDate,
      endDate: dataDateEnd,
    });
    if (plan.schedule) {
      scheduleLoadControllerRef.current?.run(plan);
    } else {
      scheduleLoadControllerRef.current?.cancel();
      setScheduleLoading(false);
    }

    if (dataScheduleMode === "today") {
      setScheduleMatches([]);
      setScheduleLeagues([]);
    } else if (plan.schedule) {
      dbCompanyOddsMapRef.current = new Map();
      setDbCompanyOddsMap(new Map());
      setFetchedMatches(new Set());
      setFailedMatches(new Map());
      setAnalysisResults(new Map());
      analysisResultsRef.current = new Map();
    }
    setAutoFetchTriggered("");

    if (plan.schedule?.endDate) {
      loadOddsFromDbRange(plan.schedule.startDate, plan.schedule.endDate);
    } else {
      plan.oddsDates.forEach(loadOddsFromDb);
    }
    plan.predictionDates.forEach(loadPredictionsFromDb);
    if (plan.leagueDate) loadLeagueSelections(plan.leagueDate, dataScheduleMode);

    return () => scheduleLoadControllerRef.current?.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataScheduleMode, dataDate, dataDateEnd, currentDbDate]);

  // --- Auto-fetch hot matches ---
  // After data is loaded and DB odds are checked, auto-fetch hot matches that haven't been saved
  // Use a ref to track fetchedMatches to avoid dependency cycle
  const fetchedMatchesRef = useRef(fetchedMatches);
  useEffect(() => { fetchedMatchesRef.current = fetchedMatches; }, [fetchedMatches]);

  const automaticFetchLatestRef = useRef<{
    fetchSingleMatchOdds: (matchId: string, signal?: AbortSignal) => Promise<boolean>;
  }>({
    fetchSingleMatchOdds: async () => false,
  });
  automaticFetchLatestRef.current.fetchSingleMatchOdds = fetchSingleMatchOdds;

  const autoFetchHotMatches = useCallback(async () => {
    if (autoFetchRunning) return;
    if (!automaticOddsLifecycleRef.current) {
      automaticOddsLifecycleRef.current = createAutomaticOddsFetchLifecycle({
        fetchMatch: (matchId, signal) => automaticFetchLatestRef.current.fetchSingleMatchOdds(matchId, signal),
      });
    }
    const key = `${dataScheduleMode}-${currentDbDate}${dataDateEnd ? "-" + dataDateEnd.replace(/-/g, "") : ""}`;
    setAutoFetchRunning(true);
    try {
      await automaticOddsLifecycleRef.current.run({
        key,
        dbReady: isDbLoadReady(currentDbDate),
        matches: dataTabMatches,
        selectedLeagues: dataSelectedLeagues,
        hotLeagues: new Set(hotLeagues.map(league => league.name)),
        fetchedMatchIds: fetchedMatchesRef.current,
        scheduleMode: dataScheduleMode,
      });
    } catch (err) {
      console.error("[AutoFetch] Error:", err);
    } finally {
      setAutoFetchRunning(false);
    }
  }, [autoFetchRunning, hotLeagues, dataTabMatches, dataScheduleMode, dataSelectedLeagues, currentDbDate, dataDateEnd, isDbLoadReady]);

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

  // The schedule-plan effect owns initial and mode/date DB loads.

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

    const newMatches = selectIncrementalOddsTargets({
      matches: dataTabMatches,
      previousLeagues: prevSelectedLeaguesRef.current,
      selectedLeagues: dataSelectedLeagues,
      fetchedMatchIds: fetchedMatchesRef.current,
      scheduleMode: dataScheduleMode,
    });
    prevSelectedLeaguesRef.current = new Set(dataSelectedLeagues);

    if (newMatches.length === 0) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setDataLoading(true);
      try {
        await runIncrementalOddsFetch({
          matches: newMatches,
          signal: controller.signal,
          fetchMatch: matchId => fetchSingleMatchOdds(matchId),
        });
      } catch (err) {
        console.error("[IncrementalFetch] Error:", err);
      } finally {
        if (!controller.signal.aborted) setDataLoading(false);
      }
    }, 800);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [dataSelectedLeagues, dataScheduleMode, autoFetchRunning, dataLoading, dataTabMatches, fetchSingleMatchOdds]);

  // --- Server automation status and manual compensation ---
  const handleAutomationCompleted = useCallback(async () => {
    if (currentDbDate) await loadOddsFromDb(currentDbDate);
  }, [currentDbDate, loadOddsFromDb]);
  const handleAutomationCompensated = useCallback(async () => {
    if (!currentDbDate) return;
    await Promise.all([
      loadOddsFromDb(currentDbDate),
      loadPredictionsFromDb(currentDbDate),
    ]);
  }, [currentDbDate, loadOddsFromDb, loadPredictionsFromDb]);
  const {
    tasks: automationTasks,
    compensating: automationCompensating,
    message: automationMessage,
    compensationAvailable: automationCompensationAvailable,
    compensate: compensateAutomation,
  } = useAutomationStatus({
    dateKey: currentDbDate,
    onCompleted: handleAutomationCompleted,
    onCompensated: handleAutomationCompensated,
  });

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
      setReportDates(await fetchReportDates(fetch));
    } catch (err) {
      toast.error("加载报表日期失败", { description: err instanceof Error ? err.message : "网络请求失败" });
    }
  }, []);

  const generateReport = async () => {
    await runReportCommand({
      generate: () => requestGeneratedReport(fetch, selectedPredDate),
      apply: report => {
        setReportData(report as unknown as ReportData);
        setSelectedReportDate(report.date);
      },
      refreshDates: loadReportDates,
      refreshTrend: loadReportTrend,
      start: () => setReportLoading(true),
      success: report => toast.success("AI报表生成成功", {
        description: `最后分析：${formatAnalysisTime(report.latestAnalysisAt as string | null | undefined)}`,
      }),
      error: error => toast.error("生成AI报表失败", { description: error instanceof Error ? error.message : "网络请求失败" }),
      settle: () => setReportLoading(false),
    });
  };

  const loadReport = async (date: string) => {
    if (!date) return;
    setReportLoading(true);
    try {
      setReportData(await fetchReport(fetch, date) as unknown as ReportData);
      setSelectedReportDate(date);
    } catch (err) {
      toast.error("加载AI报表失败", { description: err instanceof Error ? err.message : "网络请求失败" });
    } finally {
      setReportLoading(false);
    }
  };

  const loadReportTrend = useCallback(async () => {
    try {
      setReportTrend(await fetchReportTrend(fetch) as Array<{ date: string; total: number; correct: number; accuracy: number; totalCorrect: number; totalAccuracy: string }>);
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

  const filteredMatches = useMemo(() => projectScheduledMatches({
    matches,
    selectedLeagues,
    minimumOddsSum: minOddsSumVal,
    pinnedMatchIds: pinnedMatches,
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
        void enqueueOddsRefresh(match.id, priority);
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
  const otherMatchProjection = useMemo(() => projectOtherMatches({
    matches,
    selectedLeagues,
    pinnedMatchIds: pinnedMatches,
    filter: otherMatchFilter,
    statusKind: state => getMatchStatus(state).kind,
  }), [matches, selectedLeagues, pinnedMatches, otherMatchFilter]);
  const otherStateMatches = otherMatchProjection.all;
  const otherStateCounts = otherMatchProjection.counts;
  const visibleOtherStateMatches = otherMatchProjection.visible;

  const activeOtherMatchFilterLabel = OTHER_MATCH_FILTERS.find(filter => filter.key === otherMatchFilter)?.label ?? "全部";

  // --- Odds comparison summary (from all matches with notes) ---
  const oddsComparisonSummary = useMemo(() => buildOddsComparisonSummary({
    matches,
    notes,
    oddsBaseTotal,
  }), [matches, notes, oddsBaseTotal]);

  // --- Alert when odds comparison total exceeds threshold ---
  const prevTotalExcess = useRef(0);
  useEffect(() => {
    if (shouldPlayThresholdAlert(oddsComparisonSummary.totalDiff, oddsAlertThreshold, prevTotalExcess.current)) {
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
                    onClick={verifyAndLearn}
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
              <Button variant="outline" size="icon-sm" className="border-gray-700 text-gray-300 hover:bg-gray-800" onClick={refreshOdds} disabled={loading} aria-label="立即刷新赔率" title="立即刷新赔率">
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
                              <button
                                className={cn(
                                  "text-[11px] px-1 py-0 rounded font-medium cursor-pointer hover:opacity-80",
                                  predComp.action === "重注" ? "text-red-300 bg-red-900/40" :
                                  predComp.action === "轻注" ? "text-orange-300 bg-orange-900/40" :
                                  "text-blue-300 bg-blue-900/40"
                                )}
                                type="button"
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
                              </button>
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
                              <button
                                className={cn(
                                  "text-[11px] px-1 py-0 rounded font-medium cursor-pointer hover:opacity-80",
                                  predComp.action === "重注" ? "text-red-300 bg-red-900/40" :
                                  predComp.action === "轻注" ? "text-orange-300 bg-orange-900/40" :
                                  "text-blue-300 bg-blue-900/40"
                                )}
                                type="button"
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
                              </button>
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
                                      type="button"
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
                                              type="button"
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
                                            type="button"
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
          <section className="other-matches-section" aria-labelledby="other-matches-heading">
            <div className="other-matches-header">
              <div className="other-matches-title">
                <span id="other-matches-heading">其他赛况</span>
                <strong>{visibleOtherStateMatches.length}/{otherStateMatches.length}</strong>
                <small>当前：{activeOtherMatchFilterLabel} · 进行/中场/完场/未知分层查看</small>
              </div>
              <div className="other-matches-filters" aria-label="其他赛况状态筛选">
                {OTHER_MATCH_FILTERS.map((filter) => (
                  <button
                    key={filter.key}
                    type="button"
                    className={cn("other-matches-filter", otherMatchFilter === filter.key && "other-matches-filter--active")}
                    onClick={() => setOtherMatchFilter(filter.key)}
                    aria-pressed={otherMatchFilter === filter.key}
                    title={filter.description}
                  >
                    <span>{filter.label}</span>
                    <strong>{otherStateCounts[filter.key]}</strong>
                  </button>
                ))}
              </div>
            </div>
            <div className="odds-table-wrap">
              <table className="other-matches-table w-full text-xs">
                <thead>
                  <tr>
                    <th scope="colgroup" className="px-1 py-1.5 text-center" colSpan={2}>操作</th>
                    <th scope="col" className="px-1 py-1.5 text-center w-7">状态</th>
                    <th scope="colgroup" className="px-1 py-1.5 text-center" colSpan={2}>标记</th>
                    <th scope="col" className="px-2 py-1.5 text-left w-[90px]">联赛</th>
                    <th scope="col" className="px-2 py-1.5 text-center w-24">赛况</th>
                    <th scope="col" className="px-2 py-1.5 text-right">主队</th>
                    <th scope="colgroup" className="px-2 py-1.5 text-center" colSpan={3}>皇冠亚盘</th>
                    <th scope="col" className="px-2 py-1.5 text-left">客队</th>
                    <th scope="colgroup" className="px-2 py-1.5 text-center" colSpan={3}>皇冠进球数</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOtherStateMatches.length === 0 ? (
                    <tr>
                      <td colSpan={15}>
                        <div className="other-matches-empty">
                          <strong>当前筛选暂无赛事</strong>
                          <span>{activeOtherMatchFilterLabel} 分类下暂时没有比赛，切回全部可查看其他状态。</span>
                          <button type="button" onClick={() => setOtherMatchFilter("all")}>查看全部其他赛况</button>
                        </div>
                      </td>
                    </tr>
                  ) : visibleOtherStateMatches.map((match) => {
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
                              className="odds-icon-button text-gray-500 hover:text-gray-300 transition-transform"
                              type="button"
                              aria-label={expandedCompanies.has(match.id) ? "收起公司赔率" : "展开公司赔率"}
                              aria-expanded={expandedCompanies.has(match.id)}
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
                                "odds-icon-button",
                                isPinned ? "text-blue-400" : "text-gray-600"
                              )}
                              type="button"
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
                                className="odds-icon-button text-emerald-400"
                                type="button"
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
                                  "odds-icon-button transition-colors",
                                  analysisResults.has(match.id) ? "text-purple-400" : "text-gray-600 hover:text-purple-400",
                                  analyzingMatchId === match.id && "animate-pulse text-purple-400"
                                )}
                                type="button"
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
                          <td className="px-1 py-0.5 text-right leading-tight odds-number-cell">
                            <span className="text-gray-500">{displayOdds ? (displayOdds.handicapHome || "--") : "--"}</span>
                          </td>
                          <td className="px-1 py-0.5 text-center font-bold leading-tight odds-number-cell odds-number-cell--line">
                            <a
                              href={`https://vip.titan007.com/changeDetail/3in1Odds.aspx?id=${match.id}&companyid=3&l=0`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:opacity-80"
                            >
                              <span className="text-gray-400">{displayOdds ? (formatHandicapLine(displayOdds.handicapLine || "") || "--") : "--"}</span>
                            </a>
                          </td>
                          <td className="px-1 py-0.5 text-left leading-tight odds-number-cell">
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
                          <td className="px-1 py-0.5 text-right leading-tight odds-number-cell">
                            <span className="text-gray-500">{displayOdds ? (displayOdds.totalOver || "--") : "--"}</span>
                          </td>
                          <td className="px-1 py-0.5 text-center font-bold leading-tight odds-number-cell odds-number-cell--line">
                            <span className="text-gray-400">{displayOdds ? (displayOdds.totalLine || "--") : "--"}</span>
                          </td>
                          <td className="px-1 py-0.5 text-left leading-tight odds-number-cell">
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
                                      type="button"
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
          </section>
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
                                  className="odds-icon-button text-gray-500 hover:text-gray-300 transition-transform"
                                  type="button"
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
                                    type="button"
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
                                            type="button"
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
                                                    type="button"
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
                                                  type="button"
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
                className={cn("text-[11px]", excelExporting ? "text-gray-500 cursor-wait" : "text-green-400 hover:text-green-300")}
                onClick={exportToExcel}
                disabled={excelExporting}
                aria-busy={excelExporting}
              >
                {excelExporting ? "导出中…" : "导出Excel"}
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
                onClick={verifyAndLearn}
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
                                    type="button"
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
                                <div className="other-matches-data-divider">
                                  <div className="other-matches-title">
                                    <span>其他赛况</span>
                                    <strong>{otherStates.length}</strong>
                                    <small>当前页显示 {pagedOtherStates.length} 场 · 进行/中场/完场/未知集中在下方</small>
                                  </div>
                                  <div className="other-matches-data-counts" aria-label="数据中心其他赛况状态统计">
                                    {OTHER_MATCH_FILTERS.filter(filter => filter.key !== "all").map(filter => {
                                      const count = otherStates.filter(row => getMatchStatus(row.match.state).kind === filter.key).length;
                                      if (count === 0) return null;
                                      return <span key={filter.key}>{filter.label} {count}</span>;
                                    })}
                                  </div>
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
                      workstationActions.fetchPredictions(d)
                        .then(setPastedJson)
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
                      await workstationActions.deletePredictions(selectedPredDate);
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
