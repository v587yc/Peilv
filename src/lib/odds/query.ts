export const DEFAULT_ODDS_QUERY_LIMIT = 50;
export const MAX_ODDS_QUERY_LIMIT = 200;

export type OddsQueryParameters = {
  page: number;
  limit: number;
  matchId: string | null;
  date: string | null;
  companyId: string | null;
  marketType: string | null;
  snapshotType: string | null;
  source: string | null;
  from: string | null;
  to: string | null;
};

function parsePositiveInteger(value: string | null, fallback: number, maximum?: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return maximum ? Math.min(parsed, maximum) : parsed;
}

function parseTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseOddsQueryParameters(url: string): OddsQueryParameters {
  const params = new URL(url).searchParams;
  return {
    page: parsePositiveInteger(params.get("page"), 1),
    limit: parsePositiveInteger(params.get("limit"), DEFAULT_ODDS_QUERY_LIMIT, MAX_ODDS_QUERY_LIMIT),
    matchId: params.get("matchId") || params.get("match"),
    date: params.get("date"),
    companyId: params.get("companyId") || params.get("company"),
    marketType: params.get("marketType") || params.get("market"),
    snapshotType: params.get("snapshotType"),
    source: params.get("source"),
    from: parseTimestamp(params.get("from") || params.get("startTime")),
    to: parseTimestamp(params.get("to") || params.get("endTime")),
  };
}

export function paginationMetadata(page: number, limit: number, total: number) {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1 && totalPages > 0,
  };
}
