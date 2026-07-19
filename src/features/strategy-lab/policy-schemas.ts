import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStrategyJson } from "./normalization";

export const STRATEGY_LAB_POLICY_SCHEMA_VERSION = 1;
export const strategyLabBuildIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const strategyLabHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const strategyLabDateKeySchema = z.string().regex(/^\d{8}$/);
export const strategyLabUuidSchema = z.string().uuid();

// This exact, frozen set is shared with strategy_lab_canonicalize_text() in 0021.
export const STRATEGY_LAB_WHITESPACE_CODE_POINTS = Object.freeze([
  "U+0020", "U+0009", "U+000D", "U+000A", "U+00A0", "U+202F", "U+3000",
] as const);
const FROZEN_WHITESPACE = /[ \t\r\n\u00a0\u202f\u3000]+/gu;

export function normalizeLeagueName(value: string): string {
  return value.normalize("NFC").replace(FROZEN_WHITESPACE, " ").replace(/^ +| +$/gu, "");
}

export function canonicalLeagueSet(values: readonly string[]): readonly string[] {
  const normalized = values.map(normalizeLeagueName);
  if (normalized.some(value => value === "")) throw new TypeError("league policy unavailable");
  const unique = [...new Set(normalized)].sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  if (unique.length === 0) throw new TypeError("league policy unavailable");
  return Object.freeze(unique);
}

export function leaguePolicyHash(leagues: readonly string[]): string {
  const canonical = canonicalLeagueSet(leagues);
  return createHash("sha256").update(stableStrategyJson({
    schemaVersion: STRATEGY_LAB_POLICY_SCHEMA_VERSION,
    mode: "user_focused_leagues",
    leagues: canonical,
  })).digest("hex");
}

export interface StrategyLabPolicyArtifact {
  readonly mode: "user_focused_leagues";
  readonly artifactHash: string;
  readonly captureId: string;
  readonly capturedAt: string;
  readonly datasetCutoffAt: string;
  readonly evidenceHash: string;
}

export interface LeagueHistoryEvidenceEvent {
  readonly id: string;
  readonly contentHash: string;
  readonly action: "add" | "remove";
  readonly league: string;
  readonly source: string;
  readonly sourceObservedAt: string;
  readonly revision: number;
}

export interface LeagueHistoryEvidencePayload {
  readonly schemaVersion: 1;
  readonly baseline: Readonly<{ id: string; contentHash: string; completedAt: string; sourceObservedAt: string }>;
  readonly datasetCutoffAt: string;
  readonly events: readonly Readonly<LeagueHistoryEvidenceEvent>[];
}

export function canonicalLeagueHistoryEvidence(input: LeagueHistoryEvidencePayload): LeagueHistoryEvidencePayload {
  const events = input.events.map(event => Object.freeze({
    ...event,
    league: normalizeLeagueName(event.league),
  })).sort((left, right) => {
    const fields: (keyof LeagueHistoryEvidenceEvent)[] = ["sourceObservedAt", "source", "league", "revision", "id", "contentHash", "action"];
    for (const field of fields) {
      const a = String(left[field]); const b = String(right[field]);
      const compared = Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
      if (compared !== 0) return compared;
    }
    return 0;
  });
  return Object.freeze({ schemaVersion: 1, baseline: Object.freeze({ ...input.baseline }), datasetCutoffAt: input.datasetCutoffAt, events: Object.freeze(events) });
}

export function leagueHistoryEvidenceHash(input: LeagueHistoryEvidencePayload): string {
  return createHash("sha256").update(stableStrategyJson(canonicalLeagueHistoryEvidence(input))).digest("hex");
}
