#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE_ID = /^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PHASES = new Set(["candidate-validation", "ssh-configuration", "production-inspection"]);
const SAFE_BLOCKERS = Object.freeze({
  CANDIDATE_INPUT_INVALID: "Candidate inputs are invalid",
  SOURCE_RUN_INVALID: "Candidate source run validation failed",
  ARTIFACT_IDENTITY_INVALID: "Candidate artifact validation failed",
  ARTIFACT_DOWNLOAD_FAILED: "Candidate artifact download failed",
  ARTIFACT_LAYOUT_INVALID: "Candidate artifact layout is invalid",
  ARTIFACT_CONTENT_MISSING: "Candidate artifact content is missing",
  CHECKSUM_INVALID: "Candidate checksum validation failed",
  MANIFEST_INVALID: "Candidate manifest validation failed",
  SSH_CONFIGURATION_PENDING: "Candidate checks passed; read-only SSH configuration is pending",
  SSH_CONFIGURATION_FAILED: "Read-only SSH configuration failed",
  SSH_TRANSFER_FAILED: "Production inspection transfer failed",
  REMOTE_COMMAND_FAILED: "Production inspection command failed",
  REMOTE_TIMEOUT: "Production inspection timed out",
  REMOTE_NON_JSON: "Production inspection returned an invalid result",
  PRODUCTION_BLOCKED: "Production inspection reported one or more blockers",
  RESULT_INVALID: "Production inspection result validation failed",
  INITIALIZATION_PENDING: "Production preflight has not completed candidate validation",
});

