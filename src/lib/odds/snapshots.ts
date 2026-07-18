import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { stableCanonicalJson } from "@/lib/canonical-json";

export const ODDS_SNAPSHOT_HASH_VERSION = "canonical-json-v2" as const;

export type OddsWritePayload = {
  oddsData?: Record<string, unknown>;
  openTimesData?: Record<string, unknown>;
  crownLiveOdds?: Record<string, unknown>;
  crown12Odds?: Record<string, unknown>;
};

type SnapshotCandidate = {
  companyId: string;
  marketType: string;
  snapshotType: string;
  rawPayload: Record<string, unknown>;
  qualityPayload: Record<string, unknown>;
  requiredFields: string[];
};

const COMPANY_MARKETS = [
  {
    marketType: "asian_handicap",
    requiredFields: ["companyId", "companyName", "ftHandicapHome", "ftHandicapLine", "ftHandicapAway"],
  },
  {
    marketType: "europe_1x2",
    requiredFields: ["companyId", "companyName", "euroHome", "euroDraw", "euroAway"],
  },
  {
    marketType: "total",
    requiredFields: ["companyId", "companyName", "ftTotalOver", "ftTotalLine", "ftTotalUnder"],
  },
] as const;

const CROWN_MARKETS = [
  {
    marketType: "asian_handicap",
    requiredFields: ["handicapHome", "handicapLine", "handicapAway"],
  },
  {
    marketType: "total",
    requiredFields: ["totalOver", "totalLine", "totalUnder"],
  },
] as const;

const STALE_SOURCE_MS = 15 * 60 * 1000;

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function buildCandidates(payload: OddsWritePayload): SnapshotCandidate[] {
  const candidates: SnapshotCandidate[] = [];
  const oddsData = asRecord(payload.oddsData);
  const companies = Array.isArray(oddsData?.companies) ? oddsData.companies : [];

  for (const value of companies) {
    const company = asRecord(value);
    if (!company) continue;
    for (const market of COMPANY_MARKETS) {
      candidates.push({
        companyId: String(company.companyId || "unknown"),
        marketType: market.marketType,
        snapshotType: "odds",
        rawPayload: oddsData!,
        qualityPayload: company,
        requiredFields: [...market.requiredFields],
      });
    }
  }

  if (oddsData && companies.length === 0) {
    candidates.push({
      companyId: "*",
      marketType: "combined",
      snapshotType: "odds",
      rawPayload: oddsData,
      qualityPayload: oddsData,
      requiredFields: ["matchId", "companies"],
    });
  }

  const openTimes = asRecord(payload.openTimesData);
  if (openTimes) {
    for (const [companyId, openTime] of Object.entries(openTimes)) {
      candidates.push({
        companyId,
        marketType: "metadata",
        snapshotType: "open_times",
        rawPayload: openTimes,
        qualityPayload: { companyId, openTime },
        requiredFields: ["companyId", "openTime"],
      });
    }
  }

  const crown12 = asRecord(payload.crown12Odds);
  if (crown12) {
    for (const market of CROWN_MARKETS) {
      candidates.push({
        companyId: "3",
        marketType: market.marketType,
        snapshotType: "crown12",
        rawPayload: crown12,
        qualityPayload: crown12,
        requiredFields: [...market.requiredFields],
      });
    }
  }

  const crownLive = asRecord(payload.crownLiveOdds);
  if (crownLive) {
    for (const market of CROWN_MARKETS) {
      candidates.push({
        companyId: "3",
        marketType: market.marketType,
        snapshotType: "crown_live",
        rawPayload: crownLive,
        qualityPayload: crownLive,
        requiredFields: [...market.requiredFields],
      });
    }
  }

  return candidates;
}

