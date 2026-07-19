import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { canonicalMigrationContract } from "../scripts/migration-contract.mjs";

const exec = promisify(execFile);
const request = "123e4567-e89b-42d3-a456-426614174000";
const identity = { schemaVersion: 3, releaseId: "r1-a1-aaaaaaaaaaaa", archiveSha256: "b".repeat(64), externalManifestSha256: "a".repeat(64), expectedCurrentReleaseId: "20260712T192535Z", validUntil: "2099-01-01T00:00:00Z", migrationLedgerDigest: "c".repeat(64), pendingPlanDigest: "d".repeat(64) };
const manifest = { schemaVersion: 1, migrations: [
  { file: "0001_base.sql", version: "0001_base", sha256: "1".repeat(64), codeRollbackSafe: true },
  { file: "0002_change.sql", version: "0002_change", sha256: "2".repeat(64), codeRollbackSafe: false },
] };

async function ledgerFixture(prefix: string) {
  const base = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(base, "operations");
  const fs = await import("node:fs/promises");
  await fs.mkdir(root, { mode: 0o700 });
  await fs.chmod(root, 0o700);
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const source = (await readFile("scripts/deploy-operation-ledger.mjs", "utf8"))
    .replace("stat.uid!==0||stat.gid!==0", `stat.uid!==${uid}||stat.gid!==${gid}`);
  const script = path.join(base, "deploy-operation-ledger.mjs");
  await writeFile(script, source);
  return { root, script, fs };
}

