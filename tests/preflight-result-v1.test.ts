import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { candidateFromEnvironment, createBlockedResult, loadJson, normalizeRemoteResult, renderMarkdown, validateResult } from "../scripts/preflight-result-v1.mjs";

const exec = promisify(execFile);
const sha = "a".repeat(40);
const env = {
  RELEASE_ID: `r101-a2-${sha.slice(0, 12)}`,
  COMMIT_SHA: sha,
  SOURCE_RUN_ID: "101",
  SOURCE_RUN_ATTEMPT: "2",
  SOURCE_ARTIFACT_ID: "501",
  REQUEST_ID: "123e4567-e89b-42d3-a456-426614174000",
  ARCHIVE_SHA: "b".repeat(64),
};
const fixture = fileURLToPath(new URL("./fixtures/preflight/manifest-relative.json", import.meta.url));
const workflowPath = fileURLToPath(new URL("../.github/workflows/production-preflight.yml", import.meta.url));

function passed() {
  return {
    schemaVersion: 1, status: "passed", requestId: env.REQUEST_ID,
    candidate: { ...candidateFromEnvironment(env), archiveSha256: "b".repeat(64) },
    currentRelease: `r99-a1-${"c".repeat(12)}`, checks: [{ name: "current_release", status: "passed" }], migrations: { applied: [], pending: [], unknown: [] }, blockers: [],
    checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("preflight result v1 manifest loader", () => {
  it("loads a relative fixture without dynamic require", async () => {
    const relative = path.relative(process.cwd(), fixture);
    expect(loadJson(relative).migrations?.[0]?.file).toBe("0001_base.sql");
    const result = await exec(process.execPath, ["scripts/preflight-result-v1.mjs", "manifest-migrations", relative], { cwd: process.cwd() });
    expect(result.stdout).toBe("0001_base.sql=0001_base");
  });
  it("loads an absolute fixture", async () => {
    expect(loadJson(fixture).migrations?.[0]?.version).toBe("0001_base");
    const result = await exec(process.execPath, ["scripts/preflight-result-v1.mjs", "manifest-migrations", fixture], { cwd: process.cwd() });
    expect(result.stdout).toBe("0001_base.sql=0001_base");
  });
});

describe("preflight result v1 failure matrix", () => {
  it.each([
    ["invalid release", "candidate-validation", "CANDIDATE_INPUT_INVALID"],
    ["invalid request", "candidate-validation", "CANDIDATE_INPUT_INVALID"],
    ["source run", "candidate-validation", "SOURCE_RUN_INVALID"],
    ["artifact identity", "candidate-validation", "ARTIFACT_IDENTITY_INVALID"],
    ["artifact download", "candidate-validation", "ARTIFACT_DOWNLOAD_FAILED"],
    ["artifact layout", "candidate-validation", "ARTIFACT_LAYOUT_INVALID"],
    ["artifact content", "candidate-validation", "ARTIFACT_CONTENT_MISSING"],
    ["checksum", "candidate-validation", "CHECKSUM_INVALID"],
    ["manifest missing", "candidate-validation", "MANIFEST_INVALID"],
    ["manifest non-json", "candidate-validation", "MANIFEST_INVALID"],
    ["ssh key", "ssh-configuration", "SSH_CONFIGURATION_FAILED"],
    ["ssh pending", "ssh-configuration", "SSH_CONFIGURATION_PENDING"],
    ["ssh host key", "ssh-configuration", "SSH_CONFIGURATION_FAILED"],
    ["scp", "production-inspection", "SSH_TRANSFER_FAILED"],
    ["remote exit", "production-inspection", "REMOTE_COMMAND_FAILED"],
    ["remote timeout", "production-inspection", "REMOTE_TIMEOUT"],
    ["remote empty", "production-inspection", "REMOTE_NON_JSON"],
    ["remote non-json", "production-inspection", "REMOTE_NON_JSON"],
    ["current release", "production-inspection", "RESULT_INVALID"],
    ["migration shape", "production-inspection", "RESULT_INVALID"],
    ["empty blocker", "production-inspection", "RESULT_INVALID"],
    ["missing expiration", "production-inspection", "RESULT_INVALID"],
    ["expired result", "production-inspection", "RESULT_INVALID"],
  ] as const)("writes valid safe blocked output for %s", (_name, phase, code) => {
    const result = createBlockedResult({ phase, code, exitCode: 1, env });
    expect(validateResult(result)).toBe(true);
    expect(result).toMatchObject({ schemaVersion: 1, status: "blocked", phase, code, exitCode: 1 });
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(/secret=|hostname=|\/opt\/|sudo |command=/i);
    expect(renderMarkdown(result)).toContain("Status: **blocked**");
  });

  it("keeps invalid identity nullable in blocked output", () => {
    const result = createBlockedResult({ phase: "candidate-validation", code: "CANDIDATE_INPUT_INVALID", exitCode: 1, env: { ...env, RELEASE_ID: "bad", REQUEST_ID: "bad" } });
    expect(result.candidate).toBeNull();
    expect(result.requestId).toBeNull();
    expect(validateResult(result)).toBe(true);
  });

  it("redacts production blocker detail while preserving failure", () => {
    const remote = {
      ...passed(), status: "blocked", currentRelease: "/opt/private/release",
      checks: [{ command: "sudo inspect", host: "production.internal" }],
      migrations: { pending: ["secret-command.sql"], applied: [], unknown: [] },
      blockers: ["secret host /opt/private sudo command"], validUntil: null,
    };
    const result = normalizeRemoteResult(remote, env);
    expect(result).toMatchObject({ status: "blocked", phase: "production-inspection", code: "PRODUCTION_BLOCKED", exitCode: 2 });
    expect(JSON.stringify(result)).not.toMatch(/secret|production\.internal|\/opt\/private|sudo|command/i);
    expect(result).toMatchObject({ currentRelease: null, checks: [], migrations: null, validUntil: null });
    expect(validateResult(result)).toBe(true);
  });

  it("preserves passed semantics and validates identity", () => {
    const result = normalizeRemoteResult(passed(), env);
    expect(result).toMatchObject({ status: "passed", phase: "production-inspection", code: "OK", exitCode: 0 });
    expect(validateResult(result)).toBe(true);
  });

  it.each([
    ["requestId", { requestId: "00000000-0000-4000-8000-000000000001" }],
    ["candidate", { candidate: { ...passed().candidate, sourceArtifactId: 999 } }],
    ["validUntil missing", { validUntil: undefined }],
    ["validUntil invalid", { validUntil: "not-a-date" }],
    ["validUntil expired", { validUntil: "2020-01-01T00:00:00.000Z" }],
    ["migration shape", { migrations: { applied: [], pending: null, unknown: [] } }],
    ["blocker", { blockers: ["blocked"] }],
  ] as const)("rejects passed %s mismatch", (_name, change) => {
    expect(() => normalizeRemoteResult({ ...passed(), ...change }, env)).toThrow();
  });

  it("CLI creates both upload files without remote access", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "preflight-result-"));
    const json = path.join(directory, "preflight-result.json");
    const markdown = path.join(directory, "preflight.md");
    await exec(process.execPath, ["scripts/preflight-result-v1.mjs", "blocked", "candidate-validation", "CHECKSUM_INVALID", "1", json], { cwd: process.cwd(), env: { ...process.env, ...env } });
    await exec(process.execPath, ["scripts/preflight-result-v1.mjs", "render", json, markdown], { cwd: process.cwd() });
    expect(validateResult(JSON.parse(await readFile(json, "utf8")))).toBe(true);
    expect(await readFile(markdown, "utf8")).toContain("CHECKSUM_INVALID");
  });

  it("bootstraps files before checkout and always uploads before failing the job", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    expect(workflow.indexOf("Bootstrap guaranteed preflight artifact")).toBeLessThan(workflow.indexOf("actions/checkout@v4"));
    expect(workflow).toMatch(/if: always\(\)\r?\n\s+uses: actions\/upload-artifact@v4/);
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow.indexOf("Upload structured preflight result")).toBeLessThan(workflow.indexOf("Preserve blocked or failed job conclusion"));
  });

  it("maps both transport and remote inspection timeouts to the timeout result", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    expect(workflow).toContain("(( transfer_status == 124 )) && code=REMOTE_TIMEOUT");
    expect(workflow).toMatch(/Timed out waiting for peilv systemd jobs to finish[\s\S]*?exit 124[\s\S]*?remote_status == 124[\s\S]*?REMOTE_TIMEOUT 124/);
  });

  it("advances candidate success before SSH and keeps remote failures structured and redacted", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const candidateSuccess = workflow.indexOf("SSH_CONFIGURATION_PENDING 1 preflight-result.json");
    const ssh = workflow.indexOf("Configure read-only SSH");
    expect(candidateSuccess).toBeGreaterThan(-1);
    expect(candidateSuccess).toBeLessThan(ssh);
    for (const marker of ["SSH_CONFIGURATION_FAILED", "SSH_TRANSFER_FAILED", "REMOTE_COMMAND_FAILED", "REMOTE_NON_JSON"]) {
      expect(workflow).toContain(marker);
    }
    for (const code of ["SSH_CONFIGURATION_FAILED", "SSH_TRANSFER_FAILED", "REMOTE_COMMAND_FAILED", "REMOTE_NON_JSON"] as const) {
      const phase = code === "SSH_CONFIGURATION_FAILED" ? "ssh-configuration" : "production-inspection";
      const result = createBlockedResult({ phase, code, exitCode: 1, env });
      expect(validateResult(result)).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/secret|hostname|stderr|\/opt\/|sudo|command=/i);
    }
  });
});
