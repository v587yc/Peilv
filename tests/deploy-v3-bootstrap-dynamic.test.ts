import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const manifestName = "trusted-host-tcb-v3.sha256";
const policyName = "legacy-sudoers-retirement-v1.sha256";
const legacyName = "legacy-sudoers-retirement";
const legacyV2Name = "legacy-v2-manifest-retirement";
const runtimeNames = ["deploy-production.sh", "production-preflight.sh", "rollback-production.sh", "migration-contract.mjs", "deploy-operation-ledger.mjs", "peilv-control"] as const;
const installNames = [...runtimeNames, "peilv-sudoers", policyName, manifestName] as const;
const transactionNames = [...runtimeNames, "peilv-sudoers", policyName, legacyName, legacyV2Name, manifestName] as const;
const sources: Record<string, string> = {
  "deploy-production.sh": "scripts/deploy-production.sh", "production-preflight.sh": "scripts/production-preflight.sh",
  "rollback-production.sh": "scripts/rollback-production.sh", "migration-contract.mjs": "scripts/migration-contract.mjs",
  "deploy-operation-ledger.mjs": "scripts/deploy-operation-ledger.mjs", "peilv-control": "infra/deploy/peilv-control",
  "peilv-sudoers": "infra/deploy/peilv-sudoers", [policyName]: `infra/deploy/${policyName}`, [manifestName]: `infra/deploy/${manifestName}`,
};
const modes: Record<string, number> = Object.fromEntries(transactionNames.map(name => [name, name === "peilv-sudoers" || name === legacyName ? 0o440 : name === manifestName || name === policyName || name === legacyV2Name ? 0o644 : 0o755]));
const approvedLegacy = "Defaults:peilv-audit env_reset,use_pty\nDefaults:peilv-deploy env_reset,use_pty\nDefaults:peilv-rollback env_reset,use_pty\npeilv-audit ALL=(root) NOPASSWD: /usr/local/sbin/peilv-control preflight *\npeilv-deploy ALL=(root) NOPASSWD: /usr/local/sbin/peilv-control deploy *\npeilv-rollback ALL=(root) NOPASSWD: /usr/local/sbin/peilv-control rollback *\n";
const approvedV2Manifest = "ce04c6263d66bb85424b238dd1bd494b0d419653a6564f40019154f02448b536 peilv-control\n03db0d56bad0a92d04721629f63fccc9f402bd8b9087b5ddca34e7434d889367 deploy-production.sh\n4042a7c69e5aaa41bf26a9e55f72740be1213d8c6dedc5e95ae3573460042923 migration-contract.mjs\n1c94d0424a6a7b66734e5b5ac9102a19aee04a9cc42a43ba4f29b122cc6d35b6 deploy-operation-ledger.mjs\n";
const approvedOldBytes = new Map<string, Promise<Buffer>>();
const approvedFixtures = {
  "infra/deploy/peilv-control": { path: "tests/fixture-peilv-control-v3-old", sha256: "5d4e408f2e72550cb783add81a892643613aacea91596853c6bed79bb048ec95" },
  "infra/deploy/trusted-host-tcb-v3.sha256": { path: "tests/fixture-trusted-host-tcb-v3-old.sha256", sha256: "bb73c2d965c6fa8f3d62a57ed50597a493ce18da226e544f4a42790e5ae4d943" },
} as const;
const isWindows = process.platform === "win32";
const fixtureTimeout = isWindows ? 90_000 : 30_000;

