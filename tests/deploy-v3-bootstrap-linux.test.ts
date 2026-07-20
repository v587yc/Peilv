import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
if (process.platform !== "linux") throw new Error("Linux-only Host TCB suite was collected outside Linux");
if (process.geteuid?.() !== 0) throw new Error("Linux-only Host TCB suite requires effective uid 0");
for (const command of ["sudo", "visudo", "flock", "stat", "sync"]) execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
const capabilityRoot = mkdtempSync(path.join(os.tmpdir(), "deploy-v3-capabilities-"));
try {
  const original = path.join(capabilityRoot, "fsync-source");
  const renamed = path.join(capabilityRoot, "fsync-renamed");
  writeFileSync(original, "capability\n");
  const fileDescriptor = openSync(original, "r");
  try { fsyncSync(fileDescriptor); } finally { closeSync(fileDescriptor); }
  renameSync(original, renamed);
  const directoryDescriptor = openSync(capabilityRoot, "r");
  try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
} finally {
  rmSync(capabilityRoot, { recursive: true, force: true });
}
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
const fixtureTimeout = 30_000;
const fixtureRoots = new Set<string>();
const lockHolderReadyTimeout = 2_000;
const lockHolderStopTimeout = 1_000;

function lockHolderArgs(lock: string) {
  return ["--no-fork", "-n", lock, "sleep", "30"] as const;
}

function requireSingleProcessLockHolder(args: readonly string[]) {
  if (args[0] !== "--no-fork") throw new Error("Lock holder contract requires flock --no-fork so the spawned PID is the only lock owner");
}

function isProcessAlive(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForLockBusy(child: ChildProcess, lock: string) {
  const deadline = Date.now() + lockHolderReadyTimeout;
  while (Date.now() < deadline) {
    if (!isProcessAlive(child)) throw new Error("Lock holder exited before acquiring the lock");
    try {
      await exec("flock", ["-n", lock, "true"]);
    } catch (error) {
      if ((error as { code?: number }).code === 1 && isProcessAlive(child)) return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Lock holder did not make ${lock} busy within ${lockHolderReadyTimeout}ms`);
}

function pidIsGone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitForChildExitAndPidGone(child: ChildProcess, pid: number, timeout: number) {
  const closed = child.exitCode !== null || child.signalCode !== null || await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => { child.off("close", onClose); resolve(false); }, timeout);
    const onClose = () => { clearTimeout(timer); resolve(true); };
    child.once("close", onClose);
  });
  return closed && pidIsGone(pid);
}

type LockHolderStopOperations = {
  sendTerm: () => void;
  waitAfterTerm: () => Promise<boolean>;
  sendKill: () => void;
  waitAfterKill: () => Promise<boolean>;
};

async function enforceLockHolderStop(pid: number, operations: LockHolderStopOperations) {
  operations.sendTerm();
  if (await operations.waitAfterTerm()) return;
  const terminationError = new Error(`Lock holder PID ${pid} did not close and disappear within ${lockHolderStopTimeout}ms after SIGTERM`);
  try {
    operations.sendKill();
    if (!await operations.waitAfterKill()) terminationError.message += "; SIGKILL cleanup also failed";
  } catch (cleanupError) {
    terminationError.message += `; SIGKILL cleanup threw: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
  }
  throw terminationError;
}

async function stopLockHolder(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) throw new Error("Lock holder has no PID");
  await enforceLockHolderStop(pid, {
    sendTerm: () => { child.kill("SIGTERM"); },
    waitAfterTerm: () => waitForChildExitAndPidGone(child, pid, lockHolderStopTimeout),
    sendKill: () => { child.kill("SIGKILL"); },
    waitAfterKill: () => waitForChildExitAndPidGone(child, pid, lockHolderStopTimeout),
  });
}

function checkedFixturePath(root: string, target: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Fixture path escaped its temporary root");
  return resolvedTarget;
}

function sudoWithInput(args: readonly string[], input: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("sudo", [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(`sudo ${args[0]} exited ${code}: ${stderr}`), { code, stdout, stderr })));
    child.stdin.end(input);
  });
}

async function privilegedMetadata(root: string, target: string) {
  const checked = checkedFixturePath(root, target);
  const { stdout } = await exec("sudo", ["stat", "-c", "%U\t%G\t%a\t%h", "--", checked]);
  const [user, group, mode, nlink] = stdout.trim().split("\t");
  return { owner: `${user}:${group}`, mode, nlink: Number(nlink) };
}

