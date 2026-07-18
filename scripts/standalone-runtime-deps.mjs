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

function symlinkPackageName(relative) {
  const parts = relative.split(path.sep);
  const virtualIndex = parts.lastIndexOf(".pnpm");
  if (virtualIndex < 0 || parts[virtualIndex + 1] !== "node_modules") return null;
  const first = parts[virtualIndex + 2];
  if (!first) return null;
  return first.startsWith("@") ? `${first}/${parts[virtualIndex + 3] ?? ""}` : first;
}

function resolveSymlinkTarget(start, allowedRoots) {
  let current = path.resolve(start);
  const seen = new Set();
  while (true) {
    const identity = path.normalize(current);
    if (seen.has(identity)) throw new Error(`Cyclic standalone dependency link: ${start}`);
    seen.add(identity);
    let info;
    try { info = fs.lstatSync(current); }
    catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { kind: "missing", path: current };
      throw error;
    }
    if (!info.isSymbolicLink()) {
      const real = fs.realpathSync(current);
      if (!allowedRoots.some(root => inside(real, root))) throw new Error(`Standalone dependency link escapes allowed roots: ${start}`);
      return { kind: "resolved", path: real };
    }
    const link = fs.readlinkSync(current);
    current = path.isAbsolute(link) ? path.resolve(link) : path.resolve(path.dirname(current), link);
  }
}

function candidatePackages(name, requestedStore) {
  const virtualRoot = path.join(dependencyRoot, ".pnpm");
  if (!name || !fs.existsSync(virtualRoot)) return [];
  const candidates = [];
  for (const store of fs.readdirSync(virtualRoot, { withFileTypes: true })) {
    if (!store.isDirectory()) continue;
    if (requestedStore && store.name !== requestedStore) continue;
    const candidate = path.join(virtualRoot, store.name, "node_modules", ...name.split("/"));
    if (!fs.existsSync(candidate)) continue;
    const metadata = path.join(candidate, "package.json");
    if (!fs.existsSync(metadata)) continue;
    const packageJson = JSON.parse(fs.readFileSync(metadata, "utf8"));
    if (packageJson.name !== name) continue;
    candidates.push({ path: fs.realpathSync(candidate), store: store.name, version: packageJson.version });
  }
  return [...new Map(candidates.map(item => [item.path, item])).values()];
}

function requestedStoreFromTarget(start, link) {
  const targetParts = (path.isAbsolute(link) ? path.normalize(link) : path.normalize(path.resolve(path.dirname(start), link))).split(path.sep);
  const name = symlinkPackageName(path.relative(standalone, start));
  if (!name) return null;
  const marker = targetParts.lastIndexOf("node_modules");
  const candidate = marker > 0 ? targetParts[marker - 1] : null;
  return candidate && candidate !== ".pnpm" ? candidate : null;
}

function copyResolvedPackage(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true, errorOnExist: true });
  const pending = [destination];
  while (pending.length) {
    const current = pending.pop();
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Materialized runtime dependency retained symlink: ${destination}`);
    if (!info.isDirectory()) continue;
    for (const child of fs.readdirSync(current)) pending.push(path.join(current, child));
  }
}

function repairMissingPnpmLink(linkPath) {
  const name = symlinkPackageName(path.relative(standalone, linkPath));
  if (!name) throw new Error(`Unresolvable missing standalone dependency link: ${linkPath}`);
  const link = fs.readlinkSync(linkPath);
  const requestedStore = requestedStoreFromTarget(linkPath, link);
  let candidates = candidatePackages(name, requestedStore);
  if (!requestedStore) candidates = candidatePackages(name, null);
  if (candidates.length !== 1) throw new Error(`Missing standalone dependency has no unique workspace match: ${linkPath} (${candidates.map(item => `${item.store}@${item.version}`).join(", ")})`);
  const candidate = candidates[0].path;
  if (!inside(candidate, dependencyRoot)) throw new Error(`Workspace dependency candidate escapes node_modules: ${candidate}`);
  copyResolvedPackage(candidate, linkPath);
}

function repairStandaloneLinks() {
  const allowedRoots = [fs.realpathSync(standalone), dependencyRoot];
  let changed = true;
  while (changed) {
    changed = false;
    const pending = [standalone];
    while (pending.length) {
      const current = pending.pop();
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink()) {
        const link = resolveSymlinkTarget(current, allowedRoots);
        if (link.kind === "missing") {
          if (!inside(link.path, allowedRoots[0]) && !inside(link.path, dependencyRoot)) {
            throw new Error(`Standalone dependency link escapes allowed roots: ${current}`);
          }
          repairMissingPnpmLink(current);
          changed = true;
        }
        continue;
      }
      if (!info.isDirectory()) continue;
      for (const child of fs.readdirSync(current)) pending.push(path.join(current, child));
    }
  }
}

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

repairStandaloneLinks();

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