function replaceExactly(source: string, oldValue: string, newValue: string) {
  const first = source.indexOf(oldValue);
  if (first < 0 || source.indexOf(oldValue, first + oldValue.length) >= 0) throw new Error(`Windows adapter contract drift: ${oldValue}`);
  return source.replace(oldValue, newValue);
}
function windowsMetadataAdapter(source: string) {
  let adapted = source.replaceAll("install -d -o root -g root -m", "install -d -m").replaceAll("install -o root -g root -m", "install -m");
  adapted = adapted.replaceAll('try{fs.fsyncSync(d)}finally{fs.closeSync(d)}', 'try{fs.fsyncSync(d)}catch(error){if(error.code!=="EPERM")throw error}finally{fs.closeSync(d)}');
  adapted = adapted.replaceAll('try{fs.fsyncSync(f)}finally{fs.closeSync(f)}', 'try{fs.fsyncSync(f)}catch(error){if(error.code!=="EPERM")throw error}finally{fs.closeSync(f)}');
  adapted = adapted.replaceAll('install -d -m 700 "$evidence"', 'mkdir -p "$evidence"');
  for (const [oldValue, newValue] of [
    ['[[ "$(id -u)" == 0 ]]', "[[ 0 == 0 ]]"], ['install -d -m "$mode" "$dir"', 'mkdir -p "$dir"'],
    ['sync_dir(){ sync -f "$1" 2>/dev/null || sync -d "$1"; }', 'sync_dir(){ :; }'], ['sync -f "$temp";', ':;'],
    ["flock -n 9 ||", "true ||"], ["flock -n 8 ||", "true ||"], ['visudo -cf "$stage/peilv-sudoers"', "true # staged visudo fixture"],
    ['visudo -cf "$expected_sudoers" >/dev/null', "true # graph visudo fixture"],
  ] as Array<[string, string]>) adapted = replaceExactly(adapted, oldValue, newValue);
  return adapted;
}

