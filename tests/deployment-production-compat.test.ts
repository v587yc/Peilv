import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const tmpRoot = path.join(root, ".test-tmp");
const deployPath = path.join(root, "scripts", "deploy-production.sh");
const lifecyclePath = path.join(root, "scripts", "lib", "candidate-lifecycle.sh");
const releaseId = "r20260716000001-a1-0123456789ab";
const requestId = "12345678-1234-4234-8234-123456789abc";

async function shellPath(value: string): Promise<string> {
  if (process.platform !== "win32") return value;
  try {
    return (await exec("cygpath", ["-u", value])).stdout.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return value.replaceAll("\\", "/");
    throw error;
  }
}

function functionBlock(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf(`${nextName}() {`, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end).trim();
}

describe("production compatibility probes", () => {
  beforeAll(async () => { await mkdir(tmpRoot, { recursive: true }); });

  it.each([
    ["legacy 401", "401", { configured: true, authenticated: false, actorType: null }, true],
    ["malicious 401 extra field", "401", { configured: true, authenticated: false, actorType: null, token: "must-not-leak" }, false],
    ["new 200", "200", { configured: true, initialized: true, authenticated: false, actorType: null, user: null }, true],
  ])("validates %s without printing the body", async (_name, status, body, accepted) => {
    const sandbox = await mkdtemp(path.join(tmpRoot, "session-probe-"));
    try {
      const deploy = await readFile(deployPath, "utf8");
      const validator = functionBlock(deploy, "validate_unauthenticated_session_response", "check_preupgrade_https_edge").replace("/usr/bin/node", "node");
      await writeFile(path.join(sandbox, "headers"), "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: private, no-store\r\n\r\n");
      await writeFile(path.join(sandbox, "body"), JSON.stringify(body));
      const harness = `#!/usr/bin/env bash\nset -Eeuo pipefail\n${validator}\nvalidate_unauthenticated_session_response ${status} "$1/headers" "$1/body"\n`;
      await writeFile(path.join(sandbox, "run.sh"), harness, { mode: 0o700 });
      let result: { stdout: string; stderr: string } | undefined;
      let failure: unknown;
      try { result = await exec("bash", [path.join(sandbox, "run.sh"), sandbox]); } catch (error) { failure = error; }
      expect(!failure).toBe(accepted);
      const output = result ? `${result.stdout}${result.stderr}` : `${(failure as { stdout?: string; stderr?: string })?.stdout || ""}${(failure as { stdout?: string; stderr?: string })?.stderr || ""}`;
      expect(output).not.toContain("must-not-leak");
      expect(output).not.toContain(JSON.stringify(body));
    } finally { await rm(sandbox, { recursive: true, force: true }); }
  }, 30_000);

  it("uses a unique root-private runtime and always removes it", async () => {
    const deploy = await readFile(deployPath, "utf8");
    const create = functionBlock(deploy, "create_probe_runtime", "cleanup_probe_runtime");
    const cleanup = functionBlock(deploy, "cleanup_probe_runtime", "write_transaction_state");
    expect(create).toContain('/run/peilv-deploy-${request_id}-XXXXXXXX');
    expect(create).toContain("root:root:700");
    expect(deploy).toContain('RUNTIME_DIRECTORY="$runtime" "$curl_secret_helper"');
    expect(deploy).not.toContain("TMPDIR=");
    expect(cleanup).toContain('rmdir -- "$runtime"');
  });

  it("dynamically creates mode 0700 runtime files and precisely cleans them", async () => {
    const sandbox = await mkdtemp(path.join(tmpRoot, "probe-runtime-"));
    try {
      const deploy = await readFile(deployPath, "utf8");
      const shellSandbox = sandbox.replaceAll("\\", "/");
      await exec("bash", ["-lc", `chmod 0700 ${JSON.stringify(shellSandbox)} && stat -c '%a' ${JSON.stringify(shellSandbox)}`]);
      const actualDirectoryMode = (await exec("bash", ["-lc", `stat -c '%a' ${JSON.stringify(shellSandbox)}`])).stdout.trim();
      const create = functionBlock(deploy, "create_probe_runtime", "cleanup_probe_runtime")
        .replace('/run/peilv-deploy-${request_id}-XXXXXXXX', `${shellSandbox}/peilv-deploy-\${request_id}-XXXXXXXX`)
        .replace(`$(stat -c '%U:%G:%a' -- "$runtime")`, `root:root:$(stat -c '%a' -- "$runtime")`)
        .replace("root:root:700", `root:root:${actualDirectoryMode}`);
      const cleanup = functionBlock(deploy, "cleanup_probe_runtime", "write_transaction_state")
        .replace('/run/peilv-deploy-${request_id}-', `${shellSandbox}/peilv-deploy-\${request_id}-`);
      const harness = `#!/usr/bin/env bash\nset -Eeuo pipefail\nrequest_id=${requestId}\n${create}\n${cleanup}\nruntime="$(create_probe_runtime)"\n[[ "$(stat -c '%a' "$runtime")" == ${actualDirectoryMode} ]]\nprintf private >"$runtime/headers"\nchmod 0600 "$runtime/headers"\ncleanup_probe_runtime "$runtime"\n[[ ! -e "$runtime" ]]\n`;
      await writeFile(path.join(sandbox, "run.sh"), harness, { mode: 0o700 });
      await exec("bash", [path.join(sandbox, "run.sh")]);
    } finally { await rm(sandbox, { recursive: true, force: true }); }
  }, 60_000);

  it("rejects a session probe that unexpectedly emits a cookie", async () => {
    const sandbox = await mkdtemp(path.join(tmpRoot, "session-cookie-leak-"));
    try {
      const deploy = await readFile(deployPath, "utf8");
      const validator = functionBlock(deploy, "validate_unauthenticated_session_response", "check_preupgrade_https_edge").replace("/usr/bin/node", "node");
      await writeFile(path.join(sandbox, "headers"), "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nSet-Cookie: admin_session=secret; Secure; HttpOnly\r\n\r\n");
      await writeFile(path.join(sandbox, "body"), JSON.stringify({ configured: true, authenticated: false, actorType: null }));
      await writeFile(path.join(sandbox, "run.sh"), `#!/usr/bin/env bash\nset -Eeuo pipefail\n${validator}\nvalidate_unauthenticated_session_response 401 "$1/headers" "$1/body"\n`, { mode: 0o700 });
      await expect(exec("bash", [path.join(sandbox, "run.sh"), sandbox])).rejects.toBeTruthy();
    } finally { await rm(sandbox, { recursive: true, force: true }); }
  });

  it("checks secure cookies only after proxy reload and formal application start", async () => {
    const deploy = await readFile(deployPath, "utf8");
    const preflightCall = deploy.lastIndexOf("check_preupgrade_https_edge", deploy.indexOf("write_transaction_state maintenance_entering"));
    const reload = deploy.indexOf('"$openresty_control" reload', deploy.indexOf("proxy_replacing"));
    const formal = deploy.indexOf("check_formal_application 5000", reload);
    const secure = deploy.indexOf("check_secure_cookie_probe", formal);
    expect(preflightCall).toBeGreaterThan(-1);
    expect(preflightCall).toBeLessThan(reload);
    expect(reload).toBeLessThan(formal);
    expect(formal).toBeLessThan(secure);
    const preupgrade = functionBlock(deploy, "check_preupgrade_https_edge", "check_secure_cookie_probe");
    expect(preupgrade).not.toContain("secure-cookie-probe");
    const probe = functionBlock(deploy, "check_secure_cookie_probe", "quarantine_created_release");
    for (const token of ["Secure", "HttpOnly", "SameSite=", "no-store"]) expect(probe).toContain(token);
    expect(probe).toContain('"$code" == 200 || "$code" == 204');
    expect(probe).not.toContain('"$code" == 201');
  });
});

