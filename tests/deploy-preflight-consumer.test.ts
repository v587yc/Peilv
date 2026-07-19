import { describe, expect, it } from "vitest";
import { validateDeployPreflight } from "../scripts/validate-deploy-preflight.mjs";

const now = Date.now();
const sha = "a".repeat(40);
const archiveSha = "b".repeat(64);
const env = { RELEASE_ID: `r101-a2-${sha.slice(0, 12)}`, COMMIT_SHA: sha, SOURCE_RUN_ID: "101", SOURCE_RUN_ATTEMPT: "2", SOURCE_ARTIFACT_ID: "501", ACTUAL_SHA: archiveSha, REQUEST_ID: "123e4567-e89b-42d3-a456-426614174000" };
const manifest = { releaseId: env.RELEASE_ID, commitSha: sha, sourceRunId: 101, sourceRunAttempt: 2, archiveSha256: archiveSha };
const requiredChecks = ["current_release", "candidate_app_unit_contract", "migration_ledger", "storage_health"].map(name => ({ name, status: "passed" }));
const result = {
  schemaVersion: 1, status: "passed", phase: "production-inspection", code: "OK", exitCode: 0,
  requestId: env.REQUEST_ID, candidate: { releaseId: env.RELEASE_ID, commitSha: sha, sourceRunId: 101, sourceRunAttempt: 2, sourceArtifactId: 501, archiveSha256: archiveSha },
  currentRelease: `r99-a1-${"c".repeat(12)}`, checks: requiredChecks, blockers: [],
  checkedAt: new Date(now - 1_000).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
};

describe("deploy preflight consumer", () => {
  it("accepts a fully bound passed production inspection", () => {
    expect(validateDeployPreflight({ manifest, result, env, now })).toEqual({ archiveSha256: archiveSha, currentRelease: result.currentRelease });
  });

  it.each([
    ["phase", { phase: "candidate-validation" }], ["code", { code: "INITIALIZATION_PENDING" }], ["exit", { exitCode: 1 }],
    ["checkedAt", { checkedAt: "not-a-date" }], ["validity order", { validUntil: new Date(now - 1).toISOString() }],
    ["identity", { candidate: { ...result.candidate, sourceArtifactId: 999 } }], ["checks", { checks: requiredChecks.slice(1) }],
  ])("rejects invalid passed %s", (_name, change) => {
    expect(() => validateDeployPreflight({ manifest, result: { ...result, ...change }, env, now })).toThrow();
  });
});