function parseObservedAt(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function appendOddsSnapshots(
  supabase: SupabaseClient,
  input: {
    matchId: string;
    matchDate: string;
    source?: unknown;
    sourceObservedAt?: unknown;
    payload: OddsWritePayload;
  },
): Promise<{ snapshots: number; qualityRecords: number }> {
  const candidates = buildCandidates(input.payload);
  if (candidates.length === 0) return { snapshots: 0, qualityRecords: 0 };

  const capturedAt = new Date();
  const capturedAtIso = capturedAt.toISOString();
  const observedAt = parseObservedAt(input.sourceObservedAt);
  const source = typeof input.source === "string" && input.source.trim()
    ? input.source.trim().slice(0, 100)
    : "odds-db";

  const snapshotRows = candidates.map((candidate) => {
    const canonicalContent = stableCanonicalJson(candidate.rawPayload);
    const contentHash = createHash("sha256").update(canonicalContent, "utf8").digest("hex");
    return {
      match_id: input.matchId,
      match_date: input.matchDate,
      company_id: candidate.companyId,
      market_type: candidate.marketType,
      snapshot_type: candidate.snapshotType,
      source,
      odds: JSON.parse(canonicalContent) as Record<string, unknown>,
      source_observed_at: observedAt?.toISOString() ?? null,
      collected_at: capturedAtIso,
      content_hash: contentHash,
      hash_version: ODDS_SNAPSHOT_HASH_VERSION,
      canonical_content_hash: contentHash,
      idempotency_key: `${input.matchId}:${input.matchDate}:${candidate.snapshotType}:${candidate.companyId}:${candidate.marketType}:${ODDS_SNAPSHOT_HASH_VERSION}:${capturedAtIso}:${randomUUID()}`,
    };
  });

  const qualityRows = candidates.map((candidate) => {
    const missingFields = candidate.requiredFields.filter((field) => !isPresent(candidate.qualityPayload[field]));
    const completenessScore = candidate.requiredFields.length === 0
      ? 1
      : (candidate.requiredFields.length - missingFields.length) / candidate.requiredFields.length;
    const issueCodes: string[] = [];
    const reasons: string[] = [];
    let latencyMs: number | null = null;

    if (missingFields.length > 0) {
      issueCodes.push("MISSING_FIELDS");
      reasons.push(`missing ${missingFields.join(", ")}`);
    }
    if (observedAt) {
      const rawLatencyMs = Math.round(capturedAt.getTime() - observedAt.getTime());
      latencyMs = Math.max(-2_147_483_648, Math.min(2_147_483_647, rawLatencyMs));
      if (rawLatencyMs < 0) {
        issueCodes.push("FUTURE_SOURCE_TIMESTAMP");
        reasons.push("source timestamp is later than capture time");
      } else if (rawLatencyMs > STALE_SOURCE_MS) {
        issueCodes.push("STALE_SOURCE");
        reasons.push(`source latency exceeds ${STALE_SOURCE_MS}ms`);
      }
    } else if (input.sourceObservedAt !== undefined) {
      issueCodes.push("INVALID_SOURCE_TIMESTAMP");
      reasons.push("source timestamp is invalid");
    }

    return {
      entity_type: "odds_snapshot",
      entity_id: `${input.matchId}:${candidate.companyId}:${candidate.snapshotType}`,
      date_key: input.matchDate,
      dimension: candidate.marketType,
      status: issueCodes.length === 0 ? "ok" : completenessScore === 0 ? "error" : "warning",
      completeness_score: completenessScore,
      source,
      source_observed_at: observedAt?.toISOString() ?? null,
      latency_ms: latencyMs,
      issue_codes: issueCodes,
      details: {
        matchId: input.matchId,
        companyId: candidate.companyId,
        marketType: candidate.marketType,
        snapshotType: candidate.snapshotType,
        missingFields,
        reasons,
        capturedAt: capturedAtIso,
      },
      checked_at: capturedAtIso,
    };
  });

  const { error: snapshotError } = await supabase.from("odds_snapshots").insert(snapshotRows);
  if (snapshotError) throw new Error(`snapshot insert failed: ${snapshotError.message}`);

  const { error: qualityError } = await supabase.from("data_quality_records").insert(qualityRows);
  if (qualityError) throw new Error(`quality insert failed: ${qualityError.message}`);

  return { snapshots: snapshotRows.length, qualityRecords: qualityRows.length };
}
