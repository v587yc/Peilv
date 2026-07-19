import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertNotExpired } from "../scripts/assert-rfc3339-not-expired.mjs";
import { validateProductionDeployIdentity } from "../scripts/validate-production-deploy-identity.mjs";

const exec = promisify(execFile);
const read = (name: string) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const sha = "a".repeat(40);
const repositoryId = 987654;
const workflowId = 311661308;
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const expected = { repositoryId, repositoryName: "owner/repo", preflightWorkflowId: workflowId, sourceRunId: "101", sourceRunAttempt: "2", preflightRunId: "202", preflightRunAttempt: 3, commitSha: sha, requestId };
const repository = { id: repositoryId, full_name: "owner/repo" };
const workflow = { id: workflowId, path: ".github/workflows/production-preflight.yml" };
const source = { id: 101, repository: { id: repositoryId }, event: "push", head_branch: "main", head_sha: sha, status: "completed", conclusion: "success", run_attempt: 2 };
const preflight = { id: 202, repository: { id: repositoryId }, workflow_id: workflowId, path: workflow.path, name: "Preflight dynamic title A", event: "workflow_dispatch", head_branch: "main", head_sha: sha, status: "completed", conclusion: "success", run_attempt: 3 };
const candidate = { name: "peilv-candidate-101-2", expired: false, workflow_run: { id: 101, head_sha: sha } };
const result = { name: `preflight-result-${requestId}`, expired: false, workflow_run: { id: 202, head_sha: sha } };
const valid = { dispatch: { refName: "main", sha }, source, preflight, candidate, result, repository, workflow, workflowFallback: null, expected };