async function privilegedExists(root: string, target: string) {
  const checked = checkedFixturePath(root, target);
  return exec("sudo", ["test", "-e", checked]).then(() => true, () => false);
}

async function privilegedWrite(root: string, target: string, content: string, mode: number) {
  const checked = checkedFixturePath(root, target);
  await sudoWithInput(["tee", "--", checked], content);
  await exec("sudo", ["chown", "root:root", "--", checked]);
  await exec("sudo", ["chmod", mode.toString(8), "--", checked]);
}

async function createPrivilegedDanglingSymlink(root: string, target: string) {
  const checked = checkedFixturePath(root, target);
  const referent = checkedFixturePath(root, path.join(root, `missing-${path.basename(target)}`));
  await exec("sudo", ["rm", "-f", "--", checked]);
  await exec("sudo", ["ln", "-s", "--", referent, checked]);
  const { stdout } = await exec("sudo", ["stat", "-c", "%i", "--", checked]);
  return { referent, inode: stdout.trim() };
}

async function expectPrivilegedDanglingSymlinkPreserved(root: string, target: string, expected: { referent: string; inode: string }) {
  const checked = checkedFixturePath(root, target);
  expect((await exec("sudo", ["readlink", "--", checked])).stdout.trim()).toBe(expected.referent);
  expect((await exec("sudo", ["stat", "-c", "%i", "--", checked])).stdout.trim()).toBe(expected.inode);
  await expect(exec("sudo", ["test", "-e", expected.referent])).rejects.toBeDefined();
}

async function privilegedTreeSnapshot(root: string, target: string) {
  const checked = checkedFixturePath(root, target);
  return (await exec("sudo", ["find", checked, "-mindepth", "1", "-printf", "%P|%y|%i|%l|%s\n"])).stdout.split(/\r?\n/).filter(Boolean).sort();
}

async function transactionArtifactSnapshot(root: string) {
  const entries = await privilegedTreeSnapshot(root, root);
  return entries.filter(entry => entry.includes(".tcb-v3-old-") || entry.includes(".next-v3-") || entry.includes("tcb-v3-activation.json") || entry.includes("tcb-forensics/"));
}

async function prepareFixtureLocks(root: string, locks: readonly string[]) {
  for (const lock of locks) {
    const checked = checkedFixturePath(root, lock);
    await exec("sudo", ["install", "-o", "root", "-g", "root", "-m", "0600", "/dev/null", checked]);
  }
}

async function fixtureLockSnapshot(root: string, locks: readonly string[]) {
  return Promise.all(locks.map(async lock => {
    const checked = checkedFixturePath(root, lock);
    const { stdout: metadata } = await exec("sudo", ["stat", "-c", "%U:%G:%a:%h:%i:%s", "--", checked]);
    const { stdout: digest } = await exec("sudo", ["sha256sum", "--", checked]);
    return `${path.basename(checked)}|${metadata.trim()}|${digest.trim().split(/\s+/)[0]}`;
  }));
}

async function expectFixtureLocksReleased(root: string, locks: readonly string[]) {
  await expect(Promise.all(locks.map(lock => {
    const checked = checkedFixturePath(root, lock);
    return exec("sudo", ["flock", "-n", checked, "true"]);
  }))).resolves.toHaveLength(locks.length);
}

async function withPrivilegedFixtureMutation<T>(root: string, target: string, content: string, mode: number, action: () => Promise<T>) {
  const checked = checkedFixturePath(root, target);
  const existed = await exec("sudo", ["test", "-e", checked]).then(() => true, () => false);
  const originalContent = existed ? (await exec("sudo", ["cat", "--", checked])).stdout : null;
  const originalMode = existed ? Number.parseInt((await privilegedMetadata(root, checked)).mode, 8) : null;
  await privilegedWrite(root, checked, content, mode);
  try {
    return await action();
  } finally {
    if (originalContent !== null && originalMode !== null) await privilegedWrite(root, checked, originalContent, originalMode);
    else await exec("sudo", ["rm", "-f", "--", checked]);
  }
}

