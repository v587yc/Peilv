#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNotExpired, parseStrictUtcRfc3339 } from "./assert-rfc3339-not-expired.mjs";
import { canonicalMigrationContract } from "./migration-contract.mjs";

const RELEASE_ID = /^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function validateDeployPreflight({ manifest, result, env, now = Date.now() }) {
  const expected = {
    releaseId: env.RELEASE_ID,
    commitSha: env.COMMIT_SHA,
    sourceRunId: Number(env.SOURCE_RUN_ID),
    sourceRunAttempt: Number(env.SOURCE_RUN_ATTEMPT),
    sourceArtifactId: Number(env.SOURCE_ARTIFACT_ID),
    archiveSha256: env.ACTUAL_SHA,
    externalManifestSha256: env.EXTERNAL_MANIFEST_SHA,
  };
  for (const key of ["releaseId", "commitSha", "sourceRunId", "sourceRunAttempt", "archiveSha256"]) {
    if (manifest[key] !== expected[key]) throw new Error(`Candidate manifest ${key} mismatch`);
  }
  if (result.schemaVersion !== 1 || result.status !== "passed" || result.phase !== "production-inspection" ||
      result.code !== "OK" || result.exitCode !== 0 || !Array.isArray(result.blockers) || result.blockers.length !== 0) {
    throw new Error("Preflight did not pass production inspection");
  }
  if (result.requestId !== env.REQUEST_ID) throw new Error("Preflight requestId mismatch");
  for (const [key, value] of Object.entries(expected)) {
    if (result.candidate?.[key] !== value) throw new Error(`Preflight ${key} mismatch`);
  }
  if (result.candidate?.headCommitSha !== undefined && result.candidate.headCommitSha !== expected.commitSha) throw new Error("Preflight headCommitSha mismatch");
  if (!SHA256.test(result.candidate?.archiveSha256 || "")) throw new Error("Preflight archive identity is invalid");
  if (!SHA256.test(expected.externalManifestSha256 || "") || result.candidate?.externalManifestSha256 !== expected.externalManifestSha256) throw new Error("External manifest digest mismatch");
  if (!RELEASE_ID.test(result.currentRelease || "")) throw new Error("Expected current release is invalid");
  if (result.hostTcb?.schemaVersion !== 3 ||
      result.hostTcb?.generation !== "host-tcb-v3" ||
      !SHA256.test(result.hostTcb?.manifestSha256 || "") ||
      !SHA256.test(result.hostTcb?.sudoersSha256 || "") ||
      !SHA256.test(result.hostTcb?.migrationContractSha256 || "") ||
      result.hostTcb.generation !== env.HOST_TCB_GENERATION ||
      result.hostTcb.manifestSha256 !== env.HOST_TCB_MANIFEST_SHA ||
      result.hostTcb.sudoersSha256 !== env.HOST_SUDOERS_SHA ||
      result.hostTcb.migrationContractSha256 !== env.HOST_MIGRATION_HELPER_SHA) {
    throw new Error("Preflight Host TCB generation is missing or drifted");
  }

  if (!Array.isArray(result.checks) || result.checks.length === 0) throw new Error("Preflight checks are missing");
  const checkNames = new Set();
  for (const check of result.checks) {
    if (!check || typeof check.name !== "string" || check.name.length === 0 || check.status !== "passed" || checkNames.has(check.name)) {
      throw new Error("Preflight checks are invalid");
    }
    checkNames.add(check.name);
  }
  for (const required of ["current_release", "candidate_app_unit_contract", "migration_ledger", "storage_health"]) {
    if (!checkNames.has(required)) throw new Error(`Required preflight check is missing: ${required}`);
  }

  const checkedAt = parseStrictUtcRfc3339(result.checkedAt);
  const validUntil = parseStrictUtcRfc3339(result.validUntil);
  assertNotExpired(result.validUntil, now);
  if (checkedAt > now + 5 * 60_000 || validUntil <= checkedAt) throw new Error("Preflight validity window is invalid");
  const migrations = result.migrations;
  if (!migrations || !Array.isArray(migrations.applied) || !Array.isArray(migrations.pending) || !Array.isArray(migrations.unknown) || migrations.unknown.length !== 0 || !SHA256.test(migrations.migrationLedgerDigest) || !SHA256.test(migrations.pendingPlanDigest) || typeof migrations.pendingAllCodeRollbackSafe !== "boolean") throw new Error("Preflight migration CAS contract is missing or blocked");
  const canonical = canonicalMigrationContract({ schemaVersion: 1, migrations: manifest.migrations }, migrations.applied);
  if (canonical.unknown.length !== 0 ||
      canonical.migrationLedgerDigest !== migrations.migrationLedgerDigest ||
      canonical.pendingPlanDigest !== migrations.pendingPlanDigest ||
      canonical.pendingAllCodeRollbackSafe !== migrations.pendingAllCodeRollbackSafe ||
      JSON.stringify(canonical.applied) !== JSON.stringify(migrations.applied.map(value => value === "0001_canonical_baseline" ? "0001_production_baseline" : value)) ||
      JSON.stringify(canonical.pending) !== JSON.stringify(migrations.pending)) {
    throw new Error("Preflight migration CAS does not match candidate manifest");
  }
  return { archiveSha256: result.candidate.archiveSha256, externalManifestSha256: result.candidate.externalManifestSha256, currentRelease: result.currentRelease, validUntil: result.validUntil, hostTcbGeneration: result.hostTcb.generation, hostTcbManifestSha256: result.hostTcb.manifestSha256, hostSudoersSha256: result.hostTcb.sudoersSha256, hostMigrationHelperSha256: result.hostTcb.migrationContractSha256, migrationLedgerDigest: migrations.migrationLedgerDigest, pendingPlanDigest: migrations.pendingPlanDigest };
}

function main() {
  const [manifestPath, resultPath] = process.argv.slice(2);
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
  const result = JSON.parse(fs.readFileSync(path.resolve(resultPath), "utf8"));
  const validated = validateDeployPreflight({ manifest, result, env: process.env });
  process.stdout.write(`${validated.archiveSha256}\n${validated.externalManifestSha256}\n${validated.currentRelease}\n${validated.validUntil}\n${validated.hostTcbGeneration}\n${validated.hostTcbManifestSha256}\n${validated.hostSudoersSha256}\n${validated.hostMigrationHelperSha256}\n${validated.migrationLedgerDigest}\n${validated.pendingPlanDigest}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "Preflight validation failed"); process.exitCode = 1; }
}
