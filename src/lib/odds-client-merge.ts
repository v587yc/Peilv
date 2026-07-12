export interface AiCompanyOdds {
  companyId: string;
  companyName: string;
  openTime: string;
  asianHomeInit: string;
  asianLineInit: string;
  asianAwayInit: string;
  asianHomeLive: string;
  asianLineLive: string;
  asianAwayLive: string;
  euroAsianHomeInit: string;
  euroAsianLineInit: string;
  euroAsianAwayInit: string;
  totalOverInit: string;
  totalLineInit: string;
  totalUnderInit: string;
  euroHomeInit: string;
  euroDrawInit: string;
  euroAwayInit: string;
}

const AI_COMPANY_FIELDS: Array<keyof AiCompanyOdds> = [
  "companyName",
  "openTime",
  "asianHomeInit",
  "asianLineInit",
  "asianAwayInit",
  "asianHomeLive",
  "asianLineLive",
  "asianAwayLive",
  "euroAsianHomeInit",
  "euroAsianLineInit",
  "euroAsianAwayInit",
  "totalOverInit",
  "totalLineInit",
  "totalUnderInit",
  "euroHomeInit",
  "euroDrawInit",
  "euroAwayInit",
];

function firstValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

export function canApplyDatabaseOdds(
  requestStartVersion: number,
  matchRefreshVersion?: number,
  matchPersistedVersion?: number,
): boolean {
  if (!matchRefreshVersion) return true;
  if (!matchPersistedVersion || matchPersistedVersion < matchRefreshVersion) return false;
  return matchPersistedVersion <= requestStartVersion;
}

export function normalizeAiCompanyOdds(company: Record<string, unknown>): AiCompanyOdds {
  return {
    companyId: firstValue(company.companyId),
    companyName: firstValue(company.companyName),
    openTime: firstValue(company.openTime),
    asianHomeInit: firstValue(company.ftHandicapHome, company.asianHomeInit),
    asianLineInit: firstValue(company.ftHandicapLine, company.asianLineInit),
    asianAwayInit: firstValue(company.ftHandicapAway, company.asianAwayInit),
    asianHomeLive: firstValue(company.ftHandicapHomeLive, company.asianHomeLive),
    asianLineLive: firstValue(company.ftHandicapLineLive, company.asianLineLive),
    asianAwayLive: firstValue(company.ftHandicapAwayLive, company.asianAwayLive),
    euroAsianHomeInit: firstValue(company.euroAsianHome, company.euroAsianHomeInit),
    euroAsianLineInit: firstValue(company.euroAsianLine, company.euroAsianLineInit),
    euroAsianAwayInit: firstValue(company.euroAsianAway, company.euroAsianAwayInit),
    totalOverInit: firstValue(company.ftTotalOver, company.totalOverInit),
    totalLineInit: firstValue(company.ftTotalLine, company.totalLineInit),
    totalUnderInit: firstValue(company.ftTotalUnder, company.totalUnderInit),
    euroHomeInit: firstValue(company.euroHome, company.euroHomeInit),
    euroDrawInit: firstValue(company.euroDraw, company.euroDrawInit),
    euroAwayInit: firstValue(company.euroAway, company.euroAwayInit),
  };
}

export function mergeAiCompanyOdds(
  memoryCompanies: ReadonlyArray<Record<string, unknown>>,
  databaseCompanies: ReadonlyArray<Record<string, unknown>>,
): AiCompanyOdds[] {
  const databaseById = new Map(
    databaseCompanies.map((company) => {
      const normalized = normalizeAiCompanyOdds(company);
      return [normalized.companyId, normalized] as const;
    }),
  );
  const merged: AiCompanyOdds[] = [];
  const used = new Set<string>();

  for (const company of memoryCompanies) {
    const memory = normalizeAiCompanyOdds(company);
    const database = databaseById.get(memory.companyId);
    const result = { ...memory };
    if (database) {
      for (const field of AI_COMPANY_FIELDS) {
        result[field] = firstValue(memory[field], database[field]);
      }
    }
    merged.push(result);
    used.add(memory.companyId);
  }

  for (const company of databaseCompanies) {
    const normalized = normalizeAiCompanyOdds(company);
    if (!used.has(normalized.companyId)) merged.push(normalized);
  }

  return merged;
}
