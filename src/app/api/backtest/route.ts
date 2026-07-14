import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { getBacktestLimits, throwIfAborted, validateBacktestInput } from "@/lib/backtest/limits";
import { analyzeMatch, learnBacktestPatterns, verifyBacktestPredictions } from "./_analysis-pipeline";
import { persistScheduleResults } from "@/lib/verification/match-results";

function parseDbJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// --- In-memory job tracking ---
interface BacktestJob {
  id: string;
  status: "running" | "cancelling" | "cancelled" | "done" | "error" | "timed_out";
  currentStep: string;
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
  result?: Record<string, unknown>;
  lastError?: string;
  startedAt: string;
  endedAt?: string;
}

interface AnalysisCompany {
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
  euroHomeInit: string;
  euroDrawInit: string;
  euroAwayInit: string;
}

interface AnalysisRequest {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  matchTime: string;
  matchDate: string;
  source?: "production" | "backtest";
  runId?: string;
  scheduleMode: "history";
  companies: AnalysisCompany[];
  crown12Handicap?: { home: string; line: string; away: string };
  crown12Total?: { over: string; line: string; under: string };
  crownLiveHandicap?: { home: string; line: string; away: string };
  crownLiveTotal?: { over: string; line: string; under: string };
}

const jobs = new Map<string, BacktestJob>();
const jobControllers = new Map<string, AbortController>();

async function persistJob(job: BacktestJob): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("backtest_jobs").upsert({
    id: job.id,
    status: job.status,
    current_step: job.currentStep,
    start_date: job.startDate,
    end_date: job.endDate,
    current_date: job.currentDate,
    total_dates: job.totalDates,
    processed_dates: job.processedDates,
    total_matches: job.totalMatches,
    analyzed_matches: job.analyzedMatches,
    verified_matches: job.verifiedMatches,
    correct_matches: job.correctMatches,
    accuracy: job.accuracy,
    log: job.log,
    result: job.result || null,
    last_error: job.lastError || null,
    started_at: job.startedAt,
    ended_at: job.endedAt || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "id" });
  if (error) throw new Error(`回测任务状态保存失败: ${error.message}`);
}

function dbRowToJob(row: Record<string, unknown>): BacktestJob {
  return {
    id: String(row.id),
    status: row.status as BacktestJob["status"],
    currentStep: String(row.current_step || "unknown"),
    startDate: String(row.start_date),
    endDate: String(row.end_date),
    currentDate: String(row.current_date),
    totalDates: Number(row.total_dates || 0),
    processedDates: Number(row.processed_dates || 0),
    totalMatches: Number(row.total_matches || 0),
    analyzedMatches: Number(row.analyzed_matches || 0),
    verifiedMatches: Number(row.verified_matches || 0),
    correctMatches: Number(row.correct_matches || 0),
    accuracy: String(row.accuracy || "0%"),
    log: Array.isArray(row.log) ? row.log as string[] : [],
    result: row.result && typeof row.result === "object" ? row.result as Record<string, unknown> : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
    startedAt: String(row.started_at),
    endedAt: row.ended_at ? String(row.ended_at) : undefined,
  };
}

// --- GET: poll job status ---
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const job = jobs.get(id);
  if (job) return NextResponse.json({ success: true, job });

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("backtest_jobs")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "job not found" }, { status: 404 });

  const persistedJob = dbRowToJob(data);
  if (persistedJob.status === "running" || persistedJob.status === "cancelling") {
    persistedJob.status = "error";
    persistedJob.currentStep = "interrupted";
    persistedJob.lastError = "服务重启导致运行中任务中断；该任务未在后台继续执行，请重新提交";
    persistedJob.log.push(persistedJob.lastError);
    persistedJob.endedAt = new Date().toISOString();
    await persistJob(persistedJob);
  }
  return NextResponse.json({ success: true, job: persistedJob });
}