type FixtureOptions = { legacy?: "approved" | "absent" | "unknown" | "symlink" | "hardlink"; legacyMode?: number; legacyOwner?: "root" | "nobody"; legacyV2?: "approved" | "absent" | "unknown"; conflict?: string; extraLegacy?: boolean; extraV2?: boolean; unknownExisting?: string };
async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "deploy-v3-bootstrap-"));
  const stage = path.join(root, "stage"), sbin = path.join(root, "sbin"), libexec = path.join(root, "libexec"), etc = path.join(root, "etc"), sudoers = path.join(root, "sudoers.d"), state = path.join(root, "state"), adapterBin = path.join(root, "adapter-bin"), sudoersMain = path.join(root, "sudoers-main");
  await Promise.all([stage, sbin, libexec, etc, sudoers, state, adapterBin].map(dir => mkdir(dir)));
  await chmod(state, 0o700);
  await writeFile(sudoersMain, `@includedir ${sudoers}\n`); await chmod(sudoersMain, 0o440);
  for (const name of installNames) { const target = path.join(stage, name); await writeFile(target, (await readFile(sources[name], "utf8")).replace(/\r\n/g, "\n")); await chmod(target, modes[name]); }
  const destinations: Record<string, string> = {
    "deploy-production.sh": path.join(libexec, "deploy-production.sh"), "production-preflight.sh": path.join(libexec, "production-preflight.sh"),
    "rollback-production.sh": path.join(libexec, "rollback-production.sh"), "migration-contract.mjs": path.join(libexec, "migration-contract.mjs"),
    "deploy-operation-ledger.mjs": path.join(libexec, "deploy-operation-ledger.mjs"), "peilv-control": path.join(sbin, "peilv-control"),
    "peilv-sudoers": path.join(sudoers, "peilv"), [policyName]: path.join(etc, policyName), [legacyName]: path.join(sudoers, "peilv-deploy"), [legacyV2Name]: path.join(etc, "trusted-deploy-v2.sha256"), [manifestName]: path.join(etc, manifestName),
  };
  for (const name of installNames) {
    if (name === policyName) continue;
    const gitPath = name === "peilv-sudoers" || name === "peilv-control" || name === manifestName ? `infra/deploy/${name === "peilv-sudoers" ? "peilv-sudoers" : name}` : `scripts/${name}`;
    if (!approvedOldBytes.has(gitPath)) approvedOldBytes.set(gitPath, readFile(approvedFixtures[gitPath as keyof typeof approvedFixtures]?.path ?? gitPath));
    const oldBytes = await approvedOldBytes.get(gitPath)!;
    await writeFile(destinations[name], oldBytes); await chmod(destinations[name], modes[name]);
  }
  const legacy = options.legacy ?? "approved";
  if (legacy === "approved" || legacy === "unknown" || legacy === "hardlink") { await writeFile(destinations[legacyName], legacy === "unknown" ? "UNKNOWN\n" : approvedLegacy); await chmod(destinations[legacyName], options.legacyMode ?? 0o440); }
  if (legacy === "symlink") {
    if (isWindows) await exec("bash", ["-c", "ln -s -- \"$1\" \"$2\"", "bash", destinations["peilv-sudoers"], destinations[legacyName]]);
    else await symlink(destinations["peilv-sudoers"], destinations[legacyName]);
  }
  if (legacy === "hardlink") await link(destinations[legacyName], path.join(root, "legacy-hardlink"));
  if (options.extraLegacy) { await writeFile(path.join(sudoers, "peilv-deploy-extra"), approvedLegacy); await chmod(path.join(sudoers, "peilv-deploy-extra"), 0o440); }
  const legacyV2 = options.legacyV2 ?? "approved";
  if (legacyV2 !== "absent") { await writeFile(destinations[legacyV2Name], legacyV2 === "approved" ? approvedV2Manifest : "UNKNOWN V2\n"); await chmod(destinations[legacyV2Name], 0o644); }
  if (options.extraV2) { await writeFile(path.join(etc, "trusted-deploy-v2.sha256.extra"), approvedV2Manifest); await chmod(path.join(etc, "trusted-deploy-v2.sha256.extra"), 0o644); }
  if (options.unknownExisting) { await chmod(destinations[options.unknownExisting], 0o600); await writeFile(destinations[options.unknownExisting], "UNAPPROVED EXISTING\n"); await chmod(destinations[options.unknownExisting], modes[options.unknownExisting]); }
  if (options.conflict) { await writeFile(path.join(sudoers, "other"), options.conflict); await chmod(path.join(sudoers, "other"), 0o440); }

  const productionScript = await readFile("infra/deploy/bootstrap-deploy-v3.sh", "utf8");
  const harness = path.join(root, "bootstrap.sh"); await writeFile(harness, isWindows ? windowsMetadataAdapter(productionScript) : productionScript); await chmod(harness, 0o700);
  const shellPath = (value: string) => isWindows ? value.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replaceAll("\\", "/") : value;
  if (isWindows) {
    const statAdapter = `#!/usr/bin/env bash\nset -euo pipefail\nreal=/usr/bin/stat; format=''; target="${"${!#}"}"\nfor ((i=1;i<=$#;i++)); do [[ "${"${!i}"}" != -c ]] || { j=$((i+1)); format="${"${!j}"}"; }; done\nif [[ "$format" == '%U:%G:%h:%a' || "$format" == '%U:%G:%a:%h' || "$format" == '%U:%G:%a' ]]; then nlink="$($real -c %h "$target")"; owner=root:root; base="${"${target##*/}"}"; [[ "${"${PEILV_TEST_BAD_OWNER:-}"}" != "$target" ]] || owner=nobody:nogroup; if [[ -d "$target" ]]; then case "$target" in */state|*/tcb-forensics|*/tcb-forensics/*) mode=700;; *) mode=755;; esac; else case "$base" in peilv|peilv-sudoers|peilv-deploy) mode=440;; ${manifestName}|${policyName}|trusted-deploy-v2.sha256|bundle.json|*.old) mode=644;; *) mode=755;; esac; fi; [[ "${"${PEILV_TEST_BAD_MODE:-}"}" != "$target" ]] || mode=777; if [[ "$format" == '%U:%G:%h:%a' ]]; then printf '%s:%s:%s\\n' "$owner" "$nlink" "$mode"; elif [[ "$format" == '%U:%G:%a:%h' ]]; then printf '%s:%s:%s\\n' "$owner" "$mode" "$nlink"; else printf '%s:%s\\n' "$owner" "$mode"; fi; else exec "$real" "$@"; fi\n`;
    await writeFile(path.join(adapterBin, "stat"), statAdapter); await chmod(path.join(adapterBin, "stat"), 0o755);
  }
  if (!isWindows) { await exec("sudo", ["chown", "-R", "root:root", root]); for (const name of installNames) await exec("sudo", ["chmod", modes[name].toString(8), path.join(stage, name), destinations[name]]); await exec("sudo", ["chmod", "0440", sudoersMain]); for (const dir of [stage, sbin, libexec, etc, sudoers]) await exec("sudo", ["chmod", "0755", dir]); await exec("sudo", ["chmod", "0700", state]); if (options.legacyOwner === "nobody") await exec("sudo", ["chown", "nobody:nogroup", destinations[legacyName]]); }
  const baseEnv = { ...process.env, PEILV_GLOBAL_LOCK: shellPath(path.join(root, "global.lock")), PEILV_TCB_LOCK: shellPath(path.join(root, "tcb.lock")), PEILV_TCB_SBIN: shellPath(sbin), PEILV_TCB_LIBEXEC: shellPath(libexec), PEILV_TCB_ETC: shellPath(etc), PEILV_TCB_SUDOERS: shellPath(sudoers), PEILV_TCB_SUDOERS_MAIN: shellPath(sudoersMain), PEILV_TCB_STATE_ROOT: shellPath(state), PATH: isWindows ? `${shellPath(adapterBin)}:${process.env.PATH}` : process.env.PATH };
  const run = (extraEnv: Record<string, string | undefined> = {}, recover = false) => { const args = [shellPath(harness), ...(recover ? ["recover-tcb-v3"] : []), shellPath(stage)]; if (isWindows) return exec("bash", args, { env: { ...baseEnv, ...extraEnv } }); const environment = Object.entries({ ...baseEnv, ...extraEnv }).filter((x): x is [string, string] => typeof x[1] === "string").map(([k, v]) => `${k}=${v}`); return exec("sudo", ["env", ...environment, "bash", ...args]); };
  const readTrusted = async (target: string) => isWindows ? readFile(target, "utf8") : (await exec("sudo", ["cat", target])).stdout;
  const absent = async (target: string) => exec("bash", ["-c", "[[ ! -e \"$1\" && ! -L \"$1\" ]]", "bash", target]).then(() => true, () => false);
  const snapshot = async () => Object.fromEntries(await Promise.all(transactionNames.map(async name => [name, await absent(destinations[name]) ? null : await readTrusted(destinations[name])])));
  return { root, stage, state, evidenceRoot: path.join(state, "tcb-forensics"), destinations, run, snapshot, readTrusted, absent, metadataTarget: (target: string) => shellPath(target) };
}

