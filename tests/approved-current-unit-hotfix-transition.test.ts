import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

describe("approved current unit hotfix transition", () => {
  it("remains explicit in preflight but cannot expand the deploy ABI", async () => {
    const [preflight, deploy] = await Promise.all([
      readFile(path.join(root, "scripts/production-preflight.sh"), "utf8"),
      readFile(path.join(root, "scripts/deploy-production.sh"), "utf8"),
    ]);
    expect(preflight).toContain("--approved-current-unit-hotfix-transition");
    expect(preflight).toContain("r20260716074436-a1-a8f074c3680f");
    expect(preflight).toContain("0014_admin_login_uniform_reservations");
    expect(deploy).not.toContain("--approved-current-unit-hotfix-transition");
    expect(deploy).toContain('verify_app_unit_contract "$installed" && verify_app_unit_contract "$current" && cmp -s "$installed" "$current"');
  });

  it.each([
    ["exact approved transition", "r20260716074436-a1-a8f074c3680f", "", true],
    ["different current", "r20260716074437-a1-a8f074c3680f", "", false],
    ["additional installed drift", "r20260716074436-a1-a8f074c3680f", "Environment=EXTRA=drift\n", false],
  ])("enforces %s", async (_name, currentId, extra, accepted) => {
    const sandbox = await mkdtemp(path.join(root, ".test-tmp-transition-"));
    try {
      const source = await readFile(path.join(root, "scripts/production-preflight.sh"), "utf8");
      const start = source.indexOf("verify_app_unit_contract() {");
      const end = source.indexOf("if (( peak_storage_budget_ok", start);
      const fn = source.slice(start, end);
      const bin = path.join(sandbox, "bin"); await mkdir(bin);
      const base = "[Service]\nExecStart=/usr/bin/node /opt/peilv/current/server.js\n";
      await writeFile(path.join(sandbox, "current.service"), base);
      await writeFile(path.join(sandbox, "installed.service"), `${base}Environment=HOSTNAME=127.0.0.1\nEnvironment=PORT=5000\nEnvironment=DEPLOY_RUN_PORT=5000\n${extra}`);
      await writeFile(path.join(sandbox, "candidate.service"), `${base}Environment=HOSTNAME=127.0.0.1\nEnvironment=PORT=5000\nEnvironment=DEPLOY_RUN_PORT=5000\n`);
      await writeFile(path.join(sandbox, "run.sh"), `#!/usr/bin/env bash\nset -Eeuo pipefail\ntransition_confirmation=--approved-current-unit-hotfix-transition\n${fn}\napprove_current_unit_hotfix_transition ${currentId} "$1/current.service" "$1/installed.service" "$1/candidate.service" 0 0 0014_admin_login_uniform_reservations 'LISTEN 0 511 127.0.0.1:5000 0.0.0.0:*'\n`, { mode: 0o700 });
      let passed = true;
      try { await exec("bash", [path.join(sandbox, "run.sh"), sandbox]); } catch { passed = false; }
      expect(passed).toBe(accepted);
    } finally { await rm(sandbox, { recursive: true, force: true }); }
  }, 20_000);
});
