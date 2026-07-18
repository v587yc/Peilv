import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const entries = ["scripts/deploy-production.sh", "scripts/rollback-production.sh"];

describe("disk-backed candidate staging acceptance contract", () => {
  it("centralizes filesystem, capacity, ownership and symlink controls", async () => {
    const helper = await read("scripts/lib/candidate-stage.sh");
    expect(helper).toContain("/var/lib/peilv/candidate-stage");
    expect(helper).toMatch(/tmpfs\|ramfs/);
    expect(helper).toContain('"$links" -ge 2');
    expect(helper).toContain('! -L "$CANDIDATE_STAGE_ROOT"');
    expect(helper).toContain("candidate_check_capacity");
    expect(helper).toContain("CANDIDATE_MIN_MARGIN_KIB");
    expect(helper).toContain("candidate_tree_hash");
  });

  it.each(entries)("uses the shared staging and lifecycle policy in %s", async path => {
    const script = await read(path);
    expect(script).toContain("candidate-stage.sh");
    expect(script).toContain("candidate-lifecycle.sh");
    expect(script).toContain("/var/lib/peilv/candidate-stage");
    expect(script).toContain("candidate_prepare_stage");
    expect(script).toContain("candidate_start");
    expect(script).toContain("candidate_probe");
    expect(script).toContain("candidate_stop_and_release");
    expect(script.indexOf("candidate_prepare_stage")).toBeLessThan(script.indexOf("candidate_start", script.indexOf("candidate_started_at=")));
  });

  it("exposes only a read-only tree and hides production state", async () => {
    const lifecycle = await read("scripts/lib/candidate-lifecycle.sh");
    expect(lifecycle).toContain('BindReadOnlyPaths=$stage:$candidate_mount');
    for (const path of ["/opt/peilv/shared", "/opt/peilv/backups", "/opt/peilv/releases", "/opt/peilv/incoming", "/etc/peilv", "/var/lib/peilv"]) expect(lifecycle).toContain(path);
    expect(lifecycle).not.toContain("ReadWritePaths=$stage");
  });

  it.each(entries)("cleans only after lifecycle proof in %s", async path => {
    const script = await read(path);
    const start = script.indexOf("stop_candidate() {");
    const body = script.slice(start, script.indexOf("\ncheck_candidate_application()", start));
    expect(body.indexOf("candidate_stop_and_release")).toBeLessThan(body.lastIndexOf("candidate_cleanup_stage"));
    expect(body).not.toContain('|| true');
    expect(script.slice(script.indexOf("restore_on_failure()"), script.indexOf("trap restore_on_failure EXIT"))).toContain("stop_candidate");
  });
});
