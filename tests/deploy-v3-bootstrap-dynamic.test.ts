import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const manifestName = "trusted-host-tcb-v3.sha256";
const runtimeNames = [
  "deploy-production.sh",
  "production-preflight.sh",
  "rollback-production.sh",
  "migration-contract.mjs",
  "deploy-operation-ledger.mjs",
  "peilv-control",
] as const;
const activationNames = [...runtimeNames, "peilv-sudoers", manifestName] as const;
const sources: Record<(typeof activationNames)[number], string> = {
  "deploy-production.sh": "scripts/deploy-production.sh",
  "production-preflight.sh": "scripts/production-preflight.sh",
  "rollback-production.sh": "scripts/rollback-production.sh",
  "migration-contract.mjs": "scripts/migration-contract.mjs",
  "deploy-operation-ledger.mjs": "scripts/deploy-operation-ledger.mjs",
  "peilv-control": "infra/deploy/peilv-control",
  "peilv-sudoers": "infra/deploy/peilv-sudoers",
  [manifestName]: `infra/deploy/${manifestName}`,
};
const modes: Record<(typeof activationNames)[number], number> = Object.fromEntries(
  activationNames.map(name => [name, name === "peilv-sudoers" ? 0o440 : name === manifestName ? 0o644 : 0o755]),
) as Record<(typeof activationNames)[number], number>;
const isWindows = process.platform === "win32";
const fixtureTimeout = isWindows ? 60_000 : 20_000;

function replaceExactly(source: string, oldValue: string, newValue: string) {
  const first = source.indexOf(oldValue);
  if (first < 0 || source.indexOf(oldValue, first + oldValue.length) >= 0) throw new Error(`Windows adapter contract drift: ${oldValue}`);
  return source.replace(oldValue, newValue);
}

