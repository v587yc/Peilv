"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Play,
  BarChart3,
  Brain,
  CheckCircle,
  XCircle,
  Clock,
  Target,
  TrendingUp,
  Zap,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface BacktestJob {
  id: string;
  status: "running" | "done" | "error";
  startDate: string;
  endDate: string;
  currentDate: string;
  totalDates: number;
  processedDates: number;
  totalMatches: number;
  analyzedMatches: number;
  verifiedMatches: number;
  correctMatches: number;
  accuracy: string;
  log: string[];
  result?: {
    verify?: Record<string, unknown>;
    learn?: {
      patternsFound: number;
      patternsUpserted: number;
      overallAccuracy: string;
      dynamicWeights?: Record<string, number>;
      topPatterns?: Array<{
        indicators: string[];
        direction: string;
        accuracy: number;
        samples: number;
      }>;
    };
  };
  startedAt: string;
  endedAt?: string;
}

const PRESETS = [
  { label: "最近 1 周", days: 7 },
  { label: "最近 1 个月", days: 30 },
  { label: "最近 3 个月", days: 90 },
  { label: "最近 1 年", days: 365 },
];

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function formatDisplayDate(s: string): string {
  if (s.length !== 8) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function elapsed(startedAt: string, endedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const secs = Math.floor((end - start) / 1000);
  if (secs < 60) return `${secs}秒`;
  if (secs < 3600) return `${Math.floor(secs / 60)}分${secs % 60}秒`;
  return `${Math.floor(secs / 3600)}时${Math.floor((secs % 3600) / 60)}分`;
}

export default function BacktestPage() {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [maxMatches, setMaxMatches] = useState(0);
  const [job, setJob] = useState<BacktestJob | null>(null);
  const [polling, setPolling] = useState(false);
  const [showLog, setShowLog] = useState(true);
  const [showAllLog, setShowAllLog] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Set default dates
  useEffect(() => {
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    setStartDate(formatDate(weekAgo));
    setEndDate(formatDate(today));
  }, []);

  const applyPreset = (days: number) => {
    const today = new Date();
    const past = new Date(today);
    past.setDate(past.getDate() - days);
    setStartDate(formatDate(past));
    setEndDate(formatDate(today));
  };

  // Poll job status
  const pollJob = useCallback(async (jobId: string) => {
    try {
      const res = await fetch("/api/admin/backtests", { cache: "no-store" });
      const data = await res.json();
      const item = Array.isArray(data.items) ? data.items.find((candidate: { id?: unknown }) => candidate.id === jobId) : null;
      if (data.success && item) {
        const nextJob: BacktestJob = {
          id: item.id,
          status: item.status,
          startDate: item.start_date,
          endDate: item.end_date,
          currentDate: item.current_date || item.start_date,
          totalDates: item.total_dates || 0,
          processedDates: item.processed_dates || 0,
          totalMatches: item.total_matches || 0,
          analyzedMatches: item.analyzed_matches || 0,
          verifiedMatches: item.verified_matches || 0,
          correctMatches: item.correct_matches || 0,
          accuracy: item.accuracy || "0%",
          log: Array.isArray(item.log) ? item.log : [],
          result: item.result || undefined,
          startedAt: item.started_at,
          endedAt: item.ended_at || undefined,
        };
        setJob(nextJob);
        if (nextJob.status !== "running") {
          setPolling(false);
        }
      }
    } catch {
      // ignore poll errors
    }
  }, []);

  // Start polling when job is running
  useEffect(() => {
    if (polling && job?.id && job.status === "running") {
      pollRef.current = setInterval(() => pollJob(job.id), 2000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [polling, job?.id, job?.status, pollJob]);

  // Auto-scroll log
  useEffect(() => {
    if (showLog && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [job?.log?.length, showLog]);

  async function startBacktest() {
    if (!startDate || !endDate) return;

    setJob(null);
    setPolling(false);

    try {
      const res = await fetch("/api/admin/backtests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetId: "backtest.start",
          reason: "回测页面创建回测任务",
          idempotencyKey: `backtest:start:${crypto.randomUUID()}`,
          payload: { startDate, endDate, maxMatches: maxMatches || 0 },
        }),
      });
      const data = await res.json();
      if (data.success && data.jobId) {
        // Start polling
        const newJob: BacktestJob = {
          id: data.jobId,
          status: "running",
          startDate,
          endDate,
          currentDate: startDate,
          totalDates: 0,
          processedDates: 0,
          totalMatches: 0,
          analyzedMatches: 0,
          verifiedMatches: 0,
          correctMatches: 0,
          accuracy: "0%",
          log: ["任务已启动..."],
          startedAt: new Date().toISOString(),
        };
        setJob(newJob);
        setPolling(true);
      }
    } catch (err) {
      setJob({
        id: "error",
        status: "error",
        startDate,
        endDate,
        currentDate: "",
        totalDates: 0,
        processedDates: 0,
        totalMatches: 0,
        analyzedMatches: 0,
        verifiedMatches: 0,
        correctMatches: 0,
        accuracy: "0%",
        log: [`启动失败: ${err instanceof Error ? err.message : "未知错误"}`],
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      });
    }
  }

  const isRunning = job?.status === "running";
  const isDone = job?.status === "done";
  const isError = job?.status === "error";
  const progress = job && job.totalDates > 0 ? Math.round((job.processedDates / job.totalDates) * 100) : 0;

  const logLines = job?.log || [];
  const displayLog = showAllLog ? logLines : logLines.slice(-50);

  return (
    <div className="min-h-screen bg-[#0a0e17] text-gray-100 p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Brain className="w-6 h-6 text-purple-400" />
              自主学习回测系统
            </h1>
            <p className="text-gray-400 text-sm mt-1">
              获取历史赛事 → 盲态分析 → 验证结果 → 自主学习改进
            </p>
          </div>
        </div>

        {/* Config Card */}
        <Card className="bg-[#111827] border-gray-700">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4 text-blue-400" />
              回测参数
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Presets */}
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <Button
                  key={p.days}
                  variant="outline"
                  size="sm"
                  onClick={() => applyPreset(p.days)}
                  className="border-gray-600 text-gray-300 hover:bg-gray-700"
                  disabled={isRunning}
                >
                  {p.label}
                </Button>
              ))}
            </div>

            {/* Date inputs */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <Label className="text-gray-400">开始日期</Label>
                <Input
                  value={startDate ? formatDisplayDate(startDate) : ""}
                  onChange={(e) => {
                    const v = e.target.value.replace(/-/g, "");
                    setStartDate(v);
                  }}
                  className="mt-1 bg-[#1a1f2e] border-gray-600"
                  placeholder="YYYY-MM-DD"
                  disabled={isRunning}
                />
              </div>
              <div>
                <Label className="text-gray-400">结束日期</Label>
                <Input
                  value={endDate ? formatDisplayDate(endDate) : ""}
                  onChange={(e) => {
                    const v = e.target.value.replace(/-/g, "");
                    setEndDate(v);
                  }}
                  className="mt-1 bg-[#1a1f2e] border-gray-600"
                  placeholder="YYYY-MM-DD"
                  disabled={isRunning}
                />
              </div>
              <div>
                <Label className="text-gray-400">
                  最大分析场次
                  <span className="text-xs text-gray-500 ml-1">(0=不限)</span>
                </Label>
                <Input
                  type="number"
                  value={maxMatches}
                  onChange={(e) => setMaxMatches(Number(e.target.value))}
                  className="mt-1 bg-[#1a1f2e] border-gray-600"
                  min={0}
                  disabled={isRunning}
                />
              </div>
            </div>

            {/* Start button */}
            <div className="flex items-center gap-3">
              <Button
                onClick={startBacktest}
                disabled={isRunning || !startDate || !endDate}
                className="bg-purple-600 hover:bg-purple-700"
              >
                {isRunning ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    回测中...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 mr-2" />
                    开始回测
                  </>
                )}
              </Button>
              {isRunning && (
                <span className="text-gray-400 text-sm">
                  已运行 {job ? elapsed(job.startedAt) : "0秒"}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Progress Card */}
        {job && (
          <Card className="bg-[#111827] border-gray-700">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                {isRunning ? (
                  <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                ) : isDone ? (
                  <CheckCircle className="w-4 h-4 text-emerald-400" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-400" />
                )}
                进度
                {isDone && <Badge className="bg-emerald-600 ml-2">完成</Badge>}
                {isError && <Badge variant="destructive" className="ml-2">错误</Badge>}
                {isRunning && <Badge className="bg-blue-600 ml-2">运行中</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Progress bar */}
              {isRunning && job.totalDates > 0 && (
                <div>
                  <div className="flex justify-between text-sm text-gray-400 mb-1">
                    <span>
                      {formatDisplayDate(job.currentDate)} ({job.processedDates}/{job.totalDates} 天)
                    </span>
                    <span>{progress}%</span>
                  </div>
                  <div className="w-full bg-gray-700 rounded-full h-2">
                    <div
                      className="bg-gradient-to-r from-purple-500 to-blue-500 h-2 rounded-full transition-all duration-500"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Stats grid */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <StatBox
                  label="赛事总数"
                  value={job.totalMatches}
                  icon={<Target className="w-3.5 h-3.5" />}
                  color="text-blue-400"
                />
                <StatBox
                  label="已分析"
                  value={job.analyzedMatches}
                  icon={<Zap className="w-3.5 h-3.5" />}
                  color="text-purple-400"
                />
                <StatBox
                  label="已验证"
                  value={job.verifiedMatches}
                  icon={<CheckCircle className="w-3.5 h-3.5" />}
                  color="text-emerald-400"
                />
                <StatBox
                  label="预测正确"
                  value={job.correctMatches}
                  icon={<TrendingUp className="w-3.5 h-3.5" />}
                  color="text-yellow-400"
                />
                <StatBox
                  label="准确率"
                  value={job.accuracy}
                  icon={<BarChart3 className="w-3.5 h-3.5" />}
                  color="text-orange-400"
                  isString
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Results Card */}
        {job?.result && (
          <>
            {/* Verification Results */}
            {job.result.verify && (
              <Card className="bg-[#111827] border-gray-700">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-emerald-400" />
                    验证结果
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <VerifyStats data={job.result.verify} />
                </CardContent>
              </Card>
            )}

            {/* Learning Report */}
            {job.result.learn && (
              <Card className="bg-[#111827] border-gray-700">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Brain className="w-4 h-4 text-purple-400" />
                    学习报告
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <StatBox
                      label="发现模式"
                      value={job.result.learn.patternsFound}
                      color="text-purple-400"
                    />
                    <StatBox
                      label="更新模式"
                      value={job.result.learn.patternsUpserted}
                      color="text-blue-400"
                    />
                    <StatBox
                      label="总体准确率"
                      value={job.result.learn.overallAccuracy}
                      color="text-emerald-400"
                      isString
                    />
                  </div>

                  {/* Dynamic Weights */}
                  {job.result.learn.dynamicWeights && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-300 mb-2">动态权重调整</h4>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {Object.entries(job.result.learn.dynamicWeights).map(([key, val]) => (
                          <div key={key} className="flex items-center justify-between bg-[#1a1f2e] rounded px-3 py-1.5 text-sm">
                            <span className="text-gray-400">{formatWeightLabel(key)}</span>
                            <span className="text-white font-mono">{(val as number).toFixed(3)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Top Patterns */}
                  {job.result.learn.topPatterns && job.result.learn.topPatterns.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-300 mb-2">高置信度模式</h4>
                      <div className="space-y-2">
                        {job.result.learn.topPatterns.slice(0, 10).map((p, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between bg-[#1a1f2e] rounded px-3 py-2 text-sm"
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              {p.indicators.map((ind, j) => (
                                <Badge key={j} variant="outline" className="text-xs border-gray-600 text-gray-300">
                                  {ind}
                                </Badge>
                              ))}
                              <span className="text-gray-500">→</span>
                              <Badge
                                className={
                                  p.direction === "主胜"
                                    ? "bg-emerald-700"
                                    : p.direction === "客胜"
                                    ? "bg-red-700"
                                    : "bg-yellow-700"
                                }
                              >
                                {p.direction}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-3 ml-3 shrink-0">
                              <span className="text-emerald-400 font-mono">{(p.accuracy * 100).toFixed(1)}%</span>
                              <span className="text-gray-500 text-xs">({p.samples}场)</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Log Card */}
        {job && job.log.length > 0 && (
          <Card className="bg-[#111827] border-gray-700">
            <CardHeader
              className="cursor-pointer select-none"
              onClick={() => setShowLog(!showLog)}
            >
              <CardTitle className="text-base flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-gray-400" />
                  运行日志 ({job.log.length} 条)
                </span>
                {showLog ? (
                  <ChevronUp className="w-4 h-4 text-gray-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                )}
              </CardTitle>
            </CardHeader>
            {showLog && (
              <CardContent>
                <div className="bg-[#0d1117] rounded-md p-3 max-h-80 overflow-y-auto font-mono text-xs">
                  {!showAllLog && logLines.length > 50 && (
                    <button
                      onClick={() => setShowAllLog(true)}
                      className="text-blue-400 hover:underline mb-2 block"
                    >
                      显示全部 {logLines.length} 条日志...
                    </button>
                  )}
                  {displayLog.map((line, i) => (
                    <div
                      key={i}
                      className={`py-0.5 ${
                        line.includes("失败") || line.includes("异常") || line.includes("错误")
                          ? "text-red-400"
                          : line.includes("完成") || line.includes("正确")
                          ? "text-emerald-400"
                          : "text-gray-400"
                      }`}
                    >
                      {line}
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </CardContent>
            )}
          </Card>
        )}

        {/* Timing info */}
        {job && (
          <div className="text-xs text-gray-500 text-right">
            {job.startedAt && (
              <span>
                开始: {new Date(job.startedAt).toLocaleString("zh-CN")}
                {job.endedAt && <> | 结束: {new Date(job.endedAt).toLocaleString("zh-CN")}</>}
                <> | 耗时: {elapsed(job.startedAt, job.endedAt)}</>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Sub components ---

function StatBox({
  label,
  value,
  icon,
  color = "text-white",
  isString = false,
}: {
  label: string;
  value: number | string;
  icon?: React.ReactNode;
  color?: string;
  isString?: boolean;
}) {
  return (
    <div className="bg-[#1a1f2e] rounded-lg p-3 text-center">
      <div className={`text-lg font-bold ${color} flex items-center justify-center gap-1`}>
        {icon}
        {isString ? value : typeof value === "number" ? value.toLocaleString() : value}
      </div>
      <div className="text-xs text-gray-500 mt-1">{label}</div>
    </div>
  );
}

function VerifyStats({ data }: { data: Record<string, unknown> }) {
  const directionStats = data.waterDirectionStats as Record<string, { total: number; correct: number }> | undefined;
  const leagueStats = data.leagueStats as Record<string, { total: number; correct: number }> | undefined;

  return (
    <div className="space-y-4">
      {/* Overall */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatBox label="总验证" value={(data.total as number) || 0} color="text-blue-400" />
        <StatBox label="正确" value={(data.correct as number) || 0} color="text-emerald-400" />
        <StatBox label="错误" value={(data.wrong as number) || 0} color="text-red-400" />
        <StatBox label="准确率" value={(data.accuracy as string) || "N/A"} color="text-orange-400" isString />
      </div>

      {/* Direction breakdown */}
      {directionStats && Object.keys(directionStats).length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-300 mb-2">按方向统计</h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {Object.entries(directionStats).map(([dir, stats]) => {
              const s = stats as { total: number; correct: number };
              const pct = s.total > 0 ? ((s.correct / s.total) * 100).toFixed(1) : "0";
              return (
                <div key={dir} className="bg-[#1a1f2e] rounded px-3 py-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">{dir}</span>
                    <span className="text-emerald-400 font-mono">{pct}%</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {s.correct}/{s.total} 正确
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* League breakdown */}
      {leagueStats && Object.keys(leagueStats).length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-300 mb-2">按联赛统计 (Top 10)</h4>
          <div className="space-y-1">
            {Object.entries(leagueStats)
              .sort((a, b) => (b[1] as { total: number }).total - (a[1] as { total: number }).total)
              .slice(0, 10)
              .map(([league, stats]) => {
                const s = stats as { total: number; correct: number };
                const pct = s.total > 0 ? ((s.correct / s.total) * 100).toFixed(1) : "0";
                return (
                  <div key={league} className="flex items-center justify-between bg-[#1a1f2e] rounded px-3 py-1.5 text-sm">
                    <span className="text-gray-300 truncate mr-2">{league}</span>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-gray-500 text-xs">{s.correct}/{s.total}</span>
                      <span className="text-emerald-400 font-mono text-xs">{pct}%</span>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}

function formatWeightLabel(key: string): string {
  const labels: Record<string, string> = {
    handicapDirection: "盘口方向",
    waterDirection: "水位走势",
    companyDivergence: "公司分歧",
    euroAsianDeviation: "欧亚偏离",
    openingTime: "初盘时间",
    totalGoalsTrend: "大小球趋势",
  };
  return labels[key] || key;
}