// --- DELETE: cancel backtest ---
export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const job = jobs.get(id);
  if (job) {
    if (job.status !== "running" && job.status !== "cancelling") {
      return NextResponse.json({ success: true, job, message: "任务已结束" });
    }
    job.status = "cancelling";
    job.currentStep = "cancelling";
    job.log.push("收到取消请求");
    await persistJob(job);
    jobControllers.get(id)?.abort(new Error("回测任务已取消"));
    return NextResponse.json({ success: true, job });
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("backtest_jobs").select("*").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "job not found" }, { status: 404 });
  const persistedJob = dbRowToJob(data);
  if (persistedJob.status === "running" || persistedJob.status === "cancelling") {
    persistedJob.status = "error";
    persistedJob.currentStep = "interrupted";
    persistedJob.lastError = "任务进程已不存在，无法取消；已明确标记为中断失败";
    persistedJob.log.push(persistedJob.lastError);
    persistedJob.endedAt = new Date().toISOString();
    await persistJob(persistedJob);
  }
  return NextResponse.json({ success: true, job: persistedJob });
}

async function launchBacktestJob(
  job: BacktestJob,
  maxMatches: number,
  dates: string[],
  timeoutMs: number,
): Promise<void> {
  jobs.set(job.id, job);
  const controller = new AbortController();
  jobControllers.set(job.id, controller);
  await persistJob(job);

  const timeout = setTimeout(() => {
    const message = `回测任务超过 ${timeoutMs}ms 超时`;
    job.status = "timed_out";
    job.currentStep = "timed_out";
    job.lastError = message;
    job.log.push(`Timeout: ${message}`);
    job.endedAt = new Date().toISOString();
    controller.abort(new Error(message));
    void persistJob(job).catch(() => undefined);
  }, timeoutMs);

  runBacktest(job, "", maxMatches, dates, controller.signal)
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : "回测任务失败";
      const cancelled = job.status === "cancelling" || message.includes("取消");
      const timedOut = message.includes("超时");
      job.status = cancelled ? "cancelled" : timedOut ? "timed_out" : "error";
      job.currentStep = job.status;
      job.lastError = message;
      job.log.push(`${cancelled ? "Cancelled" : timedOut ? "Timeout" : "Fatal"}: ${message}`);
      job.endedAt = new Date().toISOString();
      await persistJob(job).catch(() => undefined);
    })
    .finally(() => {
      clearTimeout(timeout);
      jobControllers.delete(job.id);
      jobs.delete(job.id);
    });
}