export function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function nullableString(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function candidateFromEnvironment(env = process.env) {
  const releaseId = nullableString(env.RELEASE_ID, RELEASE_ID);
  const commitSha = nullableString(env.COMMIT_SHA, SHA);
  const sourceRunId = positiveInteger(env.SOURCE_RUN_ID);
  const sourceRunAttempt = positiveInteger(env.SOURCE_RUN_ATTEMPT);
  const sourceArtifactId = positiveInteger(env.SOURCE_ARTIFACT_ID);
  if (!releaseId || !commitSha || !sourceRunId || !sourceRunAttempt || !sourceArtifactId) return null;
  if (releaseId !== `r${sourceRunId}-a${sourceRunAttempt}-${commitSha.slice(0, 12)}`) return null;
  return { releaseId, commitSha, sourceRunId, sourceRunAttempt, sourceArtifactId };
}

export function createBlockedResult({ phase, code, exitCode, env = process.env }) {
  if (!PHASES.has(phase)) throw new Error("Invalid preflight phase");
  if (!(code in SAFE_BLOCKERS)) throw new Error("Invalid preflight blocker code");
  const normalizedExitCode = Number(exitCode);
  if (!Number.isSafeInteger(normalizedExitCode) || normalizedExitCode === 0) throw new Error("Blocked exitCode must be non-zero");
  return {
    schemaVersion: 1,
    status: "blocked",
    phase,
    code,
    exitCode: normalizedExitCode,
    requestId: nullableString(env.REQUEST_ID, UUID),
    candidate: candidateFromEnvironment(env),
    currentRelease: null,
    checks: [],
    migrations: null,
    blockers: [SAFE_BLOCKERS[code]],
    checkedAt: new Date().toISOString(),
    validUntil: null,
  };
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function normalizeRemoteResult(remote, env = process.env) {
  if (!remote || typeof remote !== "object" || remote.schemaVersion !== 1 || !["passed", "blocked"].includes(remote.status)) {
    throw new Error("Invalid remote preflight result");
  }
  const expectedCandidate = candidateFromEnvironment(env);
  if (!expectedCandidate || nullableString(env.REQUEST_ID, UUID) === null) throw new Error("Invalid expected preflight identity");
  for (const [key, value] of Object.entries(expectedCandidate)) {
    if (remote.candidate?.[key] !== value) throw new Error(`Remote candidate ${key} mismatch`);
  }
  if (!SHA256.test(env.ARCHIVE_SHA || "") || remote.candidate?.archiveSha256 !== env.ARCHIVE_SHA) throw new Error("Remote candidate archiveSha256 mismatch");
  if (remote.requestId !== env.REQUEST_ID) throw new Error("Remote requestId mismatch");
  if (remote.status === "passed") {
    if (!RELEASE_ID.test(remote.currentRelease || "")) throw new Error("Invalid current release");
    if (!Array.isArray(remote.blockers) || remote.blockers.length !== 0) throw new Error("Passed result contains blockers");
    if (!Array.isArray(remote.checks) || remote.checks.length === 0 || remote.checks.some(check => !check || typeof check.name !== "string" || check.status !== "passed") ||
        !remote.migrations || !["applied", "pending", "unknown"].every(key => Array.isArray(remote.migrations[key])) ||
        (("migrationLedgerDigest" in remote.migrations || "pendingPlanDigest" in remote.migrations || "pendingAllCodeRollbackSafe" in remote.migrations) &&
          (!SHA256.test(remote.migrations.migrationLedgerDigest || "") || !SHA256.test(remote.migrations.pendingPlanDigest || "") || typeof remote.migrations.pendingAllCodeRollbackSafe !== "boolean"))) throw new Error("Invalid inspection details");
    if (!validIso(remote.checkedAt) || Date.parse(remote.checkedAt) > Date.now() + 5 * 60_000) throw new Error("Invalid checkedAt");
    if (!validIso(remote.validUntil) || Date.parse(remote.validUntil) <= Date.now()) throw new Error("Invalid validUntil");
    return { ...remote, phase: "production-inspection", code: "OK", exitCode: 0 };
  }
  return createBlockedResult({
    phase: "production-inspection",
    code: "PRODUCTION_BLOCKED",
    exitCode: 2,
    env,
  });
}

export function validateResult(result) {
  if (!result || result.schemaVersion !== 1 || !["passed", "blocked"].includes(result.status)) return false;
  if (!PHASES.has(result.phase) || typeof result.code !== "string" || !Number.isSafeInteger(result.exitCode)) return false;
  if (result.status === "blocked") {
    return result.exitCode !== 0 && Array.isArray(result.blockers) && result.blockers.length > 0 &&
      result.blockers.every(value => Object.values(SAFE_BLOCKERS).includes(value));
  }
  const migrationExtensionValid = !result.migrations || !("migrationLedgerDigest" in result.migrations || "pendingPlanDigest" in result.migrations || "pendingAllCodeRollbackSafe" in result.migrations) ||
    (SHA256.test(result.migrations.migrationLedgerDigest || "") && SHA256.test(result.migrations.pendingPlanDigest || "") && typeof result.migrations.pendingAllCodeRollbackSafe === "boolean");
  return result.code === "OK" && result.exitCode === 0 && migrationExtensionValid && Array.isArray(result.blockers) && result.blockers.length === 0 &&
    nullableString(result.requestId, UUID) !== null && candidateIsValid(result.candidate) &&
    RELEASE_ID.test(result.currentRelease || "") && Array.isArray(result.checks) && result.checks.length > 0 &&
    result.checks.every(check => check && typeof check.name === "string" && check.status === "passed") &&
    validIso(result.checkedAt) && Date.parse(result.checkedAt) <= Date.now() + 5 * 60_000 &&
    validIso(result.validUntil) && Date.parse(result.validUntil) > Date.now() && Date.parse(result.validUntil) > Date.parse(result.checkedAt);
}

function candidateIsValid(candidate) {
  if (!candidate || typeof candidate !== "object") return false;
  const { releaseId, commitSha, sourceRunId, sourceRunAttempt, sourceArtifactId, archiveSha256, externalManifestSha256 } = candidate;
  return RELEASE_ID.test(releaseId || "") && SHA.test(commitSha || "") &&
    releaseId === `r${sourceRunId}-a${sourceRunAttempt}-${commitSha.slice(0, 12)}` &&
    [sourceRunId, sourceRunAttempt, sourceArtifactId].every(value => Number.isSafeInteger(value) && value > 0) &&
    SHA256.test(archiveSha256 || "") && (externalManifestSha256 === undefined || SHA256.test(externalManifestSha256));
}

export function renderMarkdown(result) {
  const candidate = result.candidate;
  const lines = [
    "## Production preflight",
    "",
    `- Status: **${result.status}**`,
    `- Phase: \`${result.phase}\``,
    `- Code: \`${result.code}\``,
    `- Exit code: \`${result.exitCode}\``,
  ];
  if (candidate) lines.push(`- Release: \`${candidate.releaseId}\``, `- Commit: \`${candidate.commitSha}\``);
  if (result.currentRelease) lines.push(`- Current release: \`${result.currentRelease}\``);
  lines.push(`- Blockers: ${result.blockers.map(value => `\`${value}\``).join(", ") || "none"}`);
  return `${lines.join("\n")}\n`;
}

function writeResult(result, output = "preflight-result.json") {
  if (!validateResult(result)) throw new Error("Refusing to write invalid preflight result");
  fs.writeFileSync(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "manifest-migrations") {
    const manifest = loadJson(args[0]);
    if (!Array.isArray(manifest.migrations)) throw new Error("Migration manifest is invalid");
    process.stdout.write(manifest.migrations.map(item => `${item.file}=${item.version}`).join(","));
    return;
  }
  if (command === "blocked") {
    writeResult(createBlockedResult({ phase: args[0], code: args[1], exitCode: Number(args[2]) }), args[3]);
    return;
  }
  if (command === "normalize-remote") {
    writeResult(normalizeRemoteResult(loadJson(args[0])), args[1]);
    return;
  }
  if (command === "validate") {
    if (!validateResult(loadJson(args[0]))) process.exitCode = 1;
    return;
  }
  if (command === "render") {
    const result = loadJson(args[0]);
    if (!validateResult(result)) throw new Error("Invalid preflight result");
    fs.writeFileSync(path.resolve(args[1]), renderMarkdown(result), { mode: 0o600 });
    return;
  }
  throw new Error("Unknown preflight result command");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "Preflight result formatter failed"); process.exitCode = 1; }
}
