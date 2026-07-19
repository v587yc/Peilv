import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

async function dynamicTcb(change?: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "deploy-v2-tcb-"));
  const etc = path.join(root, "etc"), sbin = path.join(root, "sbin"), libexec = path.join(root, "libexec");
  await Promise.all([mkdir(etc), mkdir(sbin), mkdir(libexec)]);
  const files = { "peilv-control": path.join(sbin, "peilv-control"), "deploy-production.sh": path.join(libexec, "deploy-production.sh"), "migration-contract.mjs": path.join(libexec, "migration-contract.mjs"), "deploy-operation-ledger.mjs": path.join(libexec, "deploy-operation-ledger.mjs") };
  for (const [name, target] of Object.entries(files)) await writeFile(target, `${name}\n`, { mode: 0o755 });
  const hashes = await Promise.all(Object.entries(files).map(async ([name, target]) => `${(await exec("sha256sum", [target])).stdout.split(" ")[0].replace(/^\\/, "")} ${name}`));
  await writeFile(path.join(etc, "trusted-deploy-v2.sha256"), `${hashes.join("\n")}\n`, { mode: 0o644 });
  await change?.(root);
  const control = await readFile("infra/deploy/peilv-control", "utf8");
  const fn = control.slice(control.indexOf("verify_deploy_v3_tcb()"), control.indexOf('caller="'))
    .replace("/etc/peilv/trusted-deploy-v2.sha256", path.join(etc, "trusted-deploy-v2.sha256").replaceAll("\\", "/"))
    .replace("/usr/local/sbin/peilv-control", files["peilv-control"].replaceAll("\\", "/"))
    .replaceAll('/usr/local/libexec/peilv/', `${libexec.replaceAll("\\", "/")}/`)
    .replaceAll("root:root:", `${process.platform === "win32" ? "Administrator:UNKNOWN" : `${process.env.USER}:${process.env.USER}`} :`.replace(" :", ":"));
  const harness = path.join(root, "verify.sh");
  const statShim = process.platform === "win32" ? `stat(){ local target="\${@: -1}" links; links="$(/usr/bin/stat -c '%h' "$target")"; if [[ -f "${root.replaceAll("\\", "/")}/bad-mode" && "$target" == *deploy-production.sh ]]; then printf 'Administrator:UNKNOWN:600:%s\\n' "$links"; elif [[ "$target" == *trusted-deploy-v2.sha256 ]]; then printf 'Administrator:UNKNOWN:644:%s\\n' "$links"; else printf 'Administrator:UNKNOWN:755:%s\\n' "$links"; fi; }\n` : "";
  await writeFile(harness, `#!/usr/bin/env bash\nset -Eeuo pipefail\n${statShim}${fn}\nverify_deploy_v3_tcb\n`);
  return exec("bash", [harness]);
}

describe("deploy v3 host TCB exact-set contract", () => {
  it("requires the exact four root-owned single-link hashed files", async () => {
    const control = await readFile("infra/deploy/peilv-control", "utf8");
    expect(control).toContain("/etc/peilv/trusted-deploy-v2.sha256");
    for (const file of ["peilv-control", "deploy-production.sh", "migration-contract.mjs", "deploy-operation-ledger.mjs"]) expect(control).toContain(file);
    expect(control).toContain("root:root:644:1");
    expect(control).toContain('root:root:$mode:1');
    expect(control).toContain('! -L "$manifest"');
    expect(control).toContain('! -L "$target"');
    expect(control).toContain('sha256sum "$target"');
    expect(control).toContain('${#seen[@]} == 4');
  });

  it("validates TCB before both deploy shapes and status", async () => {
    const control = await readFile("infra/deploy/peilv-control", "utf8");
    for (const shape of ["peilv-deploy:deploy-v3:9)", "peilv-deploy:deploy-v3:10)", "peilv-deploy:deploy-status-v1:2)"]) {
      const start = control.indexOf(shape);
      const end = control.indexOf(";;", start);
      expect(control.slice(start, end)).toContain("verify_deploy_v3_tcb");
    }
  });

  it("keeps sudoers behind versioned control commands only", async () => {
    const sudoers = await readFile("infra/deploy/peilv-sudoers", "utf8");
    expect(sudoers).toContain("peilv-control deploy-v3 *");
    expect(sudoers).toContain("peilv-control deploy-status-v1 *");
    expect(sudoers).not.toMatch(/peilv-control deploy \*/);
    expect(sudoers).not.toMatch(/peilv-control deploy-status \*/);
  });

  it("ships a fixed bootstrap manifest matching the exact repository files", async () => {
    const manifest = (await readFile("infra/deploy/trusted-deploy-v2.sha256", "utf8")).trim().split("\n");
    const paths: Record<string, string> = { "peilv-control": "infra/deploy/peilv-control", "deploy-production.sh": "scripts/deploy-production.sh", "migration-contract.mjs": "scripts/migration-contract.mjs", "deploy-operation-ledger.mjs": "scripts/deploy-operation-ledger.mjs" };
    expect(manifest.map(line => line.split(" ")[1])).toEqual(Object.keys(paths));
    for (const line of manifest) {
      const [expected, name] = line.split(" ");
      const actual = (await exec("sha256sum", [paths[name]])).stdout.split(" ")[0].replace(/^\\/, "");
      expect(actual).toBe(expected);
    }
  });

  it("accepts a canonical exact-set fixture", async () => { await expect(dynamicTcb()).resolves.toBeDefined(); });

  it.each(["missing", "duplicate", "extra", "basename-collision", "bad-hash", "bad-mode", "symlink", "nlink"])("dynamically rejects %s TCB", async kind => {
    await expect(dynamicTcb(async root => {
      const manifest = path.join(root, "etc", "trusted-deploy-v2.sha256");
      const lines = (await readFile(manifest, "utf8")).trim().split("\n");
      if (kind === "missing") lines.pop();
      if (kind === "duplicate") lines.push(lines[0]);
      if (kind === "extra") lines.push(`${"a".repeat(64)} unexpected`);
      if (kind === "basename-collision") lines.push(`${"a".repeat(64)} path/peilv-control`);
      if (kind === "bad-hash") lines[0] = `${"a".repeat(64)} peilv-control`;
      if (kind === "bad-mode") await writeFile(path.join(root, "bad-mode"), "1");
      if (["missing", "duplicate", "extra", "basename-collision", "bad-hash"].includes(kind)) await writeFile(manifest, `${lines.join("\n")}\n`);
      if (kind === "symlink") { const target=path.join(root,"libexec","migration-contract.mjs"), real=`${target}.real`; await writeFile(real,"migration-contract.mjs\n"); await import("node:fs/promises").then(fs=>fs.rm(target)); await symlink(real,target); }
      if (kind === "nlink") await link(path.join(root,"libexec","migration-contract.mjs"),path.join(root,"libexec","second-link"));
    })).rejects.toBeDefined();
  });
});
