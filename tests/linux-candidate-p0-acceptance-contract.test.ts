import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const execFileAsync = promisify(execFile);

describe("Linux candidate P0 isolated acceptance", () => {
  it("denies by default and requires explicit isolated-host ack", async () => {
    const s = await read("tests/linux-candidate-p0-acceptance.sh");
    expect(s).toContain("PEILV_LINUX_P0_SANDBOX_ONLY");
    expect(s).toContain("--isolated-host-ack");
    expect(s).toContain("static_self_scan");
    expect(s.indexOf("static_self_scan")).toBeLessThan(s.indexOf("systemd-run --quiet"));
  });
  it("confines unique roots, units and trap cleanup", async () => {
    const s = await read("tests/linux-candidate-p0-acceptance.sh");
    for (const token of ["mktemp -d /var/lib/peilv-test-", "/tmp/peilv-test-${random_id}.img", 'UNIT_PREFIX="peilv-p0-test-"', "safe_names", "trap cleanup EXIT HUP INT TERM", "losetup -d"]) expect(s).toContain(token);
  });
  it("uses a fail-closed LoadState compatibility guard without changing unit format", async () => {
    const s = await read("tests/linux-candidate-p0-acceptance.sh");
    const guard = await read("tests/fixtures/linux-p0/unit-loadstate-guard.sh");
    expect(s).toContain('unit="${UNIT_PREFIX}${random_id}.service"');
    expect(s).toContain('p0_unique_unit_is_absent "$unit"');
    expect(s.indexOf('p0_unique_unit_is_absent "$unit"')).toBeLessThan(s.indexOf('mktemp -d /var/lib/peilv-test-'));
    expect(guard).toContain(String.raw`^peilv-p0-test-[0-9a-f]{16}\.service$`);
    expect(guard).not.toContain("python");
    expect(guard).toContain('"$stdout_hex" == 6e6f742d666f756e640a');
    expect(guard).toContain("printf 'Unit %s could not be found.\\n' \"$unit\"");
    expect(guard).toContain('"$stderr_hex" == "$expected_stderr_hex" && "$status" == 4');
  });
  it("executes the systemctl LoadState mock matrix", async () => {
    const { stdout } = await execFileAsync("bash", ["tests/fixtures/linux-p0/unit-loadstate-guard-matrix.sh"], {
      cwd: fileURLToPath(root),
      timeout: 120_000,
    });
    for (const evidence of [
      "PASS exit0_not_found allow", "PASS exit4_not_found allow", "PASS exit4_exact_stderr allow",
      "PASS exit4_empty reject", "PASS exit1_exact_stderr reject", "PASS exit4_wrong_unit_stderr reject",
      "PASS exit4_exact_stderr_extra reject", "PASS exit4_stdout_and_stderr reject",
      "PASS exit0_empty reject", "PASS exit1_empty reject", "PASS loaded reject",
      "PASS masked reject", "PASS error reject", "PASS bad_setting reject", "PASS stub reject",
      "PASS merged reject", "PASS multiline reject", "PASS trailing_blank reject",
      "PASS unknown reject", "PASS exit1_garbage reject", "PASS malformed_unit reject",
      "PASS exit0_non_ascii reject", "PASS exit0_nul reject",
      "PASS unit_loadstate_matrix total=23",
    ]) expect(stdout).toContain(evidence);
  }, 130_000);
  it("covers network, properties, cgroups, locks, capacity and lifecycle", async () => {
    const s = await read("tests/linux-candidate-p0-acceptance.sh");
    for (const token of ["private_network_host_unreachable", "private_network_nsenter_reachable", "optional_sensitive_missing_start", "optional_sensitive_properties", "optional_sensitive_existing_blocked", "required_sensitive_paths_blocked", "candidate_existing_sensitive_path_properties", "systemd_property_", "cgroup_equals memory.max", "flock_transaction_two_rejected", "capacity_blocks", "capacity_inodes", "capacity_quota", "stubborn_term", "stubborn_mainpid_alive", "stubborn_port_5001_busy", "stubborn_mount_busy", "stubborn_sigkill_mainpid_zero"]) expect(s).toContain(token);
  });
  it("proves six rollback faults have zero formal calls", async () => {
    const s = await read("tests/linux-candidate-p0-acceptance.sh");
    const f = await read("tests/fixtures/linux-p0/mock-rollback-transaction.sh");
    expect(s).toContain("for fault in stage enospc hash start readiness log");
    expect(s).toContain("formal command count=0");
    expect(f.indexOf("candidate_gate log")).toBeLessThan(f.indexOf('"$P0_FORMAL_COMMAND"'));
  });
  it("covers preflight temporary trees and JSONL totals", async () => {
    const s = await read("tests/linux-candidate-p0-acceptance.sh");
    for (const token of ["preflight_recursive_cleanup", "preflight_quarantine", '{"type":%s', "PASS=%d FAIL=%d SKIP=%d TOTAL=%d", "cleanup_resources"]) expect(s).toContain(token);
  });
});
