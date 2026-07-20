import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const exec = promisify(execFile);

describe("candidate security review P0 contract", () => {
  it("uses a private network and probes only through a verified MainPID namespace", async () => {
    const lifecycle = await read("scripts/lib/candidate-lifecycle.sh");
    expect(lifecycle).toContain("PrivateNetwork=yes");
    expect(lifecycle).toContain('systemctl show "$unit" -p MainPID --value');
    expect(lifecycle).toContain('[[ "$id" == "$unit"');
    expect(lifecycle).toContain('grep -Fq -- "$control_group" "/proc/$pid/cgroup"');
    expect(lifecycle).toContain('nsenter -t "$pid" -n -- curl');
    expect(lifecycle).not.toContain("curl -fsS http://127.0.0.1:5001");
  });

  it("applies bounded resources, output and kernel/process sandboxing", async () => {
    const lifecycle = await read("scripts/lib/candidate-lifecycle.sh");
    for (const token of ["RuntimeMaxSec=", "MemoryMax=", "MemorySwapMax=0", "TasksMax=", "CPUQuota=", "LimitNOFILE=", "PrivateTmp=yes", "TemporaryFileSystem=/tmp", "LogRateLimitIntervalSec=", "LogRateLimitBurst=", "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "PrivateDevices=yes", "ProtectProc=invisible", "ProcSubset=pid", "CapabilityBoundingSet=", "NoNewPrivileges=yes", "SupplementaryGroups="]) expect(lifecycle).toContain(token);
    for (const path of ["/etc/peilv", "/var/lib/peilv", "/opt/peilv/shared", "/opt/peilv/backups", "/opt/peilv/releases", "/opt/peilv/incoming"]) expect(lifecycle).toContain(path);
    expect(lifecycle).toContain("candidate_existing_sensitive_path_properties");
    expect(lifecycle).not.toMatch(/InaccessiblePaths=[^\n]*\/run\/postgresql/);
  });

  it("omits missing optional runtime paths, blocks existing ones, and fails closed for required paths", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "peilv-candidate-paths-"));
    const requiredPaths = ["shared", "backups", "releases", "incoming"].map(name => join(sandbox, name));
    const optionalPaths = ["docker.sock", "containerd", "dbus", "systemd-private", "postgresql"].map(name => join(sandbox, name));
    await Promise.all(requiredPaths.map(path => mkdir(path)));
    await Promise.all(optionalPaths.slice(0, 3).map(path => mkdir(path)));
    const helper = new URL("scripts/lib/candidate-lifecycle.sh", root).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1));
    const script = `
set -e
source "$1"
shift
required_count="$1"; shift
CANDIDATE_REQUIRED_SENSITIVE_PATHS=("\${@:1:required_count}"); shift "$required_count"
CANDIDATE_OPTIONAL_SENSITIVE_PATHS=("$@")
candidate_existing_sensitive_path_properties properties
printf '%s\\n' "\${properties[@]}"
`;
    try {
      const args = ["-c", script, "candidate-path-test", helper, String(requiredPaths.length), ...requiredPaths, ...optionalPaths];
      const { stdout } = await exec("bash", args);
      for (const path of requiredPaths) expect(stdout).toContain(`InaccessiblePaths=${path}`);
      for (const path of optionalPaths.slice(0, 3)) expect(stdout).toContain(`InaccessiblePaths=${path}`);
      for (const path of optionalPaths.slice(3)) expect(stdout).not.toContain(path);
      expect(stdout).not.toContain("226/NAMESPACE");

      await mkdir(optionalPaths[3]);
      await mkdir(optionalPaths[4]);
      const { stdout: allExisting } = await exec("bash", args);
      for (const path of optionalPaths) expect(allExisting).toContain(`InaccessiblePaths=${path}`);

      await rm(requiredPaths[0], { recursive: true });
      await expect(exec("bash", args)).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("preflight guarantees required production paths and deploy/rollback share the same sandbox contract", async () => {
    const lifecycle = await read("scripts/lib/candidate-lifecycle.sh");
    const required = ["/opt/peilv/shared", "/opt/peilv/backups", "/opt/peilv/releases", "/opt/peilv/incoming"];
    for (const path of required) {
      expect(lifecycle).toContain(path);
    }
    for (const name of ["deploy-production.sh", "rollback-production.sh"]) {
      const file = await read(`scripts/${name}`);
      expect(file).toContain('source "$candidate_lifecycle_helper"');
      const releaseVariable = name === "deploy-production.sh" ? "$release_id" : "$target_release_id";
      expect(file).toContain(`candidate_start "$candidate_unit" "${releaseVariable}" "$candidate_stage" "$candidate_mount"`);
      expect(file).not.toMatch(/InaccessiblePaths=.*\/run\/(?:postgresql|docker|containerd|dbus)/);
    }
  });

  it("keeps rollback pre-transaction failure cleanup away from production", async () => {
    const rollback = await read("scripts/rollback-production.sh");
    expect(rollback).toContain("transaction_started=0");
    const restore = rollback.slice(rollback.indexOf("restore_on_failure()"), rollback.indexOf("trap restore_on_failure EXIT"));
    const guard = restore.indexOf("transaction_started == 0");
    expect(guard).toBeGreaterThan(-1);
    for (const operation of ["systemctl stop peilv.service", 'restore_unit_state peilv.service "$original_app_state"', 'mv -Tf "$base/current.rollback"', "systemctl reload openresty.service"]) expect(restore.indexOf(operation)).toBeGreaterThan(guard);
    expect(rollback.indexOf("transaction_started=1")).toBeLessThan(rollback.indexOf("write_transaction_state maintenance_entering"));
  });

  it("aggregates peak blocks and inodes by device before writes and uses the publish lock", async () => {
    const budget = await read("scripts/lib/deployment-budget.sh");
    expect(budget).toContain("DEPLOY_BUDGET_KIB[$device]");
    expect(budget).toContain("DEPLOY_BUDGET_INODES[$device]");
    expect(budget).toContain("df -Pk");
    expect(budget).toContain("df -Pi");
    const control = await read("infra/deploy/peilv-control");
    expect(control).toContain("flock -n 9");
    for (const file of ["scripts/deploy-production.sh", "scripts/production-preflight.sh"]) {
      const script = await read(file);
      expect(script).not.toContain("flock -n 9");
      expect(script).toContain("deployment_budget_check");
      expect(script.indexOf("deployment_budget_check")).toBeLessThan(script.indexOf('node "$private_copy_helper"'));
    }
  });

  it("writes a verified fsynced partial backup before atomic rename", async () => {
    const deploy = await read("scripts/deploy-production.sh");
    const partial = deploy.indexOf('backup_partial="$backup.partial"');
    const dump = deploy.indexOf('> "$backup_partial"', partial);
    const list = deploy.indexOf('pg_restore -l < "$backup_partial"', dump);
    const fsync = deploy.indexOf('sync -f "$backup_partial"', list);
    const rename = deploy.indexOf('mv -T "$backup_partial" "$backup"', fsync);
    expect(partial).toBeGreaterThan(-1); expect(dump).toBeGreaterThan(partial); expect(list).toBeGreaterThan(dump); expect(fsync).toBeGreaterThan(list); expect(rename).toBeGreaterThan(fsync);
  });

  it("proves candidate death and namespace release before stage cleanup", async () => {
    const lifecycle = await read("scripts/lib/candidate-lifecycle.sh");
    expect(lifecycle).toContain("candidate_wait_inactive");
    expect(lifecycle).toContain("systemctl kill --kill-who=all --signal=SIGKILL");
    expect(lifecycle).toContain('[[ "$pid" == 0 ]]');
    expect(lifecycle).toContain('nsenter --net="$pin" -- ss');
    for (const file of ["scripts/deploy-production.sh", "scripts/rollback-production.sh"]) {
      const script = await read(file);
      const stop = script.slice(script.indexOf("stop_candidate()"), script.indexOf("check_candidate_application()"));
      expect(stop.indexOf("candidate_stop_and_release")).toBeLessThan(stop.lastIndexOf("candidate_cleanup_stage"));
      expect(stop).not.toContain('systemctl stop "$candidate_unit"');
    }
  });
});
