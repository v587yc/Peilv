export interface ParsedMatchResult {
  match_id: string;
  match_date: string;
  status: "finished" | "pending" | "special";
  home_score: number | null;
  away_score: number | null;
  home_half_score: number | null;
  away_half_score: number | null;
  score_source: string;
  observed_at: string;
  settled_at: string | null;
  updated_at: string;
}

function score(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  return Number(value);
}

export function scheduleMatchToResult(
  match: Record<string, unknown>,
  observedAt = new Date().toISOString(),
  scoreSource = "titan_schedule_history",
): ParsedMatchResult | null {
  const home = score(match.homeScore);
  const away = score(match.awayScore);
  const isFinished = match.state === "-1";
  if (!isFinished && home === null && away === null) return null;
  const status = isFinished && home !== null && away !== null ? "finished" : isFinished ? "special" : "pending";
  return {
    match_id: String(match.id),
    match_date: String(match.matchDate),
    status,
    home_score: status === "finished" ? home : null,
    away_score: status === "finished" ? away : null,
    home_half_score: status === "finished" ? score(match.halfHomeScore) : null,
    away_half_score: status === "finished" ? score(match.halfAwayScore) : null,
    score_source: scoreSource,
    observed_at: observedAt,
    settled_at: status === "finished" ? observedAt : null,
    updated_at: observedAt,
  };
}

interface PersistScheduleOptions {
  scoreSource?: string;
  observedAt?: string;
  finishedOnly?: boolean;
}

export async function persistScheduleResults(
  supabase: { from(table: string): { upsert(rows: ParsedMatchResult[], options: { onConflict: string }): PromiseLike<{ error: { message: string } | null }> } },
  matches: Record<string, unknown>[],
  options: PersistScheduleOptions = {},
): Promise<number> {
  const observedAt = options.observedAt || new Date().toISOString();
  const rows = matches
    .map(match => scheduleMatchToResult(match, observedAt, options.scoreSource))
    .filter((row): row is ParsedMatchResult => row !== null)
    .filter(row => !options.finishedOnly || row.status === "finished");
  if (!rows.length) return 0;
  const { error } = await supabase.from("match_results").upsert(rows, { onConflict: "match_id,match_date" });
  if (error) throw new Error(`match result persistence failed: ${error.message}`);
  return rows.length;
}

export interface PersistedResultSummary {
  finishedResultCount: number;
  sourceCounts: Record<string, number>;
  oldestObservedAt: string | null;
  newestObservedAt: string | null;
}

export interface PersistedResultReader {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): PromiseLike<{
        data: Array<Record<string, unknown>> | null;
        error: { message: string } | null;
      }>;
    };
  };
}

export async function loadPersistedFinishedResultSummary(
  supabase: PersistedResultReader,
  matchDate: string,
): Promise<PersistedResultSummary> {
  const { data, error } = await supabase
    .from("match_results")
    .select("status,home_score,away_score,score_source,observed_at")
    .eq("match_date", matchDate);
  if (error) throw new Error(`match result fallback query failed: ${error.message}`);

  const valid = (data || []).filter(row =>
    row.status === "finished"
    && Number.isInteger(row.home_score)
    && Number(row.home_score) >= 0
    && Number.isInteger(row.away_score)
    && Number(row.away_score) >= 0
    && typeof row.score_source === "string"
    && row.score_source.length > 0
    && typeof row.observed_at === "string"
    && row.observed_at.length > 0,
  );
  const sourceCounts: Record<string, number> = {};
  const observations: string[] = [];
  for (const row of valid) {
    const source = String(row.score_source);
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    observations.push(String(row.observed_at));
  }
  observations.sort();
  return {
    finishedResultCount: valid.length,
    sourceCounts,
    oldestObservedAt: observations[0] || null,
    newestObservedAt: observations.at(-1) || null,
  };
}
