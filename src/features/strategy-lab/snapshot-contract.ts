import { createHash } from "node:crypto";
import { stableStrategyJson } from "./normalization";

export const STRATEGY_LAB_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const STRATEGY_LAB_SNAPSHOT_SCHEMA_NAME = "strategy-lab-snapshot-v2" as const;

export type SnapshotHashItem = {
  readonly oddsSnapshotId: number; readonly role: string; readonly companyId: string;
  readonly marketType: string; readonly snapshotType: string;
  readonly sourceObservedAt: string | null; readonly collectedAt: string;
};

export function computeStrategySnapshotSetHash(snapshot: Readonly<Record<string, unknown>>, items: readonly SnapshotHashItem[]): string {
  const ordered = [...items].sort((left, right) => left.oddsSnapshotId - right.oddsSnapshotId || Buffer.compare(Buffer.from(left.role,"utf8"),Buffer.from(right.role,"utf8")));
  return createHash("sha256").update(stableStrategyJson({ snapshot, items: ordered })).digest("hex");
}

export function expectedSnapshotType(checkpoint: "T1215"|"T30"|"T03"): "crown12"|"crown_live" {
  return checkpoint === "T1215" ? "crown12" : "crown_live";
}