describe("deploy v3 legacy sudoers retirement transaction", () => {
  it.each(Object.values(approvedFixtures))("pins approved old-byte fixture $path to exact LF-only bytes", async approved => {
    const bytes = await readFile(approved.path);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(approved.sha256);
    expect(bytes.includes(0x0d)).toBe(false);
    expect(bytes.at(-1)).toBe(0x0a);
  });
  if (process.env.HOST_TCB_LINUX_REAL_SEMANTICS === "1") it("runs unmodified bootstrap with real root metadata and visudo", () => { expect(process.platform).toBe("linux"); expect(process.getuid?.()).toBe(0); });
  it.each(["absent", "approved"] as const)("activates all-new with legacy %s", async legacy => { const f = await fixture({ legacy }); await expect(f.run()).resolves.toMatchObject({ stdout: expect.stringContaining("legacy sudoers retired") }); expect(await f.absent(f.destinations[legacyName])).toBe(true); expect(await f.absent(f.destinations[legacyV2Name])).toBe(true); for (const name of installNames) expect(await f.readTrusted(f.destinations[name])).toBe(await f.readTrusted(path.join(f.stage, name))); }, fixtureTimeout);
  it.each(["unknown", "symlink", "hardlink"] as const)("rejects unsafe legacy %s with zero mutation", async legacy => { const f = await fixture({ legacy }); const before = await f.snapshot(); await expect(f.run()).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); expect(await f.absent(path.join(f.state, "tcb-v3-activation.json"))).toBe(true); }, fixtureTimeout);
  it.each(["mode", "owner"] as const)("rejects legacy %s before mutation", async kind => { const f = await fixture({ legacyMode: kind === "mode" && !isWindows ? 0o644 : 0o440, legacyOwner: kind === "owner" && !isWindows ? "nobody" : "root" }); const before = await f.snapshot(); const target = f.metadataTarget(f.destinations[legacyName]); await expect(f.run(kind === "mode" && isWindows ? { PEILV_TEST_BAD_MODE: target } : kind === "owner" && isWindows ? { PEILV_TEST_BAD_OWNER: target } : {})).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }, fixtureTimeout);
  it("rejects an extra legacy target", async () => { const f = await fixture({ extraLegacy: true }); const before = await f.snapshot(); await expect(f.run()).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }, fixtureTimeout);
  it.each(["unknown", "extra"] as const)("rejects legacy v2 manifest %s with zero mutation", async kind => { const f = await fixture(kind === "unknown" ? { legacyV2: "unknown" } : { extraV2: true }); const before = await f.snapshot(); await expect(f.run()).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }, fixtureTimeout);
  it.each([...runtimeNames, "peilv-sudoers", manifestName])("rejects unknown existing TCB hash for %s", async name => { const f = await fixture({ unknownExisting: name }); const before = await f.snapshot(); await expect(f.run()).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }, fixtureTimeout);
  it.each(["Cmnd_Alias PEILV=/usr/local/sbin/peilv-control\n", "peilv-deploy ALL=(root) NOPASSWD: PEILV\n"])("rejects sudoers include or alias conflict", async conflict => { const f = await fixture({ conflict }); const before = await f.snapshot(); await expect(f.run()).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }, fixtureTimeout);
  it("restores legacy old when killed after retirement", async () => { const f = await fixture(); const before = await f.snapshot(); await expect(f.run({ PEILV_TCB_FAIL_AFTER: legacyName })).rejects.toBeDefined(); await expect(f.run({}, true)).resolves.toMatchObject({ stdout: expect.stringContaining("old generation retained") }); expect(await f.snapshot()).toEqual(before); }, fixtureTimeout);
  it("retains legacy absent and all-new after manifest commit", async () => { const f = await fixture(); await expect(f.run({ PEILV_TCB_FAIL_AFTER: manifestName })).rejects.toBeDefined(); await expect(f.run({}, true)).resolves.toMatchObject({ stdout: expect.stringContaining("new generation retained") }); expect(await f.absent(f.destinations[legacyName])).toBe(true); }, fixtureTimeout);
  it("recovery is reentrant after a second interruption", async () => { const f = await fixture(); const before = await f.snapshot(); await expect(f.run({ PEILV_TCB_FAIL_AFTER: legacyName })).rejects.toBeDefined(); await expect(f.run({ PEILV_TCB_RECOVERY_FAIL_AFTER: "migration-contract.mjs" }, true)).rejects.toBeDefined(); await expect(f.run({}, true)).resolves.toMatchObject({ stdout: expect.stringContaining("old generation retained") }); expect(await f.snapshot()).toEqual(before); }, 90_000);
  it("fails closed on committed mixed runtime/legacy state", async () => { const f = await fixture(); await expect(f.run({ PEILV_TCB_FAIL_AFTER: manifestName })).rejects.toBeDefined(); await writeFile(f.destinations[legacyName], approvedLegacy); await expect(f.run({}, true)).rejects.toMatchObject({ stderr: expect.stringContaining("mixed") }); }, fixtureTimeout);
  it.each(["new", "old"] as const)("seals durable root-only forensic evidence for %s outcome", async finalState => { const f = await fixture(); if (finalState === "new") await f.run(); else { await expect(f.run({ PEILV_TCB_FAIL_AFTER: legacyName })).rejects.toBeDefined(); await f.run({}, true); } const entries = await exec("bash", ["-c", "ls -1 \"$1\"", "bash", f.evidenceRoot]); const evidence = path.join(f.evidenceRoot, entries.stdout.trim().split(/\r?\n/)[0]); const bundle = JSON.parse(await f.readTrusted(path.join(evidence, "bundle.json"))); expect(bundle).toMatchObject({ schemaVersion: 1, finalState, transactionId: expect.any(String), digest: expect.stringMatching(/^[0-9a-f]{64}$/) }); expect(bundle.records.find((r: { name: string }) => r.name === legacyName).oldHash).toBe("e7e825d0c9a81c9514eb42aef12a56ad8c41729cfc9aa6f9fbaf345e9488b35a"); expect(await f.absent(path.join(evidence, `${legacyName}.old`))).toBe(false); }, fixtureTimeout);
  it.each(installNames.flatMap(name => name === manifestName ? [`${name}:backup`] : [`${name}:backup`, name]))("recovers all-old from install fault point %s", async point => { const f = await fixture(); const before = await f.snapshot(); await expect(f.run({ PEILV_TCB_FAIL_AFTER: point })).rejects.toBeDefined(); await expect(f.run({}, true)).resolves.toBeDefined(); expect(await f.snapshot()).toEqual(before); }, 90_000);
  it.each(["peilv-control", "peilv-sudoers", policyName, manifestName])("rejects CRLF in staged %s before mutation", async name => { const f = await fixture(); const before = await f.snapshot(); const target=path.join(f.stage,name); await chmod(target,0o600); await writeFile(target, `${await f.readTrusted(target)}\r\n`); await chmod(target,modes[name]); await expect(f.run()).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }, fixtureTimeout);
});
