import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parseMigrationManifest,
  parseReleaseManifest,
} from "@/lib/release-control/manifest";

const migration = {
  file: "0007_weighted_learning_samples.sql",
  version: "0007_weighted_learning_samples",
  sha256: "a".repeat(64),
  codeRollbackSafe: true,
};

const release = {
  schemaVersion: 1,
  repositoryId: 123,
  repository: "owner/repo",
  commitSha: `${"a".repeat(12)}${"b".repeat(28)}`,
  releaseId: `r123-a1-${"a".repeat(12)}`,
  sourceRunId: 123,
  sourceRunAttempt: 1,
  buildId: "build-id",
  archiveFile: `peilv-r123-a1-${"a".repeat(12)}.tar.gz`,
  archiveSha256: "c".repeat(64),
  createdAt: "2026-07-13T10:00:00Z",
  migrations: [migration],
  files: [{ path: "server.js", sha256: "d".repeat(64) }],
};

describe("release manifest", () => {
  it("accepts a fully bound release", () => {
    expect(parseReleaseManifest(release)).toEqual(release);
  });

  it("rejects mismatched release provenance", () => {
    expect(() => parseReleaseManifest({ ...release, commitSha: "d".repeat(40) })).toThrow();
    expect(() => parseReleaseManifest({ ...release, archiveFile: "peilv-r999-a1-aaaaaaaaaaaa.tar.gz" })).toThrow();
  });

  it("accepts a null archive checksum inside the archive", () => {
    expect(parseReleaseManifest({ ...release, archiveSha256: null }).archiveSha256).toBeNull();
  });

  it("binds every migration manifest checksum to its on-disk file", async () => {
    const manifest = parseMigrationManifest(JSON.parse(await readFile(new URL("../migrations/manifest.json", import.meta.url), "utf8")));
    for (const entry of manifest.migrations) {
      const sql = await readFile(new URL(`../migrations/${entry.file}`, import.meta.url));
      expect(createHash("sha256").update(sql).digest("hex"), entry.file).toBe(entry.sha256);
    }
  });

  it("keeps the administrator migration chain ordered and blocks rollback before uniform admission", async () => {
    const manifest = parseMigrationManifest(JSON.parse(await readFile(new URL("../migrations/manifest.json", import.meta.url), "utf8")));
    expect(manifest.migrations.filter(entry => /^00(09|1[0-9])_/.test(entry.file)).map(entry => entry.file)).toEqual([
      "0009_admin_identity.sql",
      "0010_admin_identity_guardrails.sql",
      "0011_admin_login_rate_limit.sql",
      "0012_admin_login_reservations.sql",
      "0013_admin_user_optimistic_concurrency.sql",
      "0014_admin_login_uniform_reservations.sql",
      "0015_admin_lifecycle_strong_audit.sql",
      "0016_atomic_backtest_claim.sql",
      "0017_management_command_recovery_states.sql",
      "0018_command_audit_and_backtest_leases.sql",
      "0019_backtest_owner_fenced_persistence.sql",
    ]);
    expect(new Set(manifest.migrations.map(entry => entry.version)).size).toBe(manifest.migrations.length);
    expect(new Set(manifest.migrations.map(entry => entry.file)).size).toBe(manifest.migrations.length);
    expect(manifest.migrations.find(entry => entry.version === "0014_admin_login_uniform_reservations")?.codeRollbackSafe).toBe(false);
    expect(manifest.migrations.find(entry => entry.version === "0018_command_audit_and_backtest_leases")?.codeRollbackSafe).toBe(false);
    expect(manifest.migrations.find(entry => entry.version === "0019_backtest_owner_fenced_persistence")?.codeRollbackSafe).toBe(false);
  });

  it("rejects duplicate migration identities", () => {
    expect(() => parseMigrationManifest({
      schemaVersion: 1,
      migrations: [migration, { ...migration, sha256: "d".repeat(64) }],
    })).toThrow(/Duplicate migration/);
  });
});