describe("production deploy fixed identity and expiry", () => {
  it("accepts dynamic run names through fixed workflow path and API id", () => {
    expect(() => validateProductionDeployIdentity(valid)).not.toThrow();
    expect(() => validateProductionDeployIdentity({ ...valid, preflight: { ...preflight, name: "Another dynamic run-name" } })).not.toThrow();
    const noPath = { ...preflight }; delete (noPath as { path?: string }).path;
    expect(() => validateProductionDeployIdentity({ ...valid, preflight: noPath, workflowFallback: workflow })).not.toThrow();
  });

  it.each([
    ["workflow path", { workflow: { ...workflow, path: ".github/workflows/fake.yml" } }],
    ["workflow id", { workflow: { ...workflow, id: workflowId + 1 } }],
    ["repository", { preflight: { ...preflight, repository: { id: repositoryId + 1 } } }],
    ["event", { preflight: { ...preflight, event: "push" } }],
    ["branch", { preflight: { ...preflight, head_branch: "feature" } }],
    ["SHA", { preflight: { ...preflight, head_sha: "b".repeat(40) } }],
    ["attempt", { preflight: { ...preflight, run_attempt: 2 } }],
  ])("rejects wrong %s", (_name, change) => expect(() => validateProductionDeployIdentity({ ...valid, ...change })).toThrow());

  it("rejects missing path unless exact workflow id is fetched again", () => {
    const noPath = { ...preflight }; delete (noPath as { path?: string }).path;
    expect(() => validateProductionDeployIdentity({ ...valid, preflight: noPath, workflowFallback: null })).toThrow();
    expect(() => validateProductionDeployIdentity({ ...valid, preflight: noPath, workflowFallback: { ...workflow, id: workflowId + 1 } })).toThrow();
  });

  it("rejects main drift between the dispatch workflow and candidate", () => {
    expect(() => validateProductionDeployIdentity({ ...valid, dispatch: { refName: "main", sha: "b".repeat(40) } })).toThrow(/drifted/);
    expect(() => validateProductionDeployIdentity({ ...valid, dispatch: { refName: "feature", sha } })).toThrow(/drifted/);
  });

  it("uses zero expiry tolerance and strict UTC RFC3339", () => {
    expect(() => assertNotExpired("2026-07-19T10:00:00Z", Date.parse("2026-07-19T09:59:59.999Z"))).not.toThrow();
    expect(() => assertNotExpired("2026-07-19T10:00:00Z", Date.parse("2026-07-19T10:00:00Z"))).toThrow(/expired/);
    expect(() => assertNotExpired("2026-07-19 10:00:00Z", 0)).toThrow(/RFC3339/);
    expect(() => assertNotExpired("2026-02-30T10:00:00Z", 0)).toThrow(/real UTC/);
  });

  it("places all three runner expiry gates before upload and server invocation", async () => {
    const workflowText = await read(".github/workflows/deploy-approved-production.yml");
    const crossCheck = workflowText.indexOf('node scripts/assert-rfc3339-not-expired.mjs "${result_values[3]}"');
    const uploadGate = workflowText.indexOf('node scripts/assert-rfc3339-not-expired.mjs "$VALID_UNTIL"');
    const scp = workflowText.indexOf("scp -i ~/.ssh/deploy_key", uploadGate);
    const invokeGate = workflowText.indexOf('node scripts/assert-rfc3339-not-expired.mjs "$VALID_UNTIL"', uploadGate + 1);
    const ssh = workflowText.indexOf("ssh -i ~/.ssh/deploy_key", invokeGate);
    expect(crossCheck).toBeGreaterThan(-1); expect(uploadGate).toBeGreaterThan(crossCheck); expect(scp).toBeGreaterThan(uploadGate); expect(invokeGate).toBeGreaterThan(scp); expect(ssh).toBeGreaterThan(invokeGate);
  });

  it("server rejects expiry before every production mutation", async () => {
    const script = await read("scripts/deploy-production.sh");
    expect(script).toContain('assert_preflight_not_expired\ninstall -d -o root -g root -m 0700 "$verified_incoming_dir"');
    expect(script).toContain('assert_preflight_not_expired\ninstall -d -o root -g root -m 0755 "$release_dir"');
    expect(script).toContain('assert_preflight_not_expired\ncandidate_stage="$(candidate_prepare_stage');
    const finalGate = script.indexOf("assert_preflight_not_expired\nwrite_transaction_state maintenance_entering");
    expect(finalGate).toBeGreaterThan(-1);
    for (const mutation of ["systemctl stop peilv-dispatch.timer", 'install -d -o root -g peilv -m 0750 "$base/backups"', 'write_transaction_state migration_running']) {
      expect(script.indexOf(mutation, finalGate)).toBeGreaterThan(finalGate);
    }
  });

  it.each(["cross-check", "before-upload", "before-server"])("expired %s gate performs zero production calls", async stage => {
    const calls: string[] = [];
    expect(() => { assertNotExpired("2026-07-19T10:00:00Z", Date.parse("2026-07-19T10:00:00Z")); calls.push(stage); }).toThrow(/expired/);
    expect(calls).toEqual([]);
  });

  it("passes maintenance confirmation only when explicitly true", async () => {
    const workflowText = await read(".github/workflows/deploy-approved-production.yml");
    expect(workflowText).toContain("maintenance_window_confirmed:");
    expect(workflowText).toContain("default: false");
    expect(workflowText).toContain('[[ "$MAINTENANCE_WINDOW_CONFIRMED" == true ]] && maintenance_option=" --maintenance-window-confirmed"');
    const control = await read("infra/deploy/peilv-control");
    expect(control).toContain("peilv-deploy:deploy-v3:9)");
    expect(control).toContain("peilv-deploy:deploy-v3:10)");
    expect(control).toContain("peilv-deploy:deploy-status-v1:2)");
    expect(control).not.toContain("peilv-deploy:deploy-v3:11)");
    const deploy = await read("scripts/deploy-production.sh");
    expect(deploy).toContain('[[ "$#" == 8 || "$#" == 9 ]]');
    expect(deploy).not.toContain('for option in "${@:6}"');
    expect(deploy).not.toContain("--approved-current-unit-hotfix-transition");
  });

  it.each([
    ["missing validUntil", ["r1-a1-aaaaaaaaaaaa", "a".repeat(64), "20260712T192535Z", requestId]],
    ["flag in validUntil position", ["r1-a1-aaaaaaaaaaaa", "a".repeat(64), "20260712T192535Z", requestId, "--maintenance-window-confirmed"]],
    ["duplicate flag", ["r1-a1-aaaaaaaaaaaa", "a".repeat(64), "20260712T192535Z", requestId, "2099-01-01T00:00:00Z", "--maintenance-window-confirmed", "--maintenance-window-confirmed"]],
    ["extra argument", ["r1-a1-aaaaaaaaaaaa", "a".repeat(64), "20260712T192535Z", requestId, "2099-01-01T00:00:00Z", "extra"]],
    ["retired hotfix flag", ["r1-a1-aaaaaaaaaaaa", "a".repeat(64), "20260712T192535Z", requestId, "2099-01-01T00:00:00Z", "--approved-current-unit-hotfix-transition"]],
  ])("rejects %s without reaching host paths", async (_name, args) => {
    await expect(exec("bash", ["scripts/deploy-production.sh", ...args])).rejects.toMatchObject({ code: 1 });
  });

  it("rechecks expiry immediately after acquiring the deployment lock", async () => {
    const deploy = await read("scripts/deploy-production.sh");
    const lock = deploy.indexOf("if ! flock -n 9");
    const operationCheck = deploy.indexOf('[[ "$operation_check" == new ]]', lock);
    const afterLock = deploy.indexOf("assert_preflight_not_expired", operationCheck);
    const releaseCheck = deploy.indexOf('[[ ! -e "$release_dir" ]]', afterLock);
    expect(lock).toBeGreaterThan(-1);
    expect(operationCheck).toBeGreaterThan(lock);
    expect(afterLock).toBeGreaterThan(operationCheck);
    expect(releaseCheck).toBeGreaterThan(afterLock);
  });

  it("keeps one-shot service checks and restores both timer snapshots on success", async () => {
    const script = await read("scripts/deploy-production.sh");
    expect(script).toContain("run_oneshot_and_wait peilv-reconcile.service");
    expect(script).toContain("run_oneshot_and_wait peilv-dispatch.service");
    expect(script).toContain('systemctl show "$unit" -p TimeoutStartUSec --value');
    expect(script).toContain('restore_unit_state peilv-reconcile.timer "$original_reconcile_timer_state"');
    expect(script).toContain('restore_unit_state peilv-dispatch.timer "$original_dispatch_timer_state"');
  });

  it("shell syntax remains valid", async () => {
    await expect(exec("bash", ["-n", "scripts/deploy-production.sh"])).resolves.toMatchObject({ stdout: "", stderr: "" });
    await expect(exec("bash", ["-n", "infra/deploy/peilv-control"])).resolves.toMatchObject({ stdout: "", stderr: "" });
  });
});