// --- POST: start or resume backtest ---
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const limits = getBacktestLimits();
  const supabase = getSupabaseClient();

  const { count, error: countError } = await supabase
    .from("backtest_jobs")
    .select("*", { count: "exact", head: true })
    .in("status", ["running", "cancelling"]);
  if (countError) return NextResponse.json({ error: countError.message }, { status: 500 });
  if ((count || 0) >= limits.maxConcurrentJobs) {
    return NextResponse.json({ error: `running backtest limit reached (${limits.maxConcurrentJobs})` }, { status: 429 });
  }

  const resumeJobId = typeof body.resumeJobId === "string" ? body.resumeJobId : "";
  if (resumeJobId) {
    const { data, error } = await supabase.from("backtest_jobs").select("*").eq("id", resumeJobId).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "job not found" }, { status: 404 });

    const job = dbRowToJob(data);
    if (job.status === "done") {
      return NextResponse.json({ success: true, jobId: job.id, resumed: false, message: "任务已完成" });
    }
    if (job.status === "running" || job.status === "cancelling") {
      return NextResponse.json({ error: "任务仍在运行" }, { status: 409 });
    }

    const config = job.result?.config && typeof job.result.config === "object"
      ? job.result.config as Record<string, unknown>
      : {};
    const validated = validateBacktestInput({
      startDate: job.startDate,
      endDate: job.endDate,
      maxMatches: Number(config.maxMatches || 0),
    }, limits);
    const remainingDates = validated.dates.slice(Math.min(job.processedDates, validated.dates.length));
    job.status = "running";
    job.currentStep = "resuming";
    job.lastError = undefined;
    job.endedAt = undefined;
    job.log.push(`从第 ${job.processedDates + 1} 个日期恢复执行`);
    await launchBacktestJob(job, validated.maxMatches, remainingDates, limits.timeoutMs);
    return NextResponse.json({ success: true, jobId: job.id, resumed: true, remainingDates: remainingDates.length });
  }

  let validated: ReturnType<typeof validateBacktestInput>;
  try {
    validated = validateBacktestInput(body, limits);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "invalid input" }, { status: 400 });
  }

  const jobId = `bt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job: BacktestJob = {
    id: jobId,
    status: "running",
    currentStep: "queued",
    startDate: validated.startDate,
    endDate: validated.endDate,
    currentDate: validated.startDate,
    totalDates: validated.dates.length,
    processedDates: 0,
    totalMatches: 0,
    analyzedMatches: 0,
    verifiedMatches: 0,
    correctMatches: 0,
    accuracy: "0%",
    log: [],
    result: { config: { maxMatches: validated.maxMatches, timeoutMs: limits.timeoutMs } },
    startedAt: new Date().toISOString(),
  };
  await launchBacktestJob(job, validated.maxMatches, validated.dates, limits.timeoutMs);

  return NextResponse.json({ success: true, jobId, limits: { maxMatches: validated.maxMatches, timeoutMs: limits.timeoutMs } });
}

async function loadFocusedLeagues(supabase: ReturnType<typeof getSupabaseClient>): Promise<Set<string> | null> {
  const { data, error } = await supabase
    .from("user_focused_leagues")
    .select("league_name");

  if (error) {
    console.log("[Backtest] Failed to load focused leagues:", error.message);
    return null;
  }

  return new Set((data || []).map((row: { league_name: string }) => row.league_name));
}

// --- Main backtest pipeline ---
async function runBacktest(
  job: BacktestJob,
  minConfidence: string,
  maxMatches: number,
  dates: string[],
  signal: AbortSignal,
) {
  const supabase = getSupabaseClient();
  void minConfidence;
  throwIfAborted(signal);
  const focusedLeagues = await loadFocusedLeagues(supabase);
  if (!focusedLeagues) {
    throw new Error("关注联赛白名单不可用");
  }
  job.totalDates = Math.max(job.totalDates, job.processedDates + dates.length);
  job.currentStep = "loading_schedule";
  await persistJob(job);

  dateLoop: for (const date of dates) {
    throwIfAborted(signal);
    job.currentDate = date;
    job.currentStep = "loading_schedule";
    job.log.push(`[${date}] 开始处理...`);

    // Step 1: Fetch schedule
    const rawMatches = await fetchScheduleForDate(date, signal);
    const matches = focusedLeagues.size > 0
      ? rawMatches.filter(match => focusedLeagues.has(match.league))
      : rawMatches;
    if (matches.length === 0) {
      job.log.push(`[${date}] 无白名单赛事数据，跳过`);
      job.processedDates++;
      await persistJob(job);
      continue;
    }
    job.totalMatches += matches.length;
    const persistedResults = await persistScheduleResults(
      supabase,
      matches.map(match => ({ ...match })),
    );
    job.log.push(`[${date}] 获取到 ${rawMatches.length} 场赛事，白名单内 ${matches.length} 场，保存赛果 ${persistedResults} 场`);

    // Step 2: Load odds from DB for this date
    const oddsMap = await loadOddsFromDb(date, supabase);
    const oddsCount = Object.keys(oddsMap).length;
    job.log.push(`[${date}] 数据库赔率: ${oddsCount} 场`);

    // Step 3: Analyze each match (blind — no result shown)
    for (const match of matches) {
      if (maxMatches > 0 && job.analyzedMatches >= maxMatches) {
        job.log.push(`达到最大分析数量 ${maxMatches}，停止`);
        break dateLoop;
      }

      const oddsData = oddsMap[match.id];
      if (!oddsData) continue;

      const companies = (oddsData as Record<string, unknown>).companies as Record<string, unknown>[] | undefined;
      if (!companies || companies.length === 0) continue;

      // Transform to AnalysisRequest format
      const analysisReq = buildAnalysisRequest(match, oddsData as Record<string, unknown>, job.id);

      // Skip if not enough data
      if (!analysisReq.companies || analysisReq.companies.length < 2) continue;

      // Run analysis through the in-process service boundary.
      try {
        throwIfAborted(signal);
        job.currentStep = "analyzing";
        const analysisData = await analyzeMatch(analysisReq as unknown as Record<string, unknown>);
        if (analysisData.success && analysisData.data) {
          job.analyzedMatches++;
        }
      } catch (err) {
        throwIfAborted(signal);
        job.log.push(`[${date}] ${match.homeTeam} vs ${match.awayTeam} 分析异常: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }

    job.log.push(`[${date}] 分析完成，已分析 ${job.analyzedMatches} 场`);
    job.processedDates++;
    await persistJob(job);
  }

  // Step 4: Verify all predictions
  throwIfAborted(signal);
  job.currentStep = "verifying";
  job.log.push("开始验证预测结果...");
  try {
    const verifyData = await verifyBacktestPredictions(job.startDate, job.endDate);
    if (verifyData.success) {
      job.verifiedMatches = Number(verifyData.verified || 0);
      job.correctMatches = Number(verifyData.correct || 0);
      job.accuracy = String(verifyData.accuracy || "N/A");
      job.log.push(`让球验证完成: 加权样本 ${verifyData.verified}, 加权正确 ${verifyData.correct}, 加权准确率 ${verifyData.accuracy}`);
      job.result = {
        ...job.result,
        verify: {
          ...((verifyData.stats as Record<string, unknown> | undefined) || {}),
          markets: verifyData.markets || (verifyData.stats as Record<string, unknown> | undefined)?.markets,
          accuracy: verifyData.accuracy || "N/A",
          baselineComparison: verifyData.baselineComparison,
        },
      };
    }
  } catch (err) {
    throwIfAborted(signal);
    job.log.push(`验证异常: ${err instanceof Error ? err.message : "unknown"}`);
  }

  // Step 5: Learning — mine patterns
  throwIfAborted(signal);
  job.currentStep = "learning";
  job.log.push("开始机器学习...");
  try {
    const learnData = await learnBacktestPatterns(job.id, job.startDate, job.endDate);
    if (learnData.success) {
      const learnedMarkets = (learnData.markets || {}) as Record<string, Record<string, unknown>>;
      for (const [market, result] of Object.entries(learnedMarkets)) {
        const label = market === "total" ? "进球" : "让球";
        job.log.push(`${label}学习完成: 发现 ${result.patternsFound || 0} 个模式, 更新 ${result.patternsUpserted || 0} 个`);
        job.log.push(`${label}加权准确率: ${result.overallAccuracy || "N/A"} (${result.totalCorrect || 0}/${result.totalPredictions || 0})`);
      }
      if (job.result) {
        const serializeMarket = (result: Record<string, unknown>) => {
          const rawTopPatterns = Array.isArray(result.topPatterns) ? result.topPatterns : [];
          return {
            patternsFound: result.patternsFound,
            patternsUpserted: result.patternsUpserted,
            overallAccuracy: result.overallAccuracy,
            summary: result.summary,
            dynamicWeights: result.dynamicWeights,
            topPatterns: rawTopPatterns.map((pattern: Record<string, unknown>) => ({
              indicators: parseIndicatorsFromKey(pattern.key as string),
              direction: parseDirectionFromKey(pattern.key as string),
              accuracy: parseFloat((pattern.hitRate as string || "0%").replace("%", "")) / 100,
              samples: (pattern.total as number) || 0,
            })),
          };
        };
        (job.result as Record<string, unknown>).learn = {
          markets: Object.fromEntries(Object.entries(learnedMarkets).map(([market, result]) => [market, serializeMarket(result)])),
        };
      }
    } else {
      job.log.push(`学习失败: ${learnData.error || learnData.message || "未知"}`);
    }
  } catch (err) {
    throwIfAborted(signal);
    job.log.push(`学习异常: ${err instanceof Error ? err.message : "unknown"}`);
  }

  throwIfAborted(signal);
  job.status = "done";
  job.currentStep = "completed";
  job.endedAt = new Date().toISOString();
  job.log.push("回测完成!");
  await persistJob(job);
}

