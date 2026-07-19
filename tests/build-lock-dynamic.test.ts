import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const buildScript = path.resolve("scripts/build.sh").replaceAll("\\", "/");
const temporaryRoots: string[] = [];

async function workspace() {
  const root = await mkdtemp(path.join(path.dirname(process.cwd()), ".peilv-build-lock-test-"));
  temporaryRoots.push(root);
  const work = path.join(root, "workspace");
  await mkdir(work);
  return { root, work };
}

async function bash(script: string, work: string, extra: Record<string, string> = {}) {
  return exec("bash", ["-c", script], {
    cwd: work,
    env: { ...process.env, COZE_WORKSPACE_PATH: work.replaceAll("\\", "/"), BUILD_SCRIPT: buildScript, ...extra },
    timeout: 15_000,
  });
}

async function nativePath(value: string): Promise<string> {
  if (process.platform !== "win32") return value;
  try {
    return (await exec("cygpath", ["-w", value])).stdout.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return value;
    throw error;
  }
}

async function lockContext(work: string) {
  const { stdout } = await bash(`source "$BUILD_SCRIPT"; initialize_build_context; printf '%s\\n%s' "$build_lock" "$workspace_real"`, work);
  const [shellLock, canonicalWorkspace] = stdout.trim().split(/\r?\n/);
  const lock = await nativePath(shellLock);
  return { lock, canonicalWorkspace };
}

