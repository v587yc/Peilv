export const MIN_LEARNING_SAMPLES = 20;
export const DEFAULT_MODEL_VERSION = "analysis-v1";

export const DEFAULT_INDICATOR_WEIGHTS = {
  indicator_handicap_direction: 0.20,
  indicator_water_direction: 0.30,
  indicator_divergence: 0.10,
  indicator_euro_asian: 0.20,
  indicator_open_time: 0.10,
  indicator_total_goals: 0.10,
} as const;

export type IndicatorWeights = Record<keyof typeof DEFAULT_INDICATOR_WEIGHTS, number>;

export interface StrategySnapshot {
  strategyVersion: string;
  weightsVersion: string;
  modelVersion: string;
  weights: IndicatorWeights;
  rules: Record<string, unknown>;
}

interface StrategyRow {
  version: string;
  weights: unknown;
  rules: unknown;
  model_version: string;
}

interface StrategyQuery {
  select(columns: string): StrategyQuery;
  in(column: string, values: string[]): StrategyQuery;
  lte(column: string, value: string): StrategyQuery;
  or(filters: string): StrategyQuery;
  order(column: string, options: { ascending: boolean }): StrategyQuery;
  limit(count: number): StrategyQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

interface SupabaseLike {
  from(table: string): unknown;
}

export function normalizeIndicatorWeights(value: unknown): IndicatorWeights {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const raw = Object.fromEntries(Object.entries(DEFAULT_INDICATOR_WEIGHTS).map(([key, fallback]) => {
    const candidate = Number(source[key]);
    return [key, Number.isFinite(candidate) && candidate >= 0 ? Math.min(candidate, 1) : fallback];
  })) as IndicatorWeights;
  const total = Object.values(raw).reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return { ...DEFAULT_INDICATOR_WEIGHTS };
  return Object.fromEntries(Object.entries(raw).map(([key, weight]) => [key, weight / total])) as IndicatorWeights;
}

export function predictionAsOf(input: { matchDate?: string; matchTime?: string; source?: string }, now = new Date()): string {
  if (input.source !== "backtest" || !/^\d{8}$/.test(input.matchDate || "")) return now.toISOString();
  const date = input.matchDate!;
  const time = /^\d{1,2}:\d{2}$/.test(input.matchTime || "") ? input.matchTime! : "23:59";
  const [hour, minute] = time.split(":").map(Number);
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)), hour, minute, 0)).toISOString();
}

export async function loadPublishedStrategy(client: SupabaseLike, asOf: string): Promise<StrategySnapshot | null> {
  const { data, error } = await (client
    .from("strategy_versions") as StrategyQuery)
    .select("version,weights,rules,model_version,effective_from,published_at,retired_at")
    .in("status", ["published", "retired"])
    .lte("effective_from", asOf)
    .lte("published_at", asOf)
    .or(`retired_at.is.null,retired_at.gt.${asOf}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`读取已发布策略失败: ${error.message}`);
  if (!data) return null;
  const row = data as StrategyRow;
  return {
    strategyVersion: row.version,
    weightsVersion: `${row.version}:weights`,
    modelVersion: row.model_version,
    weights: normalizeIndicatorWeights(row.weights),
    rules: row.rules && typeof row.rules === "object" && !Array.isArray(row.rules) ? row.rules as Record<string, unknown> : {},
  };
}

export function generateStrategyVersion(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
  return `strategy-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

export function wilsonLowerBound(correct: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = correct / total;
  const z2 = z * z;
  return (p + z2 / (2 * total) - z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / (1 + z2 / total);
}

export function summarizeBenchmark(rows: Array<{ is_correct?: boolean | null; strategy_version?: string | null }>) {
  const summarize = (selected: typeof rows) => {
    const verified = selected.filter(row => row.is_correct !== null && row.is_correct !== undefined);
    const correct = verified.filter(row => row.is_correct === true).length;
    return { samples: verified.length, correct, accuracy: verified.length > 0 ? Number((correct / verified.length).toFixed(4)) : 0 };
  };
  return {
    defaultWeights: summarize(rows.filter(row => !row.strategy_version)),
    publishedWeights: summarize(rows.filter(row => Boolean(row.strategy_version))),
  };
}