// --- Fetch schedule for a date ---
interface ScheduleMatch {
  id: string;
  league: string;
  leagueColor: string;
  time: string;
  state: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: string;
  awayScore: string;
  sclassId: string;
  matchDate: string;
}

async function fetchScheduleForDate(date: string, signal: AbortSignal): Promise<ScheduleMatch[]> {
  try {
    const res = await fetch(
      `https://bf.titan007.com/football/Over_${date}.htm`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: "https://live.titan007.com/",
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      }
    );
    if (!res.ok) return [];
    const buffer = await res.arrayBuffer();
    const html = new TextDecoder("gbk").decode(buffer);
    return parseScheduleHtml(html, date);
  } catch {
    throwIfAborted(signal);
    return [];
  }
}

function parseScheduleHtml(html: string, date: string): ScheduleMatch[] {
  const matches: ScheduleMatch[] = [];
  const trRegex = /<tr[^>]*name=['"]([^,'"]+),([^'"]+)['"][^>]*sId=['"](\d+)['"][^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const matchId = trMatch[3];
    const rowHtml = trMatch[4];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const tds: string[] = [];
    let tdMatch;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      tds.push(tdMatch[1].replace(/<[^>]*>/g, "").trim());
    }
    if (tds.length < 7) continue;

    const league = tds[0];
    const time = tds[1];
    const state = tds[2];
    const homeTeam = tds[3].replace(/\[.*?\]/g, "").trim();
    const scoreText = tds[4];
    const awayTeam = tds[5].replace(/\[.*?\]/g, "").trim();

    const scoreParts = scoreText.split("-");
    const homeScore = scoreParts[0]?.trim() || "";
    const awayScore = scoreParts.length > 1 ? scoreParts[1]?.trim() : "";

    let mappedState = state;
    if (state === "完") mappedState = "-1";
    else if (state === "未" || state === "") mappedState = "0";
    else if (state === "中") mappedState = "1";

    matches.push({
      id: matchId,
      league,
      leagueColor: "",
      time,
      state: mappedState,
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      sclassId: "",
      matchDate: date,
    });
  }
  return matches;
}