async function waitUntil(check: () => Promise<boolean> | boolean, description: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("workspace build lock dynamic security", () => {
  it("rejects a symlink lock without touching its external target", async () => {
    const { root, work } = await workspace();
    const external = path.join(root, "external");
    await mkdir(external);
    await writeFile(path.join(external, "sentinel"), "keep");
    const { lock } = await lockContext(work);
    await symlink(external, lock, "junction");
    await expect(bash(`source "$BUILD_SCRIPT"; initialize_build_context; PEILV_BUILD_LOCK_MAX_WAIT_SECONDS=1 acquire_build_lock`, work)).rejects.toMatchObject({ stderr: expect.stringContaining("Unsafe build lock node") });
    expect(await readFile(path.join(external, "sentinel"), "utf8")).toBe("keep");
  });

  it("rejects symlink PID metadata without deleting the linked target", async () => {
    const { root, work } = await workspace();
    const externalPid = path.join(root, "external-pid");
    await mkdir(externalPid);
    await writeFile(path.join(externalPid, "sentinel"), "keep");
    const { lock, canonicalWorkspace } = await lockContext(work);
    await mkdir(lock);
    await symlink(externalPid, path.join(lock, "pid"), "junction");
    await writeFile(path.join(lock, "workspace"), `${canonicalWorkspace}\n`);
    await writeFile(path.join(lock, "token"), `${"a".repeat(64)}\n`);
    await writeFile(path.join(lock, "heartbeat"), "0\n");
    await writeFile(path.join(lock, "ready"), "ready\n");
    await expect(bash(`source "$BUILD_SCRIPT"; initialize_build_context; PEILV_BUILD_LOCK_MAX_WAIT_SECONDS=1 acquire_build_lock`, work)).rejects.toMatchObject({ stderr: expect.stringMatching(/Unsafe (?:symlink|build lock metadata)/) });
    expect(await readFile(path.join(externalPid, "sentinel"), "utf8")).toBe("keep");
  });

  it("bounds waiting for an unrelated live PID and never removes the unverifiable lock", async () => {
    const { work } = await workspace();
    const { lock, canonicalWorkspace } = await lockContext(work);
    await mkdir(lock);
    await writeFile(path.join(lock, "pid"), `${process.pid}\n`);
    await writeFile(path.join(lock, "workspace"), `${canonicalWorkspace}\n`);
    await writeFile(path.join(lock, "token"), `${"b".repeat(64)}\n`);
    await writeFile(path.join(lock, "heartbeat"), "0\n");
    await writeFile(path.join(lock, "ready"), "ready\n");
    await expect(bash(`source "$BUILD_SCRIPT"; initialize_build_context; PEILV_BUILD_LOCK_MAX_WAIT_SECONDS=2 acquire_build_lock`, work)).rejects.toMatchObject({ stderr: expect.stringContaining("Timed out waiting for stale or unverifiable build lock") });
    expect(await readFile(path.join(lock, "token"), "utf8")).toBe(`${"b".repeat(64)}\n`);
  });

  it("allows only one concurrent owner into the protected section", async () => {
    const { root, work } = await workspace();
    const { lock } = await lockContext(work);
    const log = path.join(root, "entries.log").replaceAll("\\", "/");
    const firstReady = path.join(root, "first-ready").replaceAll("\\", "/");
    const releaseFirst = path.join(root, "release-first").replaceAll("\\", "/");
    const criticalGuard = path.join(root, "critical-owner").replaceAll("\\", "/");
    const first = spawn("bash", ["-c", `source "$BUILD_SCRIPT"; initialize_build_context; trap on_exit EXIT; acquire_build_lock; mkdir '${criticalGuard}' || exit 91; printf 'first-enter\\n' >> '${log}'; : > '${firstReady}'; while [[ ! -f '${releaseFirst}' ]]; do sleep 0.05; done; printf 'first-exit\\n' >> '${log}'; rmdir '${criticalGuard}'`], { cwd: work, env: { ...process.env, COZE_WORKSPACE_PATH: work.replaceAll("\\", "/"), BUILD_SCRIPT: buildScript, PEILV_BUILD_LOCK_MAX_WAIT_SECONDS: "10" } });
    let firstStderr = "";
    first.stderr.on("data", chunk => { firstStderr += String(chunk); });
    await waitUntil(async () => await exists(firstReady) && await exists(path.join(lock, "ready")), "first owner and published lock metadata");

    const second = spawn("bash", ["-c", `source "$BUILD_SCRIPT"; initialize_build_context; trap on_exit EXIT; acquire_build_lock; mkdir '${criticalGuard}' || exit 92; printf 'second-enter\\n' >> '${log}'; printf 'second-exit\\n' >> '${log}'; rmdir '${criticalGuard}'`], { cwd: work, env: { ...process.env, COZE_WORKSPACE_PATH: work.replaceAll("\\", "/"), BUILD_SCRIPT: buildScript, PEILV_BUILD_LOCK_MAX_WAIT_SECONDS: "10" } });
    let secondStderr = "";
    second.stderr.on("data", chunk => { secondStderr += String(chunk); });
    await waitUntil(() => secondStderr.includes("Waiting for another verified build in this workspace"), "second process to observe the active first owner");
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["first-enter"]);
    expect(await exists(criticalGuard)).toBe(true);

    await writeFile(releaseFirst, "release\n");
    const wait = (child: ReturnType<typeof spawn>, stderr: () => string) => new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve(code) : reject(new Error(`child exited ${code}: ${stderr()}`)));
    });
    await expect(Promise.all([wait(first, () => firstStderr), wait(second, () => secondStderr)])).resolves.toEqual([0, 0]);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["first-enter", "first-exit", "second-enter", "second-exit"]);
    expect(await exists(criticalGuard)).toBe(false);
    expect(await exists(lock)).toBe(false);
  }, 15_000);

  it("preserves the original failure code even when cleanup also fails", async () => {
    const { work } = await workspace();
    await expect(bash(`source "$BUILD_SCRIPT"; initialize_build_context; trap on_exit EXIT; acquire_build_lock; printf '%s\\n' '${"c".repeat(64)}' > "$build_lock/token"; exit 37`, work)).rejects.toMatchObject({ code: 37, stderr: expect.stringContaining("Build cleanup failed while releasing the workspace lock") });
  });

  it("releases the lock from EXIT trap after a normal owner failure", async () => {
    const { root, work } = await workspace();
    await expect(bash(`source "$BUILD_SCRIPT"; initialize_build_context; trap on_exit EXIT; acquire_build_lock; exit 37`, work)).rejects.toMatchObject({ code: 37 });
    const entries = await import("node:fs/promises").then(fs => fs.readdir(root));
    expect(entries.some(name => name.startsWith(".peilv-build-lock-"))).toBe(false);
  });
});
