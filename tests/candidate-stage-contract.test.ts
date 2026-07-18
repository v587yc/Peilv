import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (file: string) => readFile(new URL(file, root), "utf8");

describe("disk-backed candidate staging contract", () => {
  it("shares one fixed staging policy between deploy, rollback and preflight", async () => {
    const [helper, deploy, rollback, preflight] = await Promise.all([
      read("scripts/lib/candidate-stage.sh"),
      read("scripts/deploy-production.sh"),
      read("scripts/rollback-production.sh"),
      read("scripts/production-preflight.sh"),
    ]);
    expect(helper).toContain("/var/lib/peilv/candidate-stage");
    expect(helper).not.toContain("/run/peilv-candidate-stage");
    for (const script of [deploy, rollback, preflight]) {
      expect(script).toContain("candidate-stage.sh");
      expect(script).toContain("/var/lib/peilv/candidate-stage");
    }
    expect(preflight).toContain('candidate_check_capacity "$verified_tree"');
  });

  it("rejects tmpfs, bad ownership/mode, symlink roots and insufficient space", async () => {
    const helper = await read("scripts/lib/candidate-stage.sh");
    expect(helper).toMatch(/tmpfs\|ramfs/);
    expect(helper).toContain('"$links" -ge 2');
    expect(helper).toContain('! -L "$CANDIDATE_STAGE_ROOT"');
    expect(helper).toContain("available_kib < required_kib");
    expect(helper).toContain("CANDIDATE_MIN_MARGIN_KIB");
  });

  it("copies as root, compares tree hashes, then grants read-only candidate access", async () => {
    const helper = await read("scripts/lib/candidate-stage.sh");
    const copy = helper.indexOf('cp -a -- "$source/." "$stage/"');
    const compare = helper.indexOf('[[ "$stage_hash" == "$source_hash" ]]');
    const chown = helper.indexOf('chown -R root:peilv-candidate');
    expect(copy).toBeGreaterThan(-1);
    expect(compare).toBeGreaterThan(copy);
    expect(chown).toBeGreaterThan(compare);
    expect(helper).toContain("find -P");
    expect(helper).toContain("chmod 0550");
    expect(helper).toContain("chmod 0440");
  });

  it("binds only the candidate tree and hides all production state trees", async () => {
    for (const file of ["scripts/deploy-production.sh", "scripts/rollback-production.sh"]) {
      const script = await read(file);
      expect(script).toContain("candidate_start");
      expect(script).toContain("candidate-lifecycle.sh");
    }
  });

  it("cleans exactly one validated release directory on success and failure", async () => {
    const helper = await read("scripts/lib/candidate-stage.sh");
    expect(helper).toContain('stage="$(candidate_stage_path "$release_id")"');
    expect(helper).toContain("rm -rf --one-file-system");
    expect(helper).toContain("Invalid candidate release ID");
    for (const file of ["scripts/deploy-production.sh", "scripts/rollback-production.sh"]) {
      const script = await read(file);
      expect(script).toContain("candidate_cleanup_stage");
      expect(script).toMatch(/trap restore_on_failure EXIT/);
      expect(script).toMatch(/stop_candidate[\s\S]*candidate_stop_and_release[\s\S]*candidate_cleanup_stage/);
    }
  });

  it("keeps candidate staging outside deployment WAL state", async () => {
    for (const file of ["scripts/deploy-production.sh", "scripts/rollback-production.sh"]) {
      const script = await read(file);
      const walBody = script.slice(script.indexOf("write_transaction_state()"), script.indexOf("verify_installed_curl_secret_helper"));
      expect(walBody).not.toContain("candidate_stage");
    }
  });
});
