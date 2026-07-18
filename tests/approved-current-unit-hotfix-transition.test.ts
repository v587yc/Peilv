import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

describe("approved current unit hotfix transition", () => {
  it("is explicit and bound in both preflight and deploy", async () => {
    const [preflight, deploy] = await Promise.all([
      readFile(path.join(root, "scripts/production-preflight.sh"), "utf8"),
      readFile(path.join(root, "scripts/deploy-production.sh"), "utf8"),
    ]);
    for (const source of [preflight, deploy]) {
      expect(source).toContain("--approved-current-unit-hotfix-transition");
      expect(source).toContain("r20260716074436-a1-a8f074c3680f");
      expect(source).toContain("0014_admin_login_uniform_reservations");
      expect(source).toContain("HOSTNAME=127.0.0.1");
      expect(source).toContain("PORT=5000");
      expect(source).toContain("DEPLOY_RUN_PORT=5000");
    }
  });

  it.each([
    ["exact approved transition", "r20260716074436-a1-a8f074c3680f", "", true],
    ["different current", "r20260716074437-a1-a8f074c3680f", "", false],
    ["additional installed drift", "r20260716074436-a1-a8f074c3680f", "Environment=EXTRA=drift\n", false],
  ])("enforces %s", async (_name, currentId, extra, accepted) => {
    const sandbox = await mkdtemp(path.join(root, ".test-tmp-transition-"));
    try {
      const source = await readFile(path.join(root, "scripts/deploy-production.sh"), "utf8");
      const start = source.indexOf("approve_current_unit_hotfix_transition() {");
      const end = source.indexOf("stage_release_systemd_units() {", start);
      const fn = source.slice(start, end);
      const bin = path.join(sandbox, "bin"); await mkdir(bin);
      await writeFile(path.join(bin, "docker"), "#!/usr/bin/env bash\nprintf '0014_admin_login_uniform_reservations\\n'\n", { mode: 0o700 });
      await writeFile(path.join(bin, "ss"), "#!/usr/bin/env bash\nprintf 'LISTEN 0 511 127.0.0.1:5000 0.0.0.0:*\\n'\n", { mode: 0o700 });
      const base = "[Service]\nExecStart=/usr/bin/node /opt/peilv/current/server.js\n";
      await writeFile(path.join(sandbox, "current.service"), base);
      await writeFile(path.join(sandbox, "installed.service"), `${base}Environment=HOSTNAME=127.0.0.1\nEnvironment=PORT=5000\nEnvironment=DEPLOY_RUN_PORT=5000\n${extra}`);
      await writeFile(path.join(sandbox, "run.sh"), `#!/usr/bin/env bash\nset -Eeuo pipefail\nexport PATH="$1/bin:$PATH"\ntransition_confirmation=--approved-current-unit-hotfix-transition\nexpected_current_release_id=${currentId}\nold_release_id=${currentId}\nverify_app_unit_contract(){ [[ "$(grep -Ec '^Environment=(HOSTNAME=127.0.0.1|PORT=5000|DEPLOY_RUN_PORT=5000)$' "$1")" == 3 ]]; }\n${fn}\napprove_current_unit_hotfix_transition "$1/installed.service" "$1/current.service"\n`, { mode: 0o700 });
      let passed = true;
      try { await exec("bash", [path.join(sandbox, "run.sh"), sandbox]); } catch { passed = false; }
      expect(passed).toBe(accepted);
    } finally { await rm(sandbox, { recursive: true, force: true }); }
  }, 20_000);
});
