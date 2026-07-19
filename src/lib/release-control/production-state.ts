import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GitHubWorkflowRun } from "@/lib/github/github-actions-adapter";
import { parseReleaseManifest, type ReleaseManifest } from "./manifest";

const releasePattern = /^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/;
type LedgerEvent = { kind: "deploy" | "rollback"; releaseId: string; previousReleaseId: string; requestId: string; completedAt: string };

export type ProductionReleaseState = {
  currentRelease: string | null;
  previousRelease: string | null;
  installedReleaseIds: string[];
};

export function previousReleaseFromLedger(
  operations: Pick<GitHubWorkflowRun, "display_title" | "status" | "conclusion" | "created_at">[],
  currentRelease: string,
): string | null {
  const events = operations
    .filter(run => run.status === "completed" && run.conclusion === "success")
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const run of events) {
    const rollback = /^Rollback (r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}) to (r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}) · /.exec(run.display_title);
    if (rollback?.[2] === currentRelease) return rollback[1];
    const deploy = /^Deploy (r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}) · /.exec(run.display_title);
    if (deploy?.[1] === currentRelease) {
      const older = events.find(candidate => candidate !== run && (
        /^Deploy (r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}) · /.exec(candidate.display_title)?.[1] ||
        /^Rollback .* to (r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}) · /.exec(candidate.display_title)?.[1]
      ));
      if (!older) return null;
      return /^Deploy (r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}) · /.exec(older.display_title)?.[1]
        || /^Rollback .* to (r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}) · /.exec(older.display_title)?.[1]
        || null;
    }
  }
  return null;
}

function parseLocalLedger(value: unknown, currentRelease: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ledger = value as { schemaVersion?: unknown; events?: unknown };
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.events)) return null;
  const events = ledger.events.filter((event): event is LedgerEvent => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    const row = event as Partial<LedgerEvent>;
    return (row.kind === "deploy" || row.kind === "rollback") &&
      typeof row.releaseId === "string" && releasePattern.test(row.releaseId) &&
      typeof row.previousReleaseId === "string" && releasePattern.test(row.previousReleaseId) &&
      typeof row.requestId === "string" && typeof row.completedAt === "string" && Number.isFinite(Date.parse(row.completedAt));
  }).sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
  return events.find(event => event.releaseId === currentRelease)?.previousReleaseId ?? null;
}

async function loadManifest(releasesRoot: string, releaseId: string): Promise<ReleaseManifest | null> {
  if (!releasePattern.test(releaseId)) return null;
  try {
    const releasePath = path.join(releasesRoot, releaseId);
    if (!(await stat(releasePath)).isDirectory()) return null;
    return parseReleaseManifest(JSON.parse(await readFile(path.join(releasePath, "release-manifest.json"), "utf8")));
  } catch {
    return null;
  }
}

export function isSchemaCompatibleRollback(current: ReleaseManifest, target: ReleaseManifest, applied: Set<string>): boolean {
  const currentMigrations = new Map(current.migrations.map(value => [value.version, value]));
  const targetMigrations = new Map(target.migrations.map(value => [value.version, value]));
  for (const version of applied) if (!currentMigrations.has(version) && !targetMigrations.has(version)) return false;
  for (const [version, migration] of targetMigrations) {
    const installed = currentMigrations.get(version);
    if (!installed || installed.sha256 !== migration.sha256 || !applied.has(version)) return false;
  }
  for (const [version, migration] of currentMigrations) {
    if (!targetMigrations.has(version) && migration.codeRollbackSafe !== true) return false;
  }
  return true;
}

async function appliedMigrations(client: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await client.from("schema_migrations").select("version");
  if (error) throw new Error("无法读取生产 schema ledger");
  return new Set((data || []).map(row => row.version === "0001_canonical_baseline" ? "0001_production_baseline" : String(row.version)));
}

export async function loadProductionReleaseState(input: {
  operations: Pick<GitHubWorkflowRun, "display_title" | "status" | "conclusion" | "created_at">[];
  client: SupabaseClient;
  basePath?: string;
}): Promise<ProductionReleaseState> {
  const base = input.basePath || process.env.PEILV_INSTALL_ROOT || "/opt/peilv";
  const releasesRoot = path.join(base, "releases");
  try {
    const currentPath = await realpath(path.join(base, "current"));
    if (path.dirname(currentPath) !== releasesRoot) return { currentRelease: null, previousRelease: null, installedReleaseIds: [] };
    const currentRelease = path.basename(currentPath);
    const currentManifest = await loadManifest(releasesRoot, currentRelease);
    if (!currentManifest || currentManifest.releaseId !== currentRelease) return { currentRelease: null, previousRelease: null, installedReleaseIds: [] };
    let previousCandidate: string | null = null;
    try {
      previousCandidate = parseLocalLedger(JSON.parse(await readFile(path.join(base, "deployment-ledger.json"), "utf8")), currentRelease);
    } catch {
      // Legacy installations have no trusted local ledger and deliberately expose no rollback target.
    }
    if (!previousCandidate) return { currentRelease, previousRelease: null, installedReleaseIds: [currentRelease] };
    const previousManifest = await loadManifest(releasesRoot, previousCandidate);
    if (!previousManifest || previousManifest.releaseId !== previousCandidate) return { currentRelease, previousRelease: null, installedReleaseIds: [currentRelease] };
    const applied = await appliedMigrations(input.client);
    const compatible = isSchemaCompatibleRollback(currentManifest, previousManifest, applied);
    return {
      currentRelease,
      previousRelease: compatible ? previousCandidate : null,
      installedReleaseIds: compatible ? [currentRelease, previousCandidate] : [currentRelease],
    };
  } catch {
    return { currentRelease: null, previousRelease: null, installedReleaseIds: [] };
  }
}
