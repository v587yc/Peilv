#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_ID = /^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function iso(value, label) {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) throw new Error(`${label} is missing or invalid`);
  return time;
}

export function validateDeployPreflight({ manifest, result, env, now = Date.now() }) {
  const expected = {
    releaseId: env.RELEASE_ID,
    commitSha: env.COMMIT_SHA,
    sourceRunId: Number(env.SOURCE_RUN_ID),
    sourceRunAttempt: Number(env.SOURCE_RUN_ATTEMPT),
    sourceArtifactId: Number(env.SOURCE_ARTIFACT_ID),
    archiveSha256: env.ACTUAL_SHA,
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
  if (!RELEASE_ID.test(result.currentRelease || "")) throw new Error("Expected current release is invalid");

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

  const checkedAt = iso(result.checkedAt, "Preflight checkedAt");
  const validUntil = iso(result.validUntil, "Preflight validUntil");
  if (checkedAt > now + 5 * 60_000 || validUntil <= now || validUntil <= checkedAt) throw new Error("Preflight validity window is invalid");
  return { archiveSha256: result.candidate.archiveSha256, currentRelease: result.currentRelease };
}

function main() {
  const [manifestPath, resultPath] = process.argv.slice(2);
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
  const result = JSON.parse(fs.readFileSync(path.resolve(resultPath), "utf8"));
  const validated = validateDeployPreflight({ manifest, result, env: process.env });
  process.stdout.write(`${validated.archiveSha256}\n${validated.currentRelease}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "Preflight validation failed"); process.exitCode = 1; }
}