async function expectUnprivilegedDenied(target: string, directory = false) {
  const sudoUid = process.env.SUDO_UID;
  if (!sudoUid?.match(/^[1-9][0-9]*$/)) throw new Error("Root fixture test requires a non-root SUDO_UID for access denial assertions");
  await expect(exec("sudo", ["-u", `#${sudoUid}`, "--", directory ? "ls" : "cat", "--", target])).rejects.toMatchObject({ code: expect.any(Number) });
}

async function expectUnprivilegedMutationDenied(target: string) {
  const sudoUid = process.env.SUDO_UID;
  if (!sudoUid?.match(/^[1-9][0-9]*$/)) throw new Error("Root fixture test requires a non-root SUDO_UID for mutation denial assertions");
  await expect(sudoWithInput(["-u", `#${sudoUid}`, "tee", "-a", "--", target], "UNPRIVILEGED MUTATION\n")).rejects.toMatchObject({ code: expect.any(Number) });
}

afterEach(async () => {
  for (const root of fixtureRoots) {
    checkedFixturePath(root, root);
    if (!/^deploy-v3-(?:bootstrap|lock-holder)-/.test(path.basename(root))) throw new Error("Refusing to clean an unexpected fixture root");
    await exec("sudo", ["rm", "-rf", "--", root]);
    fixtureRoots.delete(root);
  }
});

type FixtureOptions = { legacy?: "approved" | "absent" | "unknown" | "symlink" | "hardlink"; legacyMode?: number; legacyOwner?: "root" | "nobody"; legacyV2?: "approved" | "absent" | "unknown"; conflict?: string; extraLegacy?: boolean; extraV2?: boolean; unknownExisting?: string };
async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "deploy-v3-bootstrap-"));
  fixtureRoots.add(root);
  const stage = path.join(root, "stage"), sbin = path.join(root, "sbin"), libexec = path.join(root, "libexec"), etc = path.join(root, "etc"), sudoers = path.join(root, "sudoers.d"), state = path.join(root, "state"), sudoersMain = path.join(root, "sudoers-main");
  await Promise.all([stage, sbin, libexec, etc, sudoers, state].map(dir => mkdir(dir)));
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
  if (legacy === "symlink") await symlink(destinations["peilv-sudoers"], destinations[legacyName]);
  if (legacy === "hardlink") await link(destinations[legacyName], path.join(root, "legacy-hardlink"));
  if (options.extraLegacy) { await writeFile(path.join(sudoers, "peilv-deploy-extra"), approvedLegacy); await chmod(path.join(sudoers, "peilv-deploy-extra"), 0o440); }
  const legacyV2 = options.legacyV2 ?? "approved";
  if (legacyV2 !== "absent") { await writeFile(destinations[legacyV2Name], legacyV2 === "approved" ? approvedV2Manifest : "UNKNOWN V2\n"); await chmod(destinations[legacyV2Name], 0o644); }
  if (options.extraV2) { await writeFile(path.join(etc, "trusted-deploy-v2.sha256.extra"), approvedV2Manifest); await chmod(path.join(etc, "trusted-deploy-v2.sha256.extra"), 0o644); }
  if (options.unknownExisting) { await chmod(destinations[options.unknownExisting], 0o600); await writeFile(destinations[options.unknownExisting], "UNAPPROVED EXISTING\n"); await chmod(destinations[options.unknownExisting], modes[options.unknownExisting]); }
  if (options.conflict) { await writeFile(path.join(sudoers, "other"), options.conflict); await chmod(path.join(sudoers, "other"), 0o440); }

  const productionScript = await readFile("infra/deploy/bootstrap-deploy-v3.sh", "utf8");
  const harness = path.join(root, "bootstrap.sh"); await writeFile(harness, productionScript); await chmod(harness, 0o700);
  const shellPath = (value: string) => value;
  await exec("sudo", ["chown", "-R", "root:root", root]); for (const name of installNames) { await exec("sudo", ["chmod", modes[name].toString(8), path.join(stage, name)]); if (await lstat(destinations[name]).then(() => true, () => false)) await exec("sudo", ["chmod", modes[name].toString(8), destinations[name]]); } await exec("sudo", ["chmod", "0440", sudoersMain]); for (const dir of [stage, sbin, libexec, etc, sudoers]) await exec("sudo", ["chmod", "0755", dir]); await exec("sudo", ["chmod", "0700", state]); if (options.legacyOwner === "nobody") await exec("sudo", ["chown", "nobody:nogroup", destinations[legacyName]]);
  const locks = [path.join(root, "global.lock"), path.join(root, "tcb.lock")] as const;
  const baseEnv = { ...process.env, PEILV_GLOBAL_LOCK: shellPath(locks[0]), PEILV_TCB_LOCK: shellPath(locks[1]), PEILV_TCB_SBIN: shellPath(sbin), PEILV_TCB_LIBEXEC: shellPath(libexec), PEILV_TCB_ETC: shellPath(etc), PEILV_TCB_SUDOERS: shellPath(sudoers), PEILV_TCB_SUDOERS_MAIN: shellPath(sudoersMain), PEILV_TCB_STATE_ROOT: shellPath(state) };
  const run = (extraEnv: Record<string, string | undefined> = {}, recover = false) => { const args = [shellPath(harness), ...(recover ? ["recover-tcb-v3"] : []), shellPath(stage)]; const environment = Object.entries({ ...baseEnv, ...extraEnv }).filter((x): x is [string, string] => typeof x[1] === "string").map(([k, v]) => `${k}=${v}`); return exec("sudo", ["env", ...environment, "bash", ...args]); };
  const readTrusted = async (target: string) => (await exec("sudo", ["cat", target])).stdout;
  const absent = async (target: string) => exec("bash", ["-c", "[[ ! -e \"$1\" && ! -L \"$1\" ]]", "bash", target]).then(() => true, () => false);
  const snapshot = async () => Object.fromEntries(await Promise.all(transactionNames.map(async name => [name, await absent(destinations[name]) ? null : await readTrusted(destinations[name])])));
  const snapshotExcept = async (excluded: string) => Object.fromEntries(await Promise.all(transactionNames.filter(name => destinations[name] !== excluded).map(async name => [name, await absent(destinations[name]) ? null : await readTrusted(destinations[name])])));
  return { root, stage, state, evidenceRoot: path.join(state, "tcb-forensics"), locks, destinations, run, snapshot, snapshotExcept, readTrusted, absent, metadataTarget: (target: string) => shellPath(target) };
}

