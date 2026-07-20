import { describe, expect, it } from "vitest";
import { validateDeployPreflight } from "../scripts/validate-deploy-preflight.mjs";
import { canonicalMigrationContract } from "../scripts/migration-contract.mjs";
import { createHash } from "node:crypto";

const now = Date.now();
const sha = "a".repeat(40);
const archiveSha = "b".repeat(64);
const env = { RELEASE_ID: `r101-a2-${sha.slice(0, 12)}`, COMMIT_SHA: sha, SOURCE_RUN_ID: "101", SOURCE_RUN_ATTEMPT: "2", SOURCE_ARTIFACT_ID: "501", ACTUAL_SHA: archiveSha, REQUEST_ID: "123e4567-e89b-42d3-a456-426614174000",HOST_TCB_GENERATION:"host-tcb-v3",HOST_TCB_MANIFEST_SHA:"1".repeat(64),HOST_SUDOERS_SHA:"2".repeat(64),HOST_MIGRATION_HELPER_SHA:"3".repeat(64) };
const manifestMigrations = [
  { file: "0001_production_baseline.sql", version: "0001_production_baseline", sha256: "d".repeat(64), codeRollbackSafe: true },
  { file: "0002_change.sql", version: "0002_change", sha256: "e".repeat(64), codeRollbackSafe: false },
  { file: "0003_more.sql", version: "0003_more", sha256: "f".repeat(64), codeRollbackSafe: true },
];
const manifest = { releaseId: env.RELEASE_ID, commitSha: sha, sourceRunId: 101, sourceRunAttempt: 2, archiveSha256: archiveSha, migrations: manifestMigrations };
const externalManifestSha = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
Object.assign(env, { EXTERNAL_MANIFEST_SHA: externalManifestSha });
const migrationContract = canonicalMigrationContract({ schemaVersion: 1, migrations: manifestMigrations }, ["0001_canonical_baseline"]);
const requiredChecks = ["current_release", "candidate_app_unit_contract", "migration_ledger", "storage_health"].map(name => ({ name, status: "passed" }));
const result = {
  schemaVersion: 1, status: "passed", phase: "production-inspection", code: "OK", exitCode: 0,
  requestId: env.REQUEST_ID, candidate: { releaseId: env.RELEASE_ID, commitSha: sha, sourceRunId: 101, sourceRunAttempt: 2, sourceArtifactId: 501, archiveSha256: archiveSha, externalManifestSha256: externalManifestSha },
  currentRelease: `r99-a1-${"c".repeat(12)}`, checks: requiredChecks, blockers: [],
  checkedAt: new Date(now - 1_000).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
  migrations: { applied: ["0001_canonical_baseline"], pending: migrationContract.pending, unknown: [], migrationLedgerDigest: migrationContract.migrationLedgerDigest, pendingPlanDigest: migrationContract.pendingPlanDigest, pendingAllCodeRollbackSafe: migrationContract.pendingAllCodeRollbackSafe },
  hostTcb:{schemaVersion:3,generation:env.HOST_TCB_GENERATION,manifestSha256:env.HOST_TCB_MANIFEST_SHA,sudoersSha256:env.HOST_SUDOERS_SHA,migrationContractSha256:env.HOST_MIGRATION_HELPER_SHA},
};

describe("deploy preflight consumer", () => {
  it("accepts a fully bound passed production inspection", () => {
    expect(validateDeployPreflight({ manifest, result, env, now })).toMatchObject({ archiveSha256: archiveSha, externalManifestSha256: externalManifestSha, currentRelease: result.currentRelease, validUntil: result.validUntil,hostTcbGeneration:"host-tcb-v3", migrationLedgerDigest: migrationContract.migrationLedgerDigest, pendingPlanDigest: migrationContract.pendingPlanDigest });
  });

  it.each([
    ["phase", { phase: "candidate-validation" }], ["code", { code: "INITIALIZATION_PENDING" }], ["exit", { exitCode: 1 }],
    ["checkedAt", { checkedAt: "not-a-date" }], ["validity order", { validUntil: new Date(now - 1).toISOString() }],
    ["identity", { candidate: { ...result.candidate, sourceArtifactId: 999 } }], ["checks", { checks: requiredChecks.slice(1) }],
  ])("rejects invalid passed %s", (_name, change) => {
    expect(() => validateDeployPreflight({ manifest, result: { ...result, ...change }, env, now })).toThrow();
  });

  it.each([
    ["ledger digest", { migrationLedgerDigest: "1".repeat(64) }],
    ["plan digest", { pendingPlanDigest: "2".repeat(64) }],
    ["rollback safety", { pendingAllCodeRollbackSafe: true }],
    ["pending order", { pending: [...migrationContract.pending].reverse() }],
    ["unknown", { unknown: ["9999_unknown"] }],
    ["applied", { applied: [] }],
  ])("rejects migration CAS %s mismatch", (_name, migrationChange) => {
    expect(() => validateDeployPreflight({ manifest, result: { ...result, migrations: { ...result.migrations, ...migrationChange } }, env, now })).toThrow();
  });

  it("rejects external manifest raw-byte digest tampering",()=>{expect(()=>validateDeployPreflight({manifest,result:{...result,candidate:{...result.candidate,externalManifestSha256:"0".repeat(64)}},env,now})).toThrow(/externalManifestSha256/);});
});
