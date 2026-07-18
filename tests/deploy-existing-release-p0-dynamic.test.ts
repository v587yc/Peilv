import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const testTmpRoot = path.join(root, ".test-tmp");
const deployPath = path.join(root, "scripts", "deploy-production.sh");
const releaseId = "r20260716000001-a1-0123456789ab";
const currentId = "r20260715000001-a1-abcdef012345";
const sha = "a".repeat(64);
const requestId = "12345678-1234-4234-8234-123456789abc";

describe("deploy existing release P0 regression", () => {
  beforeAll(async () => {
    await mkdir(testTmpRoot, { recursive: true });
    expect((await stat(testTmpRoot)).isDirectory()).toBe(true);
  });

  it("rejects an existing release without touching it or invoking mutation stages", async () => {
    const sandbox = await mkdtemp(path.join(testTmpRoot, "existing-release-"));
    try {
      const base = path.join(sandbox, "opt", "peilv");
      const release = path.join(base, "releases", releaseId);
      const sentinel = path.join(release, "sentinel");
      const calls = path.join(sandbox, "calls.log");
      await mkdir(release, { recursive: true, mode: 0o751 });
      await writeFile(sentinel, "existing-release-must-not-change\n", { mode: 0o640 });
      const beforeDir = await stat(release);
      const beforeFile = await stat(sentinel);
      const beforeHash = await exec("sha256sum", [sentinel]);

      let script = await readFile(deployPath, "utf8");
      script = script
        .replace("exec 9>/run/lock/peilv-deploy.lock", 'sandbox="$PEILV_TEST_SANDBOX"; exec 9>"$sandbox/deploy.lock"')
        .replace("base=/opt/peilv", 'base="$sandbox/opt/peilv"')
        .replaceAll("/usr/local/libexec/peilv/verify-release.sh", `printf 'extract\\n' >>"$sandbox/calls.log"; false #`)
        .replace("candidate_start \"$candidate_unit\"", `printf 'candidate\\n' >>"$sandbox/calls.log"; candidate_start "$candidate_unit"`)
        .replace("mv -T \"$release_dir\"", `printf 'mv\\n' >>"$sandbox/calls.log"; mv -T "$release_dir"`);
      const instrumented = path.join(sandbox, "deploy-production.sh");
      await writeFile(instrumented, script, { mode: 0o700 });

      await expect(exec("bash", ["./deploy-production.sh", releaseId, sha, currentId, requestId], { cwd: sandbox, env: { ...process.env, PEILV_TEST_SANDBOX: "." } })).rejects.toMatchObject({ code: 1 });

      const afterDir = await stat(release);
      const afterFile = await stat(sentinel);
      const afterHash = await exec("sha256sum", [sentinel]);
      expect(afterDir.ino).toBe(beforeDir.ino);
      expect(afterFile.ino).toBe(beforeFile.ino);
      expect(afterHash.stdout).toBe(beforeHash.stdout);
      expect(afterDir.mode).toBe(beforeDir.mode);
      expect(afterFile.mode).toBe(beforeFile.mode);
      await expect(stat(path.join(base, "quarantine", `${releaseId}.failed-${requestId}`))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(calls, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("quarantines a release created by this attempt when extraction fails", async () => {
    const sandbox = await mkdtemp(path.join(testTmpRoot, "created-release-"));
    try {
      const shellSandbox = sandbox.replaceAll("\\", "/");
      const deploy = await readFile(deployPath, "utf8");
      const quarantineFunction = deploy.slice(deploy.indexOf("quarantine_created_release() {"), deploy.indexOf("restore_on_failure() {"))
        .trim()
        .replace('install -d -o root -g root -m 0700 "$base/quarantine"', 'install -d -m 0700 "$base/quarantine"');
      const harness = `#!/usr/bin/env bash
set -Eeuo pipefail
base=${JSON.stringify(`${shellSandbox}/opt/peilv`)}
release_id=${JSON.stringify(releaseId)}
request_id=${JSON.stringify(requestId)}
release_dir="$base/releases/$release_id"
release_created=1
release_activated=0
${quarantineFunction}
mkdir -p "$release_dir"
printf 'partial\n' >"$release_dir/partial-extract"
set +e
false
status=$?
set -e
quarantine_created_release
quarantine_dir="$base/quarantine/\${release_id}.failed-\${request_id}"
[[ ! -e "$release_dir" ]] || exit 91
[[ -f "$quarantine_dir/partial-extract" ]] || exit 92
[[ "$(cat "$quarantine_dir/partial-extract")" == partial ]] || exit 93
[[ "$(cat "$quarantine_dir/QUARANTINED")" == failed-before-activation ]] || exit 94
exit "$status"
`;
      const harnessPath = path.join(sandbox, "restore-harness.sh");
      await writeFile(harnessPath, harness, { mode: 0o700 });
      let failure: unknown;
      try { await exec("bash", [harnessPath]); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 1 });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
