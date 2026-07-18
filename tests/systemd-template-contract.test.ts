import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFile(path.join(root, relative), "utf8");
const required = [
  "Environment=HOSTNAME=127.0.0.1",
  "Environment=PORT=5000",
  "Environment=DEPLOY_RUN_PORT=5000",
];

describe("systemd production listener contract", () => {
  it("declares the exact production variables once and starts the variable-aware server", async () => {
    const [unit, server] = await Promise.all([read("infra/systemd/peilv.service"), read("src/server.ts")]);
    for (const line of required) expect(unit.split(/\r?\n/).filter(value => value === line)).toHaveLength(1);
    expect(unit).not.toMatch(/0\.0\.0\.0|(?:PORT|DEPLOY_RUN_PORT)=3000/);
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/peilv/current/server.js");
    for (const variable of ["HOSTNAME", "PORT", "DEPLOY_RUN_PORT"]) expect(server).toContain(`process.env.${variable}`);
  });

  it("copies the source unit into a release without changing the Bootstrap CLI allowlist", async () => {
    const [create, verify] = await Promise.all([read("scripts/create-release.sh"), read("scripts/verify-release.sh")]);
    expect(create).toContain('cp infra/systemd/peilv.service');
    for (const content of [create, verify]) {
      expect(content).toContain("allowed_release_script_paths=(scripts/admin-bootstrap.mjs scripts/run-migrations.mjs)");
      expect(content).toContain("scripts/admin-bootstrap.mjs");
      expect(content).toContain("scripts/run-migrations.mjs");
    }
    expect(verify).toContain('verify_app_unit_contract "$root/infra/systemd/peilv.service"');
  });

  it("makes preflight and deploy fail closed for missing or drifted units", async () => {
    const [preflight, deploy] = await Promise.all([read("scripts/production-preflight.sh"), read("scripts/deploy-production.sh")]);
    expect(preflight).toContain('verify_app_unit_contract "$candidate_app_unit"');
    expect(preflight).toContain('cmp -s "$installed_app_unit" "$current_app_unit"');
    expect(preflight).toContain('verify_app_unit_contract "$installed_app_unit"');
    expect(preflight).toContain("active_app_unit_release_binding");
    expect(deploy).toContain('verify_app_unit_contract "$release/infra/systemd/peilv.service" || return 1');
    expect(deploy).toContain("verify_installed_app_unit_binding");
    expect(deploy).toContain('cmp -s "$installed" "$current"');
    expect(deploy).toContain('verify_app_unit_contract "$installed"');
  });

  it("keeps the candidate runtime override on loopback port 5001", async () => {
    const lifecycle = await read("scripts/lib/candidate-lifecycle.sh");
    expect(lifecycle).toContain("HOSTNAME=127.0.0.1 PORT=5001 DEPLOY_RUN_PORT=5001");
  });

  it("release archive contains the byte-identical source unit and allowed CLI", async () => {
    if (process.platform === "win32") return;
    const temp = await mkdtemp(path.join(root, ".test-tmp", "systemd-release-"));
    try {
      const sha = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
      const runId = `${Date.now()}${process.pid}`;
      const releaseId = `r${runId}-a1-${sha.slice(0, 12)}`;
      await exec("bash", ["scripts/create-release.sh", releaseId, sha, "1", "local/peilv", runId, "1"], { cwd: root });
      const archive = path.join(root, "release-artifacts", `peilv-${releaseId}.tar.gz`);
      const checksum = `${archive}.sha256`;
      await exec("bash", ["scripts/verify-release.sh", archive, checksum], { cwd: root });
      await exec("tar", ["-xzf", archive, "-C", temp], { cwd: root });
      expect(await readFile(path.join(temp, "infra/systemd/peilv.service"), "utf8")).toBe(await read("infra/systemd/peilv.service"));
      expect(await readFile(path.join(temp, "scripts/admin-bootstrap.mjs"), "utf8")).toBe(await read("scripts/admin-bootstrap.mjs"));
      await rm(archive, { force: true });
      await rm(checksum, { force: true });
      await rm(path.join(root, "release-artifacts", `release-manifest-${releaseId}.json`), { force: true });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