function windowsMetadataAdapter(source: string) {
  let adapted = source.replaceAll("install -d -o root -g root -m", "install -d -m").replaceAll("install -o root -g root -m", "install -m");
  const replacements: Array<[string, string]> = [
    ['[[ "$(id -u)" == 0 ]]', "[[ 0 == 0 ]]"],
    ['install -d -m "$mode" "$dir"', 'mkdir -p "$dir"'],
    ['sync_dir(){ sync -f "$1" 2>/dev/null || sync -d "$1"; }', 'sync_dir(){ :; }'],
    ['sync -f "$temp";', ':;'],
    ['try{fs.fsyncSync(d)}finally{fs.closeSync(d)}', 'try{fs.fsyncSync(d)}catch(error){if(process.platform!=="win32"||error.code!=="EPERM")throw error}finally{fs.closeSync(d)}'],
    ["flock -n 9 ||", "true ||"],
    ["flock -n 8 ||", "true ||"],
    ['visudo -cf "$stage/peilv-sudoers"', "true # visudo fixture"],
  ];
  for (const [oldValue, newValue] of replacements) adapted = replaceExactly(adapted, oldValue, newValue);
  return adapted;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "deploy-v3-bootstrap-"));
  const stage = path.join(root, "stage");
  const sbin = path.join(root, "sbin");
  const libexec = path.join(root, "libexec");
  const etc = path.join(root, "etc");
  const sudoers = path.join(root, "sudoers");
  const state = path.join(root, "state");
  const adapterBin = path.join(root, "adapter-bin");
  await Promise.all([stage, sbin, libexec, etc, sudoers, state, adapterBin].map(dir => mkdir(dir)));
  await chmod(state, 0o700);

  for (const name of activationNames) {
    const target = path.join(stage, name);
    await writeFile(target, (await readFile(sources[name], "utf8")).replace(/\r\n/g, "\n"));
    await chmod(target, modes[name]);
  }

  const destinations: Record<(typeof activationNames)[number], string> = {
    "deploy-production.sh": path.join(libexec, "deploy-production.sh"),
    "production-preflight.sh": path.join(libexec, "production-preflight.sh"),
    "rollback-production.sh": path.join(libexec, "rollback-production.sh"),
    "migration-contract.mjs": path.join(libexec, "migration-contract.mjs"),
    "deploy-operation-ledger.mjs": path.join(libexec, "deploy-operation-ledger.mjs"),
    "peilv-control": path.join(sbin, "peilv-control"),
    "peilv-sudoers": path.join(sudoers, "peilv"),
    [manifestName]: path.join(etc, manifestName),
  };
  for (const name of activationNames) {
    await writeFile(destinations[name], `OLD:${name}\n`);
    await chmod(destinations[name], modes[name]);
  }

  const productionScript = await readFile("infra/deploy/bootstrap-deploy-v3.sh", "utf8");
  let script = productionScript;
  if (isWindows) script = windowsMetadataAdapter(productionScript);
  const harness = path.join(root, "bootstrap.sh");
  await writeFile(harness, script);
  await chmod(harness, 0o700);

  const shellPath = (value: string) => isWindows
    ? value.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll("\\", "/")
    : value;
  if (isWindows) {
    const statAdapter = `#!/usr/bin/env bash
set -euo pipefail
real=/usr/bin/stat
format=''; target="${"${!#}"}"
for ((i=1;i<=$#;i++)); do [[ "${"${!i}"}" != -c ]] || { j=$((i+1)); format="${"${!j}"}"; }; done
if [[ "$format" == '%U:%G:%h:%a' || "$format" == '%U:%G:%a:%h' ]]; then
  nlink="$($real -c %h "$target")"; owner=root:root; base="${"${target##*/}"}"
  [[ "${"${PEILV_TEST_BAD_OWNER:-}"}" != "$target" ]] || owner=nobody:nogroup
  if [[ -d "$target" ]]; then case "$base" in state|deploy-operations|deploy-results) mode=700;; *) mode=755;; esac
  else case "$base" in peilv|peilv-sudoers) mode=440;; ${manifestName}) mode=644;; *) mode=755;; esac; fi
  [[ "${"${PEILV_TEST_BAD_MODE:-}"}" != "$target" ]] || mode=777
  [[ "$format" == '%U:%G:%h:%a' ]] && printf '%s:%s:%s\n' "$owner" "$nlink" "$mode" || printf '%s:%s:%s\n' "$owner" "$mode" "$nlink"
else exec "$real" "$@"; fi
`;
    const statPath = path.join(adapterBin, "stat");
    await writeFile(statPath, statAdapter);
    await chmod(statPath, 0o755);
  }

  const baseEnv = {
    ...process.env,
    PEILV_GLOBAL_LOCK: shellPath(path.join(root, "global.lock")),
    PEILV_TCB_LOCK: shellPath(path.join(root, "tcb.lock")),
    PEILV_TCB_SBIN: shellPath(sbin),
    PEILV_TCB_LIBEXEC: shellPath(libexec),
    PEILV_TCB_ETC: shellPath(etc),
    PEILV_TCB_SUDOERS: shellPath(sudoers),
    PEILV_TCB_STATE_ROOT: shellPath(state),
    PATH: isWindows ? `${shellPath(adapterBin)}:${process.env.PATH}` : process.env.PATH,
  };
  if (!isWindows) {
    await exec("sudo", ["chown", "-R", "root:root", root]);
    await exec("sudo", ["chmod", "700", root, state]);
    for (const name of activationNames) await exec("sudo", ["chmod", modes[name].toString(8), path.join(stage, name), destinations[name]]);
    for (const dir of [stage, sbin, libexec, etc, sudoers]) await exec("sudo", ["chmod", "755", dir]);
  }
  const run = (extraEnv: Record<string, string | undefined> = {}, recover = false) => {
    const args = [shellPath(harness), ...(recover ? ["recover-tcb-v3"] : []), shellPath(stage)];
    if (isWindows) return exec("bash", args, { env: { ...baseEnv, ...extraEnv } });
    const environment = Object.entries({ ...baseEnv, ...extraEnv }).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([key, value]) => `${key}=${value}`);
    return exec("sudo", ["env", ...environment, "bash", ...args]);
  };
  const readTrusted = async (target: string) => isWindows ? readFile(target, "utf8") : (await exec("sudo", ["cat", target])).stdout;
  const snapshot = async () => Object.fromEntries(
    await Promise.all(activationNames.map(async name => [name, await readTrusted(destinations[name])])),
  );
  return { stage, state, destinations, run, snapshot, readTrusted };
}

