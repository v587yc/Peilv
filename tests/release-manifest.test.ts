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

  it("rejects duplicate migration identities", () => {
    expect(() => parseMigrationManifest({
      schemaVersion: 1,
      migrations: [migration, { ...migration, sha256: "d".repeat(64) }],
    })).toThrow(/Duplicate migration/);
  });
});