// --- Load odds from DB ---
async function loadOddsFromDb(
  date: string,
  supabase: ReturnType<typeof getSupabaseClient>
): Promise<Record<string, unknown>> {
  const oddsMap: Record<string, unknown> = {};
  let page = 0;
  const pageSize = 1000;

  while (true) {
    const { data } = await supabase
      .from("match_odds")
      .select("match_id, odds_data, open_times_data, crown_live_odds, crown_12_odds")
      .eq("match_date", date)
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (!data || data.length === 0) break;

    for (const row of data) {
      const oddsData = parseDbJsonObject(row.odds_data);
      const openTimesData = parseDbJsonObject(row.open_times_data);

      // Merge open times
      if (openTimesData && typeof openTimesData === "object") {
        const companies = oddsData.companies as Record<string, unknown>[] | undefined;
        if (companies && Array.isArray(companies)) {
          for (const c of companies) {
            const ot = openTimesData[String(c.companyId)];
            if (ot) c.openTime = String(ot);
          }
        }
      }

      oddsMap[row.match_id] = {
        ...oddsData,
        crown_live_odds: parseDbJsonObject(row.crown_live_odds),
        crown_12_odds: parseDbJsonObject(row.crown_12_odds),
      };
    }

    if (data.length < pageSize) break;
    page++;
  }

  return oddsMap;
}

