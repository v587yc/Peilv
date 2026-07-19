import type { ReleaseManifest } from "@/lib/release-control/manifest";

export type RollbackCompatibility = {
  allowed: boolean;
  blockers: string[];
  missingFromTarget: string[];
  unknownApplied: string[];
};

export function evaluateRollbackCompatibility(input: {
  current: ReleaseManifest;
  target: ReleaseManifest;
  appliedVersions: string[];
}): RollbackCompatibility {
  const blockers: string[] = [];
  const currentByVersion = new Map(input.current.migrations.map(value => [value.version, value]));
  const targetByVersion = new Map(input.target.migrations.map(value => [value.version, value]));
  const knownVersions = new Set([...currentByVersion.keys(), ...targetByVersion.keys()]);
  const applied = new Set(input.appliedVersions.map(value => value === "0001_canonical_baseline" ? "0001_production_baseline" : value));

  const unknownApplied = [...applied].filter(value => !knownVersions.has(value));
  if (unknownApplied.length) blockers.push("数据库包含两个 release manifest 均未知的 migration");

  for (const [version, targetMigration] of targetByVersion) {
    const currentMigration = currentByVersion.get(version);
    if (!currentMigration) blockers.push(`目标 migration 不存在于当前 release: ${version}`);
    else if (currentMigration.sha256 !== targetMigration.sha256) blockers.push(`共有 migration SHA 冲突: ${version}`);
    if (!applied.has(version)) blockers.push(`目标 release 所需 migration 尚未应用: ${version}`);
  }

  const missingFromTarget = [...currentByVersion.keys()].filter(version => !targetByVersion.has(version));
  for (const version of missingFromTarget) {
    const migration = currentByVersion.get(version);
    if (!migration?.codeRollbackSafe) blockers.push(`migration 未声明 code-only rollback 安全: ${version}`);
  }

  return { allowed: blockers.length === 0, blockers, missingFromTarget, unknownApplied };
}