describe("deploy v3 legacy sudoers retirement transaction", () => {
  it.each(Object.values(approvedFixtures))("pins approved old-byte fixture $path to exact LF-only bytes", async approved => {
    const bytes = await readFile(approved.path);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(approved.sha256);
    expect(bytes.includes(0x0d)).toBe(false);
    expect(bytes.at(-1)).toBe(0x0a);
  });
  it("uses one dangling-symlink-aware entry classifier", async () => {
    const source = await readFile("infra/deploy/bootstrap-deploy-v3.sh", "utf8");
    expect(source).toContain('path_entry_exists(){ [[ -e "$1" || -L "$1" ]]; }');
    expect(source).toContain('classify_entry(){');
    expect(source).toContain('require_absent(){');
  });
  it("creates state and nested transaction directories progressively", async () => {
    const f = await fixture();
    await exec("sudo", ["rmdir", "--", f.state]);
    await expect(f.run()).resolves.toBeDefined();
    for (const [target, mode] of [[f.state, "700"], [path.join(f.state, "deploy-operations"), "700"], [path.join(f.state, "deploy-results"), "700"], [f.evidenceRoot, "700"]] as const) {
      expect(await privilegedMetadata(f.root, target)).toMatchObject({ owner: "root:root", mode });
    }
  }, fixtureTimeout);
  it.each(["state", "intermediate"] as const)("rejects dangling %s directory with zero mutation", async kind => {
    const f = await fixture();
    const target = kind === "state" ? f.state : path.join(f.state, "deploy-operations");
    if (kind === "state") await exec("sudo", ["rmdir", "--", f.state]);
    const link = await createPrivilegedDanglingSymlink(f.root, target);
    await prepareFixtureLocks(f.root, f.locks);
    const locksBefore = await fixtureLockSnapshot(f.root, f.locks);
    const before = await privilegedTreeSnapshot(f.root, f.root);
    await expect(f.run()).rejects.toMatchObject({ code: 78 });
    await expectPrivilegedDanglingSymlinkPreserved(f.root, target, link);
    expect(await privilegedTreeSnapshot(f.root, f.root)).toEqual(before);
    expect(await fixtureLockSnapshot(f.root, f.locks)).toEqual(locksBefore);
    await expectFixtureLocksReleased(f.root, f.locks);
  }, fixtureTimeout);
  it("accepts an existing trusted state parent", async () => {
    const f = await fixture();
    await expect(f.run()).resolves.toBeDefined();
    expect(await privilegedMetadata(f.root, f.state)).toMatchObject({ owner: "root:root", mode: "700" });
  }, fixtureTimeout);
  it.each(["mode", "owner"] as const)("rejects state directory with unsafe %s and zero mutation", async kind => {
    const f = await fixture();
    if (kind === "mode") await exec("sudo", ["chmod", "0777", "--", f.state]);
    else await exec("sudo", ["chown", "nobody:nogroup", "--", f.state]);
    await prepareFixtureLocks(f.root, f.locks);
    const locksBefore = await fixtureLockSnapshot(f.root, f.locks);
    const before = await privilegedTreeSnapshot(f.root, f.root);
    await expect(f.run()).rejects.toMatchObject({ code: 78 });
    expect(await privilegedTreeSnapshot(f.root, f.root)).toEqual(before);
    expect(await fixtureLockSnapshot(f.root, f.locks)).toEqual(locksBefore);
    await expectFixtureLocksReleased(f.root, f.locks);
  }, fixtureTimeout);
  it("enforces the real global flock protocol before any target mutation", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    const holderArguments = lockHolderArgs(f.locks[0]);
    requireSingleProcessLockHolder(holderArguments);
    const holder = spawn("flock", [...holderArguments], { stdio: "ignore" });
    const spawnError = new Promise<never>((_, reject) => holder.once("error", reject));
    try {
      await Promise.race([waitForLockBusy(holder, f.locks[0]), spawnError]);
      expect(isProcessAlive(holder)).toBe(true);
      await expect(f.run()).rejects.toMatchObject({ code: 75, stderr: expect.stringContaining("Global deployment lock is busy") });
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await stopLockHolder(holder);
    }
    await expectFixtureLocksReleased(f.root, f.locks);
  }, fixtureTimeout);
  it("fails a timed-out TERM despite forced cleanup, and releases a normal --no-fork holder lock", async () => {
    const cleanupCalls: string[] = [];
    await expect(enforceLockHolderStop(4242, {
      sendTerm: () => { cleanupCalls.push("TERM"); },
      waitAfterTerm: async () => false,
      sendKill: () => { cleanupCalls.push("KILL"); },
      waitAfterKill: async () => true,
    })).rejects.toThrow("did not close and disappear");
    expect(cleanupCalls).toEqual(["TERM", "KILL"]);

    const root = await mkdtemp(path.join(os.tmpdir(), "deploy-v3-lock-holder-"));
    fixtureRoots.add(root);
    const lock = path.join(root, "holder.lock");
    await writeFile(lock, "");
    const legacyForkingArgs = ["-n", lock, "sleep", "30"] as const;
    expect(() => requireSingleProcessLockHolder(legacyForkingArgs)).toThrow(/--no-fork/);
    const holderArguments = lockHolderArgs(lock);
    expect(() => requireSingleProcessLockHolder(holderArguments)).not.toThrow();
    const holder = spawn("flock", [...holderArguments], { stdio: "ignore" });
    const spawnError = new Promise<never>((_, reject) => holder.once("error", reject));
    try {
      await Promise.race([waitForLockBusy(holder, lock), spawnError]);
      expect(isProcessAlive(holder)).toBe(true);
    } finally {
      await stopLockHolder(holder);
    }
    await expect(exec("flock", ["-n", lock, "true"])).resolves.toBeDefined();
    await exec("sudo", ["rm", "-rf", "--", root]);
    fixtureRoots.delete(root);
  }, fixtureTimeout);
  it("detects any third fixture object in the zero-mutation structure snapshot", async () => {
    const f = await fixture();
    await prepareFixtureLocks(f.root, f.locks);
    const before = await privilegedTreeSnapshot(f.root, f.root);
    await privilegedWrite(f.root, path.join(f.root, "unexpected-third-object"), "unexpected\n", 0o600);
    expect(await privilegedTreeSnapshot(f.root, f.root)).not.toEqual(before);
  }, fixtureTimeout);
  it.each(["absent", "approved"] as const)("activates all-new with legacy %s", async legacy => { const f = await fixture({ legacy }); await expect(f.run()).resolves.toMatchObject({ stdout: expect.stringContaining("legacy sudoers retired") }); expect(await f.absent(f.destinations[legacyName])).toBe(true); expect(await f.absent(f.destinations[legacyV2Name])).toBe(true); for (const name of installNames) expect(await f.readTrusted(f.destinations[name])).toBe(await f.readTrusted(path.join(f.stage, name))); }, fixtureTimeout);
  it.each(["unknown", "symlink", "hardlink"] as const)("rejects unsafe legacy %s with zero mutation", async legacy => { const f = await fixture({ legacy }); const before = await f.snapshot(); await expect(f.run()).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); expect(await f.absent(path.join(f.state, "tcb-v3-activation.json"))).toBe(true); }, fixtureTimeout);
  it.each(["mode", "owner"] as const)("rejects legacy %s before mutation", async kind => { const f = await fixture({ legacyMode: kind === "mode" ? 0o644 : 0o440, legacyOwner: kind === "owner" ? "nobody" : "root" }); const before = await f.snapshot(); await expect(f.run()).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }, fixtureTimeout);
  it("rejects an extra legacy target", async () => { const f = await fixture({ extraLegacy: true }); const before = await f.snapshot(); await expect(f.run()).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }, fixtureTimeout);
  it.each(["unknown", "extra"] as const)("rejects legacy v2 manifest %s with zero mutation", async kind => { const f = await fixture(kind === "unknown" ? { legacyV2: "unknown" } : { extraV2: true }); const before = await f.snapshot(); await expect(f.run()).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }, fixtureTimeout);
  it.each([...runtimeNames, "peilv-sudoers", manifestName])("rejects unknown existing TCB hash for %s", async name => { const f = await fixture({ unknownExisting: name }); const before = await f.snapshot(); await expect(f.run()).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }, fixtureTimeout);
  it.each(["Cmnd_Alias PEILV=/usr/local/sbin/peilv-control\n", "peilv-deploy ALL=(root) NOPASSWD: PEILV\n"])("rejects sudoers include or alias conflict", async conflict => { const f = await fixture({ conflict }); const before = await f.snapshot(); await expect(f.run()).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }, fixtureTimeout);
  it("restores legacy old when killed after retirement", async () => { const f = await fixture(); const before = await f.snapshot(); await expect(f.run({ PEILV_TCB_FAIL_AFTER: legacyName })).rejects.toBeDefined(); await expect(f.run({}, true)).resolves.toMatchObject({ stdout: expect.stringContaining("old generation retained") }); expect(await f.snapshot()).toEqual(before); }, fixtureTimeout);
  it("retains legacy absent and all-new after manifest commit", async () => { const f = await fixture(); await expect(f.run({ PEILV_TCB_FAIL_AFTER: manifestName })).rejects.toBeDefined(); await expect(f.run({}, true)).resolves.toMatchObject({ stdout: expect.stringContaining("new generation retained") }); expect(await f.absent(f.destinations[legacyName])).toBe(true); }, fixtureTimeout);
  it("recovery is reentrant after a second interruption", async () => { const f = await fixture(); const before = await f.snapshot(); await expect(f.run({ PEILV_TCB_FAIL_AFTER: legacyName })).rejects.toBeDefined(); await expect(f.run({ PEILV_TCB_RECOVERY_FAIL_AFTER: "migration-contract.mjs" }, true)).rejects.toBeDefined(); await expect(f.run({}, true)).resolves.toMatchObject({ stdout: expect.stringContaining("old generation retained") }); expect(await f.snapshot()).toEqual(before); }, 90_000);
  it("fails closed on committed mixed runtime/legacy state", async () => { const f = await fixture(); await expect(f.run({ PEILV_TCB_FAIL_AFTER: manifestName })).rejects.toBeDefined(); await withPrivilegedFixtureMutation(f.root, f.destinations[legacyName], approvedLegacy, 0o440, async () => { expect(await privilegedMetadata(f.root, f.destinations[legacyName])).toEqual({ owner: "root:root", mode: "440", nlink: 1 }); await expectUnprivilegedDenied(f.destinations[legacyName]); await expect(f.run({}, true)).rejects.toMatchObject({ stderr: expect.stringContaining("mixed") }); }); }, fixtureTimeout);
  it.each(["new", "old"] as const)("seals durable root-only forensic evidence for %s outcome", async finalState => { const f = await fixture(); if (finalState === "new") await f.run(); else { await expect(f.run({ PEILV_TCB_FAIL_AFTER: legacyName })).rejects.toBeDefined(); await f.run({}, true); } await expectUnprivilegedDenied(f.evidenceRoot, true); const entries = await exec("sudo", ["find", f.evidenceRoot, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-printf", "%f\n"]); const entry = entries.stdout.trim().split(/\r?\n/)[0]; expect(entry).toMatch(/^[0-9A-Za-z._-]+$/); const evidence = checkedFixturePath(f.root, path.join(f.evidenceRoot, entry)); expect(await privilegedMetadata(f.root, f.evidenceRoot)).toMatchObject({ owner: "root:root", mode: "700" }); expect(await privilegedMetadata(f.root, evidence)).toMatchObject({ owner: "root:root", mode: "700" }); const bundlePath = checkedFixturePath(f.root, path.join(evidence, "bundle.json")); expect((await exec("sudo", ["sha256sum", "--", bundlePath])).stdout).toMatch(/^[0-9a-f]{64}\s/); await expectUnprivilegedDenied(bundlePath); const bundle = JSON.parse(await f.readTrusted(bundlePath)); expect(bundle).toMatchObject({ schemaVersion: 1, finalState, transactionId: expect.any(String), digest: expect.stringMatching(/^[0-9a-f]{64}$/) }); expect(bundle.records.find((r: { name: string }) => r.name === legacyName).oldHash).toBe("e7e825d0c9a81c9514eb42aef12a56ad8c41729cfc9aa6f9fbaf345e9488b35a"); expect(await privilegedExists(f.root, path.join(evidence, `${legacyName}.old`))).toBe(true); }, fixtureTimeout);
  it.each(installNames.flatMap(name => name === manifestName ? [`${name}:backup`] : [`${name}:backup`, name]))("recovers all-old from install fault point %s", async point => { const f = await fixture(); const before = await f.snapshot(); await expect(f.run({ PEILV_TCB_FAIL_AFTER: point })).rejects.toBeDefined(); await expect(f.run({}, true)).resolves.toBeDefined(); expect(await f.snapshot()).toEqual(before); }, 90_000);
  it.each(["peilv-control", "peilv-sudoers", policyName, manifestName])("rejects CRLF in staged %s before mutation", async name => { const f = await fixture(); const before = await f.snapshot(); const target = path.join(f.stage, name); await withPrivilegedFixtureMutation(f.root, target, `${await f.readTrusted(target)}\r\n`, modes[name], async () => { expect(await privilegedMetadata(f.root, target)).toEqual({ owner: "root:root", mode: modes[name].toString(8), nlink: 1 }); await expectUnprivilegedMutationDenied(target); await expect(f.run()).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }); }, fixtureTimeout);
  it.each(["install", "retire", "manifest", "journal", "backup", "forensic"] as const)("rejects dangling symlink at %s boundary with zero subsequent mutation", async boundary => {
    const f = await fixture();
    let target: string;
    let recover = false;
    if (boundary === "backup" || boundary === "forensic") {
      await expect(f.run({ PEILV_TCB_FAIL_AFTER: "peilv-control:backup" })).rejects.toBeDefined();
      const journal = JSON.parse(await f.readTrusted(path.join(f.state, "tcb-v3-activation.json")));
      if (boundary === "backup") target = journal.records.find((record: { name: string }) => record.name === "peilv-control").backup;
      else target = path.join(f.evidenceRoot, journal.transactionId);
      recover = true;
    } else if (boundary === "install") target = f.destinations["peilv-control"];
    else if (boundary === "retire") target = f.destinations[legacyName];
    else if (boundary === "manifest") target = f.destinations[manifestName];
    else target = path.join(f.state, "tcb-v3-activation.json");

    const link = await createPrivilegedDanglingSymlink(f.root, target);
    const otherTargetsBefore = await f.snapshotExcept(target);
    const stateBefore = await privilegedTreeSnapshot(f.root, f.state);
    const artifactsBefore = await transactionArtifactSnapshot(f.root);
    await expect(f.run({}, recover)).rejects.toMatchObject({ code: 78 });
    await expectPrivilegedDanglingSymlinkPreserved(f.root, target, link);
    expect(await f.snapshotExcept(target)).toEqual(otherTargetsBefore);
    expect(await privilegedTreeSnapshot(f.root, f.state)).toEqual(stateBefore);
    expect(await transactionArtifactSnapshot(f.root)).toEqual(artifactsBefore);
  }, 90_000);
});
