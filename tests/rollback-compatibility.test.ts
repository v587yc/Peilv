import { describe, expect, it } from "vitest";
import type { ReleaseManifest } from "@/lib/release-control/manifest";
import { evaluateRollbackCompatibility } from "@/lib/release-control/rollback-compatibility";

const migration = (version: string, safe = true, sha = version.padEnd(64, "a").slice(0, 64)) => ({
  file: `${version}.sql`, version, sha256: sha, codeRollbackSafe: safe,
});
const manifest = (releaseId: string, migrations: ReturnType<typeof migration>[]): ReleaseManifest => ({
  schemaVersion: 1,
  repositoryId: 1,
  repository: "v587yc/Peilv",
  commitSha: `${releaseId.slice(-12)}${"a".repeat(28)}`,
  releaseId,
  sourceRunId: Number(releaseId.match(/^r(\d+)/)?.[1]),
  sourceRunAttempt: 1,
  buildId: "build",
  archiveFile: `peilv-${releaseId}.tar.gz`,
  archiveSha256: "b".repeat(64),
  createdAt: new Date(0).toISOString(),
  migrations,
  files: [{ path: "server.js", sha256: "c".repeat(64) }],
});

const currentId = `r20-a1-${"a".repeat(12)}`;
const targetId = `r10-a1-${"b".repeat(12)}`;

describe("rollback compatibility", () => {
  it("allows code rollback across explicitly safe additive migrations", () => {
    const first = migration("0001_base");
    const second = migration("0002_additive", true);
    expect(evaluateRollbackCompatibility({
      current: manifest(currentId, [first, second]),
      target: manifest(targetId, [first]),
      appliedVersions: [first.version, second.version],
    })).toEqual(expect.objectContaining({ allowed: true, missingFromTarget: [second.version] }));
  });

  it("blocks unsafe newer migrations", () => {
    const first = migration("0001_base");
    const unsafe = migration("0002_destructive", false);
    const result = evaluateRollbackCompatibility({
      current: manifest(currentId, [first, unsafe]),
      target: manifest(targetId, [first]),
      appliedVersions: [first.version, unsafe.version],
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers.join(" ")).toContain("未声明");
  });

  it("blocks unknown database migrations and shared SHA conflicts", () => {
    const current = migration("0001_base", true, "a".repeat(64));
    const target = migration("0001_base", true, "b".repeat(64));
    const result = evaluateRollbackCompatibility({
      current: manifest(currentId, [current]),
      target: manifest(targetId, [target]),
      appliedVersions: [current.version, "9999_unknown"],
    });
    expect(result.allowed).toBe(false);
    expect(result.unknownApplied).toEqual(["9999_unknown"]);
    expect(result.blockers.join(" ")).toContain("SHA 冲突");
  });

  it("blocks rollback when target-required migration is not applied", () => {
    const required = migration("0001_base");
    const result = evaluateRollbackCompatibility({
      current: manifest(currentId, [required]),
      target: manifest(targetId, [required]),
      appliedVersions: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers.join(" ")).toContain("尚未应用");
  });
});