describe("candidate auto-collect lifecycle", () => {
  it.each([
    ["not-found with zero residue", "0", "0"],
    ["not-found with PID residue", "99", "1"],
  ])("handles %s", async (_name, mainPid, expectedStatus) => {
    const sandbox = await mkdtemp(path.join(tmpRoot, "candidate-collect-"));
    try {
      const bin = path.join(sandbox, "bin");
      await mkdir(bin);
      const mocks: Record<string, string> = {
        systemctl: `#!/usr/bin/env bash\ncase "$*" in *LoadState*) printf 'not-found\\n'; exit 4;; *MainPID*) printf '${mainPid}\\n';; *ControlGroup*) printf '\\n';; *) exit 90;; esac\n`,
        mountpoint: "#!/usr/bin/env bash\nexit 1\n",
        findmnt: "#!/usr/bin/env bash\nexit 0\n",
        ps: "#!/usr/bin/env bash\nexit 0\n",
      };
      for (const [name, content] of Object.entries(mocks)) await writeFile(path.join(bin, name), content, { mode: 0o700 });
      const shellLifecycle = lifecyclePath.replaceAll("\\", "/");
      const shellSandbox = sandbox.replaceAll("\\", "/");
      const harness = `#!/usr/bin/env bash\nset -Eeuo pipefail\nexport PATH="$1/bin:$PATH"\nsource ${JSON.stringify(shellLifecycle)}\ncandidate_stop_and_release peilv-candidate-${releaseId}.service ${releaseId} /srv/peilv-candidate\n`;
      await writeFile(path.join(sandbox, "run.sh"), harness, { mode: 0o700 });
      let status = "0";
      try { await exec("bash", [path.join(sandbox, "run.sh"), shellSandbox]); } catch (error) {
        status = "1";
        if (expectedStatus === "0") throw error;
      }
      expect(status).toBe(expectedStatus);
    } finally { await rm(sandbox, { recursive: true, force: true }); }
  }, 60_000);

  it("uses strict LoadState guards and never stops an absent unit", async () => {
    const lifecycle = await readFile(lifecyclePath, "utf8");
    const stop = lifecycle.slice(lifecycle.indexOf("candidate_stop_and_release()"));
    expect(stop).toContain('[[ "$load_state" == loaded || "$load_state" == not-found ]]');
    expect(lifecycle).toContain("loaded:0|not-found:0|not-found:4");
    expect(stop.indexOf('if [[ "$load_state" == loaded ]]')).toBeLessThan(stop.indexOf('systemctl stop "$unit"'));
    expect(stop).toContain("sport = :5001");
    expect(stop).toContain('mountpoint -q "$candidate_mount"');
    expect(stop).toContain('grep -F -- "$release_id"');
  });
});

