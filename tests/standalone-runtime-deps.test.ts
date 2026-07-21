import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const roots: string[] = [];
const runner = path.resolve("scripts/standalone-runtime-deps.mjs");

async function fixture({ versions = ["7.7.3"], target = "../semver@7.7.3/node_modules/semver" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "peilv-runtime-deps-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const standalone = path.join(root, "standalone");
  await mkdir(path.join(workspace, "node_modules"), { recursive: true });
  await mkdir(path.join(standalone, "node_modules", ".pnpm", "node_modules"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), '{"name":"fixture"}\n');
  await writeFile(path.join(standalone, "server.js"), "module.exports = {};\n");
  for (const name of ["next", "styled-jsx", "react", "react-dom"]) {
    await mkdir(path.join(workspace, "node_modules", name), { recursive: true });
    await writeFile(path.join(workspace, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies: {} }));
    await mkdir(path.join(standalone, "node_modules", name), { recursive: true });
    await writeFile(path.join(standalone, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  }
  for (const version of versions) {
    const pkg = path.join(workspace, "node_modules", ".pnpm", `semver@${version}`, "node_modules", "semver");
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "semver", version }));
    await writeFile(path.join(pkg, "index.js"), `module.exports = ${JSON.stringify(version)};\n`);
  }
  try {
    await symlink(target, path.join(standalone, "node_modules", ".pnpm", "node_modules", "semver"));
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM") return null;
    throw error;
  }
  return { root, workspace, standalone };
}

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("standalone runtime dependency repair", () => {
  it("repairs the real pnpm semver missing-target link from one unique workspace package", async () => {
    const value = await fixture();
    if (!value) return;
    await exec(process.execPath, [runner, value.standalone, value.workspace]);
    expect(await readFile(path.join(value.standalone, "node_modules", ".pnpm", "node_modules", "semver", "index.js"), "utf8")).toContain("7.7.3");
  });

  it("rejects multiple workspace versions instead of guessing", async () => {
    const value = await fixture({ versions: ["6.3.1", "7.7.3"], target: "../semver-missing/node_modules/semver" });
    if (!value) return;
    await expect(exec(process.execPath, [runner, value.standalone, value.workspace])).rejects.toMatchObject({ stderr: expect.stringContaining("no unique workspace match") });
  });

  it("reports a missing pnpm package separately from an ambiguous package", async () => {
    const value = await fixture({ versions: [], target: "../semver-missing/node_modules/semver" });
    if (!value) return;
    await expect(exec(process.execPath, [runner, value.standalone, value.workspace])).rejects.toMatchObject({ stderr: expect.stringContaining("has no workspace match") });
  });

  it.each([
    ["external", "__EXTERNAL__"],
    ["dangling", "../../missing/node_modules/semver"],
    ["cycle", "cycle-b"],
  ])("rejects %s runtime links", async (kind, target) => {
    let externalRoot: string | null = null;
    if (kind === "external") {
      externalRoot = await mkdtemp(path.join(os.tmpdir(), "peilv-runtime-external-"));
      roots.push(externalRoot);
      await mkdir(path.join(externalRoot, "semver"), { recursive: true });
      await writeFile(path.join(externalRoot, "semver", "package.json"), JSON.stringify({ name: "semver", version: "7.7.3" }));
    }
    const value = await fixture({ target: externalRoot ? path.join(externalRoot, "semver") : target });
    if (!value) return;
    if (kind === "cycle") {
      const root = path.join(value.standalone, "node_modules", ".pnpm", "node_modules");
      await rm(path.join(root, "semver"));
      await symlink("cycle-b", path.join(root, "semver"));
      await symlink("semver", path.join(root, "cycle-b"));
    }
    const expected = kind === "cycle" ? /Cyclic/ : kind === "dangling" ? /Dangling/ : /escapes allowed/;
    await expect(exec(process.execPath, [runner, value.standalone, value.workspace])).rejects.toMatchObject({ stderr: expect.stringMatching(expected) });
  });



  it("materializes complete @swc/helpers for next constants require", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "peilv-runtime-swc-real-"));
    roots.push(root);
    const workspace = process.cwd();
    const standalone = path.join(root, "standalone");
    await mkdir(path.join(standalone, "node_modules", "next", "dist", "shared", "lib"), { recursive: true });
    await writeFile(path.join(standalone, "server.js"), "module.exports = {};\n");
    for (const name of ["next", "styled-jsx", "react", "react-dom", "client-only", "scheduler", "@next/env"]) {
      const srcPkg = path.join(workspace, "node_modules", ...name.split("/"), "package.json");
      try {
        const raw = await readFile(srcPkg, "utf8");
        const destDir = path.join(standalone, "node_modules", ...name.split("/"));
        await mkdir(destDir, { recursive: true });
        await writeFile(path.join(destDir, "package.json"), raw);
        await writeFile(path.join(destDir, "index.js"), "module.exports = {};\n");
      } catch {
        // optional
      }
    }
    const incomplete = path.join(standalone, "node_modules", "@swc", "helpers");
    await mkdir(path.join(incomplete, "cjs"), { recursive: true });
    await writeFile(
      path.join(incomplete, "package.json"),
      JSON.stringify({ name: "@swc/helpers", version: "0.5.15", exports: { "./package.json": "./package.json" } }),
    );
    await writeFile(path.join(incomplete, "cjs", "_interop_require_default.cjs"), "module.exports={_:x=>x};\n");
    await writeFile(
      path.join(standalone, "node_modules", "next", "dist", "shared", "lib", "constants.js"),
      'const h = require("@swc/helpers/_/_interop_require_default"); module.exports = { ok: !!h };\n',
    );
    await exec(process.execPath, [runner, standalone, workspace]);
    const { createRequire } = await import("node:module");
    const req = createRequire(path.join(standalone, "server.js"));
    expect(() => req("@swc/helpers/_/_interop_require_default")).not.toThrow();
    expect(() => req("next/dist/shared/lib/constants.js")).not.toThrow();
  });

});