describe("deploy v3 Host TCB bootstrap crash-consistent transaction", () => {
  if (process.env.HOST_TCB_LINUX_REAL_SEMANTICS === "1") {
    it("runs the unmodified production bootstrap as root on Linux", () => {
      expect(process.platform).toBe("linux");
      expect(process.getuid?.()).toBe(0);
      expect(process.env.HOST_TCB_EXPECT_ROOT).toBe("1");
    });
  }
  it("activates the exact set with the trusted manifest as commit marker", async () => {
    const f = await fixture();
    await expect(f.run()).resolves.toMatchObject({ stdout: expect.stringContaining("six-runtime exact set") });
    for (const name of activationNames) expect(await f.readTrusted(f.destinations[name])).toBe(await f.readTrusted(path.join(f.stage, name)));
  }, fixtureTimeout);

  it.each(activationNames.filter(name => name !== manifestName))("recovers the old generation after SIGKILL following %s activation", async point => {
    const f = await fixture();
    const before = await f.snapshot();
    await expect(f.run({ PEILV_TCB_FAIL_AFTER: point })).rejects.toBeDefined();
    await expect(f.run({}, true)).resolves.toMatchObject({ stdout: expect.stringContaining("old generation retained") });
    expect(await f.snapshot()).toEqual(before);
  }, fixtureTimeout);

  it.each(activationNames)("recovers a target-to-backup SIGKILL interruption for %s", async point => {
    const f = await fixture();
    const before = await f.snapshot();
    await expect(f.run({ PEILV_TCB_FAIL_AFTER: `${point}:backup` })).rejects.toBeDefined();
    await expect(f.run({}, true)).resolves.toMatchObject({ stdout: expect.stringContaining("old generation retained") });
    expect(await f.snapshot()).toEqual(before);
  }, fixtureTimeout);

  it("retains a fully committed generation after SIGKILL following manifest activation", async () => {
    const f = await fixture();
    await expect(f.run({ PEILV_TCB_FAIL_AFTER: manifestName })).rejects.toBeDefined();
    await expect(f.run({}, true)).resolves.toMatchObject({ stdout: expect.stringContaining("new generation retained") });
    for (const name of activationNames) expect(await f.readTrusted(f.destinations[name])).toBe(await f.readTrusted(path.join(f.stage, name)));
  }, fixtureTimeout);

  it("resumes recovery after recovery itself is SIGKILLed", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    await expect(f.run({ PEILV_TCB_FAIL_AFTER: "peilv-sudoers" })).rejects.toBeDefined();
    await expect(f.run({ PEILV_TCB_RECOVERY_FAIL_AFTER: "migration-contract.mjs" }, true)).rejects.toBeDefined();
    await expect(f.run({}, true)).resolves.toMatchObject({ stdout: expect.stringContaining("old generation retained") });
    expect(await f.snapshot()).toEqual(before);
  }, 60_000);

  it("fails closed when a committed manifest points at a mixed runtime generation", async () => {
    const f = await fixture();
    await expect(f.run({ PEILV_TCB_FAIL_AFTER: manifestName })).rejects.toBeDefined();
    await writeFile(f.destinations["deploy-production.sh"], "MIXED\n");
    await chmod(f.destinations["deploy-production.sh"], modes["deploy-production.sh"]);
    await expect(f.run({}, true)).rejects.toMatchObject({ stderr: expect.stringContaining("Committed TCB generation is mixed") });
  });

  it("rejects a CRLF staged executable before writing a durable journal", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    await writeFile(path.join(f.stage, "deploy-production.sh"), "#!/bin/sh\r\nexit 0\r\n");
    await chmod(path.join(f.stage, "deploy-production.sh"), modes["deploy-production.sh"]);
    await expect(f.run()).rejects.toBeDefined();
    expect(await f.snapshot()).toEqual(before);
    await expect(readFile(path.join(f.state, "tcb-v3-activation.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