describe("migration CAS and deploy request idempotency", () => {
  it("uses manifest order and binds SHA plus rollback safety without locale or Date sorting", () => {
    const first = canonicalMigrationContract(manifest, ["0001_base"]);
    const repeated = canonicalMigrationContract(manifest, ["0001_base"]);
    expect(first).toEqual(repeated);
    expect(first.pending).toEqual(["0002_change.sql"]);
    expect(first.pendingAllCodeRollbackSafe).toBe(false);
    expect(first.migrationLedgerDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.pendingPlanDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects ledger drift, plan metadata drift, and unknown versions", () => {
    const approved = canonicalMigrationContract(manifest, ["0001_base"]);
    expect(canonicalMigrationContract(manifest, []).migrationLedgerDigest).not.toBe(approved.migrationLedgerDigest);
    expect(canonicalMigrationContract({ ...manifest, migrations: manifest.migrations.map((m, i) => i ? { ...m, sha256: "3".repeat(64) } : m) }, ["0001_base"]).pendingPlanDigest).not.toBe(approved.pendingPlanDigest);
    expect(canonicalMigrationContract(manifest, ["0001_base", "9999_unknown"]).unknown).toEqual(["9999_unknown"]);
  });

  it("claims once, replays succeeded result, rejects running and different identity", async () => {
    const { root, script } = await ledgerFixture("deploy-operations-");
    const json = JSON.stringify(identity);
    await expect(exec(process.execPath, [script, "check", root, request, json])).resolves.toMatchObject({ stdout: "new\n" });
    await expect(exec(process.execPath, [script, "claim", root, request, json])).resolves.toMatchObject({ stdout: "claimed\n" });
    await expect(exec(process.execPath, [script, "check", root, request, json])).rejects.toMatchObject({ code: 1 });
    const result = path.join(root, "result.json"); await writeFile(result, JSON.stringify({ schemaVersion: 1, status: "succeeded", requestId: request, releaseId: identity.releaseId }));
    await exec(process.execPath, [script, "finish", root, request, "succeeded", result]);
    await expect(exec(process.execPath, [script, "check", root, request, json])).resolves.toMatchObject({ stdout: "replay\n" });
    await expect(exec(process.execPath, [script, "check", root, request, JSON.stringify({ ...identity, archiveSha256: "e".repeat(64) })])).rejects.toMatchObject({ code: 1 });
    expect(JSON.parse(await readFile(path.join(root, `${request}.json`), "utf8"))).toMatchObject({ status: "succeeded", identity });
    const operation=JSON.parse(await readFile(path.join(root,`${request}.json`),"utf8"));
    expect(operation).toMatchObject({sequence:2,status:"succeeded",result:{releaseId:identity.releaseId,status:"succeeded"}});
    expect(operation.events).toHaveLength(2); expect(operation.eventDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("moves a host-restart running request to manual assessment without replay", async () => {
    const {root,script}=await ledgerFixture("deploy-recover-");const json=JSON.stringify(identity);
    await exec(process.execPath,[script,"claim",root,request,json]);await exec(process.execPath,[script,"recover-running",root,request]);
    const operation=JSON.parse((await exec(process.execPath,[script,"status",root,request])).stdout);
    expect(operation).toMatchObject({status:"manual-assessment",result:{reason:"host-restart-running-operation"}});
    await expect(exec(process.execPath,[script,"check",root,request,json])).rejects.toBeDefined();
  });

  it.each([
    ["wrong release",{schemaVersion:1,status:"succeeded",requestId:request,releaseId:"r2-a1-bbbbbbbbbbbb"}],
    ["wrong request",{schemaVersion:1,status:"succeeded",requestId:"223e4567-e89b-42d3-a456-426614174000",releaseId:identity.releaseId}],
    ["wrong status",{schemaVersion:1,status:"failed",requestId:request,releaseId:identity.releaseId}],
  ])("rejects finish result identity: %s",async(_name,resultValue)=>{const {root,script}=await ledgerFixture("deploy-finish-");const json=JSON.stringify(identity),result=path.join(root,"result.json");await exec(process.execPath,[script,"claim",root,request,json]);await writeFile(result,JSON.stringify(resultValue));await expect(exec(process.execPath,[script,"finish",root,request,"succeeded",result])).rejects.toBeDefined();});

  it("rejects hardlinked durable operation files", async () => {
    const {root,script,fs}=await ledgerFixture("deploy-unsafe-");
    const json=JSON.stringify(identity), operation=path.join(root,`${request}.json`);
    await exec(process.execPath,[script,"claim",root,request,json]);
    await fs.link(operation,path.join(root,"second-link"));
    await expect(exec(process.execPath,[script,"status",root,request])).rejects.toBeDefined();
  });

  it("rejects symlink durable operation files by lstat contract", async () => {
    const helper=await readFile("scripts/deploy-operation-ledger.mjs","utf8");
    expect(helper).toContain("fs.lstatSync(operationPath)"); expect(helper).toContain("stat.isSymbolicLink()");
  });

  it.each(["oversized", "corrupt-json", "corrupt-event-digest"])("fails closed on %s operation ledger", async kind=>{const {root,script}=await ledgerFixture("deploy-corrupt-"),json=JSON.stringify(identity),operation=path.join(root,`${request}.json`);await exec(process.execPath,[script,"claim",root,request,json]);if(kind==="oversized")await writeFile(operation,"x".repeat(1024*1024+1));if(kind==="corrupt-json")await writeFile(operation,"{broken");if(kind==="corrupt-event-digest"){const value=JSON.parse(await readFile(operation,"utf8"));value.eventDigest="0".repeat(64);await writeFile(operation,JSON.stringify(value))}await expect(exec(process.execPath,[script,"status",root,request])).rejects.toBeDefined();});

  it("maintenance confirmation cannot bypass identity, expiry, manifest, or migration CAS gates", async()=>{const deploy=await readFile("scripts/deploy-production.sh","utf8"),maintenance=deploy.indexOf('maintenance_confirmation="${9:-}"'),identity=deploy.indexOf("operation_identity="),expiry=deploy.indexOf("assert_preflight_not_expired",deploy.indexOf('[[ "$operation_check" == new ]]')),manifest=deploy.indexOf('sha256sum "$external_manifest"'),cas=deploy.indexOf("Migration ledger or pending plan CAS drift"),maintenanceUse=deploy.indexOf('incompatible_migration_pending == 1',cas);expect(maintenance).toBeGreaterThan(-1);expect(identity).toBeGreaterThan(maintenance);expect(expiry).toBeGreaterThan(identity);expect(manifest).toBeGreaterThan(expiry);expect(cas).toBeGreaterThan(manifest);expect(maintenanceUse).toBeGreaterThan(cas);});

  it("keeps unsafe completed or incomplete migrations stopped for manual assessment", async () => {
    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    expect(deploy).toContain("migration_started == 1 && migration_completed == 0");
    expect(deploy).toContain("migration_completed == 1 && pending_all_code_rollback_safe == 0");
    const manual = deploy.slice(deploy.indexOf("if (( migration_started"), deploy.indexOf("if (( switched == 1"));
    expect(manual).not.toContain("restore_unit_state peilv.service");
    expect(manual).not.toContain("restore_unit_state peilv-reconcile.timer");
    expect(manual).toContain('"status":"manual-assessment"');
    expect(manual).toContain("systemctl stop peilv-dispatch.timer");
    expect(manual).toContain("systemctl stop peilv-reconcile.timer");
    expect(manual).toContain("systemctl stop peilv.service");
  });

  it("records each timer stop before invoking it and dynamically handles a 340s oneshot timeout", async () => {
    const deploy = await readFile("scripts/deploy-production.sh", "utf8");
    expect(deploy.indexOf("dispatch_timer_stopped=1", deploy.indexOf("maintenance_entering"))).toBeLessThan(deploy.indexOf("systemctl stop peilv-dispatch.timer", deploy.indexOf("maintenance_entering")));
    expect(deploy.indexOf("reconcile_timer_stopped=1", deploy.indexOf("maintenance_entering"))).toBeLessThan(deploy.indexOf("systemctl stop peilv-reconcile.timer", deploy.indexOf("maintenance_entering")));
    expect(deploy).toContain("TimeoutStartUSec"); expect(deploy).toContain("+ 10");
    expect(deploy).toContain('case "$state" in inactive)'); expect(deploy).toContain('[[ "$result" == "success" ]]');
    const start = deploy.indexOf("run_oneshot_and_wait() {");
    const fn = deploy.slice(start, deploy.indexOf("stop_candidate() {", start));
    const root = await mkdtemp(path.join(os.tmpdir(), "oneshot-340-"));
    const harness = path.join(root, "run.sh");
    await writeFile(harness, `#!/usr/bin/env bash\nset -Eeuo pipefail\n${fn}\ncounter="$(dirname "$0")/counter"; printf '0\\n' >"$counter"\nsystemctl(){ case "$1:$2" in show:sample.service) [[ "$3" == -p && "$4" == TimeoutStartUSec ]] && printf '340000000\\n' || printf 'success\\n';; start:--no-block) [[ "$3" == sample.service ]];; is-active:sample.service) calls=$(<"$counter"); calls=$((calls+1)); printf '%s\\n' "$calls" >"$counter"; [[ "$calls" == 1 ]] && printf 'activating\\n' || printf 'inactive\\n';; *) return 90;; esac; }\nsleep(){ SECONDS=$((SECONDS+1)); }\nrun_oneshot_and_wait sample.service\n`);
    await expect(exec("bash", [harness])).resolves.toMatchObject({ stdout: "", stderr: "" });
  });

  it("preflight DB query fails closed and never swallows psql failure", async () => {
    const preflight = await readFile("scripts/production-preflight.sh", "utf8");
    const start = preflight.indexOf('ledger_query="');
    const query = preflight.slice(start, preflight.indexOf("migration_contract_file=", start));
    expect(query).toContain("psql -v ON_ERROR_STOP=1");
    expect(query).not.toContain("|| true");
    expect(query).toContain('check_blocked migration_ledger_query "Migration ledger query failed"');
  });

  it("queries durable status after SSH failure without replaying deploy", async () => {
    const workflow = await readFile(".github/workflows/deploy-approved-production.yml", "utf8");
    const invoke = workflow.indexOf('peilv-control deploy-v3 \'$RELEASE_ID\'');
    const status = workflow.indexOf("peilv-control deploy-status-v1 '$REQUEST_ID'", invoke);
    expect(workflow.slice(invoke, status).match(/peilv-control deploy-v3 /g)).toHaveLength(1);
    expect(workflow.slice(invoke, status)).toContain('deploy_ssh_status="${PIPESTATUS[0]}"');
    expect(status).toBeGreaterThan(invoke);
  });

  it("binds external manifest raw digest from artifact through host identity", async()=>{const workflow=await readFile(".github/workflows/deploy-approved-production.yml","utf8"),deploy=await readFile("scripts/deploy-production.sh","utf8");expect(workflow).toContain('external_manifest_sha="$(sha256sum "$external"');expect(workflow).toContain('"$archive" "$checksum" "$external"');expect(workflow).toContain("'$EXTERNAL_MANIFEST_SHA'");expect(deploy).toContain('sha256sum "$external_manifest"');expect(deploy).toContain("externalManifestSha256");expect(deploy).toContain("External and archive migration manifests differ");});
  it("uses embedded operation result for both early and claim-race replay",async()=>{const deploy=await readFile("scripts/deploy-production.sh","utf8");expect(deploy.match(/\$operation_ledger\" status \"\$operation_root\"/g)).toHaveLength(2);expect(deploy).not.toContain('then cat "$result_path"');});
});
