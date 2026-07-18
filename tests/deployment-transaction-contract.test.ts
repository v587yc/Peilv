import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const executableLines = (script: string): string[] => script.split(String.fromCharCode(10)).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
const candidateStart = (script: string): number => script.indexOf("candidate_start", script.indexOf("candidate_started_at="));

describe("production deployment transaction contract", () => {
  it("scopes the manual main-only immutable preflight inspection to production", async () => {
    const workflow = await read(".github/workflows/production-preflight.yml");
    const inspectJob = workflow.slice(workflow.indexOf("  inspect-production:"));
    expect(workflow).toContain("  workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s{2}(?:push|pull_request|schedule):/m);
    expect(inspectJob).toMatch(/inspect-production:\n\s+runs-on: ubuntu-latest\n\s+timeout-minutes: 20\n\s+environment: production\n\s+steps:/);
    expect(inspectJob).toContain('run.head_branch !== "main"');
    expect(inspectJob).toContain('run.event !== "push"');
    expect(inspectJob).toContain("artifact.workflow_run?.id !== Number(process.env.SOURCE_RUN_ID)");
    expect(inspectJob).toContain("artifact.workflow_run?.head_sha !== process.env.COMMIT_SHA");
    expect(inspectJob).toContain("artifact.expired");
    expect(inspectJob).toContain("artifact-ids: ${{ inputs.source_artifact_id }}");
  });

  it("carries an explicit maintenance-window confirmation through the approved control path", async () => {
    const workflow = await read(".github/workflows/deploy-approved-production.yml");
    const control = await read("infra/deploy/peilv-control");
    expect(workflow).toContain("--maintenance-window-confirmed");
    expect(control).toContain("peilv-deploy:deploy:6)");
    expect(control).toContain('[[ "$6" == "--maintenance-window-confirmed" ]]');
    expect(control).toContain('deploy-production.sh "$2" "$3" "$4" "$5" "$6"');
  });
  it("rejects only an occupied target release path, allowing a quarantined ID to be unpacked again", async () => {
    const deploy = await read("scripts/deploy-production.sh");
    expect(deploy).toContain('[[ ! -e "$release_dir" ]] || { printf \'Release directory already exists');
    const lock = deploy.indexOf("flock -n 9");
    const rejectExisting = deploy.indexOf('[[ ! -e "$release_dir" ]]');
    const failureTrap = deploy.indexOf("trap restore_on_failure EXIT");
    expect(lock).toBeLessThan(rejectExisting);
    expect(rejectExisting).toBeLessThan(failureTrap);
    expect(deploy).toContain("release_created=0");
    expect(deploy).toContain("release_created == 1 && release_activated == 0");
    expect(deploy).toContain('${release_id}.failed-${request_id}.attempt-${attempt}');
    expect(deploy.indexOf("release_created=1")).toBeLessThan(deploy.indexOf('verify-release.sh --archive "$private_archive"'));
    expect(deploy).not.toContain("peilv-preflight-result");
  });
  it("binds the approved preflight result to the deployment request in the runner", async () => {
    const workflow = await read(".github/workflows/deploy-approved-production.yml");
    expect(workflow).toContain('REQUEST_ID: ${{ inputs.request_id }}');
    expect(workflow).toContain('result.requestId !== process.env.REQUEST_ID');
    expect(workflow).not.toContain('$PROD_HOST:/tmp/peilv-preflight-result');
  });
  it("extracts one new release tree, verifies it, and starts one candidate", async () => {
    const deploy = await read("scripts/deploy-production.sh");
    expect(deploy.match(/verify-release\.sh --archive "\$private_archive"/g)).toHaveLength(1);
    expect(deploy.match(/candidate_start "\$candidate_unit"/g)).toHaveLength(1);
    const rejectExisting = deploy.indexOf('[[ ! -e "$release_dir" ]]');
    const privateCopy = deploy.indexOf('node "$private_copy_helper" "$archive" "$private_archive"');
    const extract = deploy.indexOf('verify-release.sh --archive "$private_archive"');
    const treeVerify = deploy.indexOf('verify-release.sh --tree "$release_dir" --root-owned', extract);
    const candidate = candidateStart(deploy);
    expect(rejectExisting).toBeGreaterThan(-1);
    expect(rejectExisting).toBeLessThan(privateCopy);
    expect(privateCopy).toBeLessThan(extract);
    expect(extract).toBeLessThan(treeVerify);
    expect(treeVerify).toBeLessThan(candidate);
  });
  it("binds verification and extraction to a root-private archive copy", async () => {
    const deploy = await read("scripts/deploy-production.sh");
    const rollback = await read("scripts/rollback-production.sh");
    expect(deploy).toContain('node "$private_copy_helper" "$archive" "$private_archive"');
    const copy = await read("scripts/private-copy.mjs");
    expect(copy).toContain("O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW");
    expect(deploy).toContain('verify-release.sh --archive "$private_archive" "$expected_sha" "$release_dir"');
    expect(deploy).not.toContain('tar -xzf "$archive"');
    expect(deploy).toContain('"$release_verifier" --tree "$candidate_stage"');
    expect(deploy).toContain('verify-release.sh --tree "$release_dir" --root-owned');
    expect(rollback).toContain('verify-release.sh --tree "$target" --root-owned');
  });
  it.each(["deploy-production.sh", "rollback-production.sh"])("does not run package-manager lifecycle commands on production in %s", async name => {
    const script = await read(`scripts/${name}`);
    const commands = executableLines(script);
    expect(commands.some(line => /(?:^|[;&|]\s*|\b(?:runuser|sudo|env)\b[^\n]*\s)(?:pnpm|npm|npx)(?:\s|$)/.test(line)), name).toBe(false);
  });

  it("proves the deploy candidate before stopping production or starting migrations", async () => {
    const script = await read("scripts/deploy-production.sh");
    const candidate = candidateStart(script);
    const readiness = script.indexOf("check_candidate_application 5001", candidate);
    const stopTimers = script.indexOf("systemctl stop peilv-dispatch.timer", candidate);
    const stopApp = script.indexOf("systemctl stop peilv.service", candidate);
    const migration = script.indexOf("migration_started=1");
    expect(candidate).toBeGreaterThan(-1);
    expect(readiness).toBeGreaterThan(candidate);
    expect(stopTimers).toBeGreaterThan(-1);
    expect(stopApp).toBeGreaterThan(-1);
    expect(migration).toBeGreaterThan(-1);
    expect(readiness).toBeLessThan(stopTimers);
    expect(readiness).toBeLessThan(stopApp);
    expect(readiness).toBeLessThan(migration);
  });

  it("proves rollback compatibility and its candidate before entering the production transaction", async () => {
    const script = await read("scripts/rollback-production.sh");
    const compatibility = script.indexOf("Unsafe code rollback migration");
    const candidate = candidateStart(script);
    const readiness = script.indexOf("check_candidate_application 5001", candidate);
    const stopTimers = script.indexOf("systemctl stop peilv-dispatch.timer", candidate);
    const stopApp = script.indexOf("systemctl stop peilv.service", candidate);
    expect(compatibility).toBeGreaterThan(-1);
    expect(compatibility).toBeLessThan(candidate);
    expect(readiness).toBeGreaterThan(candidate);
    expect(readiness).toBeLessThan(stopTimers);
    expect(readiness).toBeLessThan(stopApp);
  });

  it("blocks automatic old-code recovery after an incompatible or partial migration", async () => {
    const deploy = await read("scripts/deploy-production.sh");
    const restore = deploy.slice(deploy.indexOf("restore_on_failure()"), deploy.indexOf("trap restore_on_failure EXIT"));
    expect(restore).toContain("migration_started == 1 && migration_completed == 0");
    expect(restore).toMatch(/remain stopped for database assessment|refusing automatic old-code recovery/i);
    const partialMigration = restore.indexOf("migration_started == 1 && migration_completed == 0");
    const oldCodeRestart = restore.indexOf('restore_unit_state peilv.service "$original_app_state"');
    expect(partialMigration).toBeGreaterThan(-1);
    expect(oldCodeRestart).toBeGreaterThan(partialMigration);
    expect(restore.slice(partialMigration, oldCodeRestart)).toContain('exit "$status"');
    const rollback = await read("scripts/rollback-production.sh");
    expect(rollback.indexOf("Unsafe code rollback migration")).toBeLessThan(rollback.indexOf("trap restore_on_failure EXIT"));
  });

  it.each(["deploy-production.sh", "rollback-production.sh"])("uses the shared private-network candidate lifecycle in %s", async name => {
    const script = await read(`scripts/${name}`);
    const lifecycle = await read("scripts/lib/candidate-lifecycle.sh");
    expect(script).toContain("candidate_start");
    expect(script).toContain("candidate_pin_netns");
    expect(lifecycle).toContain('--uid=peilv-candidate');
    expect(lifecycle).toContain('--gid=peilv-candidate');
    expect(lifecycle).toContain('PrivateNetwork=yes');
    expect(lifecycle).toContain('IPAddressDeny=any');
    expect(lifecycle).toContain("HOSTNAME=127.0.0.1");
  });

  it.each(["deploy-production.sh", "rollback-production.sh"])("uses one clearly scoped keyless readiness function in %s", async name => {
    const script = await read(`scripts/${name}`);
    const lifecycle = await read("scripts/lib/candidate-lifecycle.sh");
    expect(script).toContain("candidate_probe");
    if (name === "deploy-production.sh") expect(script).toContain("check_current_application 5000");
    expect(script).toContain("check_formal_application 5000");
    expect(lifecycle).toContain("/api/readiness");
    expect(lifecycle).toContain("returned HTTP %s");
    expect(lifecycle).toContain("no-store");
    expect(lifecycle).not.toMatch(/storage\/health|LoadCredential|curl-secret|INTERNAL_API_SECRET/);
    expect(script.indexOf("check_candidate_application 5001", candidateStart(script))).toBeGreaterThan(candidateStart(script));
  });

  it.each(["deploy-production.sh", "rollback-production.sh"])("stages and commits the complete systemd unit set transactionally in %s", async name => {
    const script = await read(`scripts/${name}`);
    expect(script).toContain("stage_release_systemd_units() {");
    expect(script).toContain("commit_staged_systemd_units() {");
    expect(script).toContain("restore_systemd_units_backup() {");
    const stage = script.indexOf("stage_release_systemd_units ");
    const marker = script.indexOf("systemd_units_transaction_started=1", stage);
    const commit = script.indexOf("commit_staged_systemd_units", marker);
    const firstTargetReplace = script.indexOf('mv -Tf', marker);
    expect(stage).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(stage);
    expect(commit).toBeGreaterThan(marker);
    expect(firstTargetReplace).toBeGreaterThan(marker);
    const restore = script.slice(script.indexOf("restore_on_failure()"), script.indexOf("trap restore_on_failure EXIT"));
    expect(restore).toContain("systemd_units_transaction_started == 1");
    expect(restore).toContain("restore_systemd_units_backup");
  });

  it("keeps the trusted host helper outside the application release artifact", async () => {
    const create = await read("scripts/create-release.sh");
    const verify = await read("scripts/verify-release.sh");
    const deploy = await read("scripts/deploy-production.sh");
    const rollback = await read("scripts/rollback-production.sh");
    expect(create).not.toContain('cp scripts/lib/curl-secret.sh');
    expect(verify).not.toContain('scripts/lib/curl-secret.sh');
    for (const script of [deploy, rollback]) {
      expect(script).not.toContain("install_release_curl_secret_helper");
      expect(script).not.toMatch(/(?:candidate|target|current)_curl_secret_helper/);
      expect(script).toContain("verify_installed_curl_secret_helper");
    }
  });
});
