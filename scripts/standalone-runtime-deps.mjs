#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [standaloneArg, workspaceArg] = process.argv.slice(2);
if (!standaloneArg || !workspaceArg) throw new Error("Usage: standalone-runtime-deps.mjs <standalone> <workspace>");
const standalone = path.resolve(standaloneArg);
const workspace = path.resolve(workspaceArg);
const workspaceReal = fs.realpathSync(workspace);
const dependencyRoot = fs.realpathSync(path.join(workspaceReal, "node_modules"));
const materializer = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-materialize.mjs");
const runtimeRoots = ["next", "styled-jsx", "react", "react-dom"];
const runtimeAllowlist = new Set([...runtimeRoots, "client-only", "scheduler", "@next/env", "@swc/helpers"]);
const standaloneRequire = createRequire(path.join(standalone, "server.js"));
const workspaceRequire = createRequire(path.join(workspaceReal, "package.json"));
const nextRequire = createRequire(workspaceRequire.resolve("next/package.json"));
const inside = (value, root) => value === root || value.startsWith(`${root}${path.sep}`);

function packageJsonFrom(requireFrom, name) {
  let packageJson;
  try {
    packageJson = requireFrom.resolve(`${name}/package.json`);
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    let cursor = path.dirname(requireFrom.resolve(name));
    while (true) {
      const candidate = path.join(cursor, "package.json");
      if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, "utf8")).name === name) { packageJson = candidate; break; }
      const parent = path.dirname(cursor);
      if (parent === cursor || !inside(fs.realpathSync(cursor), dependencyRoot)) throw new Error(`Cannot locate package metadata for runtime dependency: ${name}`);
      cursor = parent;
    }
  }
  const real = fs.realpathSync(packageJson);
  if (!inside(real, dependencyRoot)) throw new Error(`Runtime dependency escapes workspace node_modules: ${name}`);
  return real;
}

function standaloneHas(name) {
  try {
    return inside(path.resolve(standaloneRequire.resolve(`${name}/package.json`)), standalone);
  } catch (error) {
    if (error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return false;
    throw error;
  }
}

function destinationFor(name) {
  return path.join(standalone, "node_modules", ...name.split("/"));
}

const queue = runtimeRoots.map(name => ({ name, requireFrom: name === "styled-jsx" ? nextRequire : workspaceRequire }));
const visited = new Set();
while (queue.length) {
  const { name, requireFrom } = queue.shift();
  const sourcePackageJson = packageJsonFrom(requireFrom, name);
  const sourcePackage = path.dirname(sourcePackageJson);
  const key = name;
  if (visited.has(key)) continue;
  visited.add(key);
  if (standaloneHas(name)) continue;
  const metadata = JSON.parse(fs.readFileSync(sourcePackageJson, "utf8"));
  const destination = destinationFor(name);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  execFileSync(process.execPath, [materializer, sourcePackage, destination, workspaceReal], { stdio: "inherit" });
  const childRequire = createRequire(sourcePackageJson);
  for (const dependency of Object.keys(metadata.dependencies ?? {}).filter(name => runtimeAllowlist.has(name)).sort()) {
    queue.push({ name: dependency, requireFrom: childRequire });
  }
}

const verification = execFileSync(process.execPath, ["-e", `
  const path = require("node:path");
  const runtimeRequire = require("node:module").createRequire(path.join(process.argv[1], "server.js"));
  for (const name of ${JSON.stringify(runtimeRoots)}) {
    let resolved;
    try { resolved = runtimeRequire.resolve(name + "/package.json"); }
    catch { resolved = runtimeRequire.resolve(name); }
    if (!(path.resolve(resolved) === path.resolve(process.argv[1]) || path.resolve(resolved).startsWith(path.resolve(process.argv[1]) + path.sep))) throw new Error(name + " escaped standalone: " + resolved);
    process.stdout.write(name + ": " + resolved + "\\n");
  }
`, standalone], { encoding: "utf8" });
process.stdout.write(verification);