describe("failed release quarantine isolation", () => {
  it("keeps an old same-request quarantine and allocates a new attempt name", async () => {
    const sandbox = await mkdtemp(path.join(tmpRoot, "quarantine-isolation-"));
    try {
      const deploy = await readFile(deployPath, "utf8");
      const fn = functionBlock(deploy, "quarantine_created_release", "restore_on_failure")
        .replace('install -d -o root -g root -m 0700 "$base/quarantine"', 'mkdir -p "$base/quarantine"');
      const shellPath = sandbox.replaceAll("\\", "/");
      const harness = `#!/usr/bin/env bash\nset -Eeuo pipefail\nbase=${JSON.stringify(`${shellPath}/opt/peilv`)}\nrelease_id=${releaseId}\nrequest_id=${requestId}\nrelease_dir="$base/releases/$release_id"\nrelease_created=1\nrelease_activated=0\n${fn}\nmkdir -p "$release_dir" "$base/quarantine/$release_id.failed-$request_id"\nprintf old >"$base/quarantine/$release_id.failed-$request_id/sentinel"\nprintf new >"$release_dir/payload"\nquarantine_created_release\n[[ "$(cat "$base/quarantine/$release_id.failed-$request_id/sentinel")" == old ]]\n[[ "$(cat "$base/quarantine/$release_id.failed-$request_id.attempt-1/payload")" == new ]]\n`;
      await writeFile(path.join(sandbox, "run.sh"), harness, { mode: 0o700 });
      await exec("bash", [path.join(sandbox, "run.sh")]);
      await expect(stat(path.join(sandbox, "opt", "peilv", "releases", releaseId))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(sandbox, { recursive: true, force: true }); }
  });
});