// --- Transform DB odds → AnalysisRequest ---
function buildAnalysisRequest(
  match: ScheduleMatch,
  oddsData: Record<string, unknown>,
  runId: string,
): AnalysisRequest {
  const companies = (oddsData.companies || []) as Record<string, unknown>[];
  const crown12 = oddsData.crown_12_odds as Record<string, string> | null;
  const crownLive = oddsData.crown_live_odds as Record<string, string> | null;

  const companyOdds = companies
    .filter((c) => c.ftHandicapLine && c.ftHandicapHome)
    .map((c) => ({
      companyId: String(c.companyId),
      companyName: String(c.companyName),
      openTime: String(c.openTime || ""),
      asianHomeInit: String(c.ftHandicapHome || ""),
      asianLineInit: String(c.ftHandicapLine || ""),
      asianAwayInit: String(c.ftHandicapAway || ""),
      euroAsianHomeInit: String(c.euroAsianHome || ""),
      euroAsianLineInit: String(c.euroAsianLine || ""),
      euroAsianAwayInit: String(c.euroAsianAway || ""),
      totalOverInit: String(c.ftTotalOver || ""),
      totalLineInit: String(c.ftTotalLine || ""),
      totalUnderInit: String(c.ftTotalUnder || ""),
      asianHomeLive: String(c.ftHandicapHomeLive || ""),
      asianLineLive: String(c.ftHandicapLineLive || ""),
      asianAwayLive: String(c.ftHandicapAwayLive || ""),
      euroHomeInit: String(c.euroHome || ""),
      euroDrawInit: String(c.euroDraw || ""),
      euroAwayInit: String(c.euroAway || ""),
    }));

  const crown12Handicap = crown12?.handicapLine
    ? { home: crown12.handicapHome || "", line: crown12.handicapLine, away: crown12.handicapAway || "" }
    : undefined;
  const crown12Total = crown12?.totalLine
    ? { over: crown12.totalOver || "", line: crown12.totalLine, under: crown12.totalUnder || "" }
    : undefined;
  const crownLiveHandicap = crownLive?.handicapLine
    ? { home: crownLive.handicapHome || "", line: crownLive.handicapLine, away: crownLive.handicapAway || "" }
    : undefined;
  const crownLiveTotal = crownLive?.totalLine
    ? { over: crownLive.totalOver || "", line: crownLive.totalLine, under: crownLive.totalUnder || "" }
    : undefined;

  return {
    matchId: match.id,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    league: match.league,
    matchTime: match.time,
    matchDate: match.matchDate,
    source: "backtest",
    runId,
    scheduleMode: "history",
    companies: companyOdds,
    ...(crown12Handicap ? { crown12Handicap } : {}),
    ...(crown12Total ? { crown12Total } : {}),
    ...(crownLiveHandicap ? { crownLiveHandicap } : {}),
    ...(crownLiveTotal ? { crownLiveTotal } : {}),
  };
}

// --- Pattern key parsing helpers ---
function parseIndicatorsFromKey(key: string): string[] {
  // Key format: "field1=value1+field2=value2+field3=value3"
  const nameMap: Record<string, string> = {
    indicator_handicap_direction: "盘口方向",
    indicator_water_direction: "水位走势",
    indicator_divergence: "公司分歧",
    indicator_euro_asian: "欧亚偏离",
    indicator_open_time: "初盘时间",
    indicator_total_goals: "大小球趋势",
  };
  return key.split("+").map((part) => {
    const [field, val] = part.split("=");
    const name = nameMap[field] || field;
    return `${name}=${val}`;
  });
}

function parseDirectionFromKey(key: string): string {
  // Extract the last signal value as the predicted direction
  const parts = key.split("+");
  const lastPart = parts[parts.length - 1];
  const val = lastPart.split("=")[1] || "";
  if (val === "主降水") return "主胜";
  if (val === "客降水") return "客胜";
  return val || "中立";
}
