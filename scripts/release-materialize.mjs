#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [sourceArg, stageArg, workspaceArg] = process.argv.slice(2);
if (!sourceArg || !stageArg || !workspaceArg) throw new Error("Usage: release-materialize.mjs <standalone> <stage> <workspace>");
const source = path.resolve(sourceArg), stage = path.resolve(stageArg), workspace = path.resolve(workspaceArg);
const limits = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "release-limits.json"), "utf8"));
const workspaceReal = fs.realpathSync(workspace);
const sourceReal = fs.realpathSync(source);
if (!(sourceReal === workspaceReal || sourceReal.startsWith(`${workspaceReal}${path.sep}`))) throw new Error("Standalone source must be inside the workspace");
const allowedRoots = [sourceReal, path.join(workspaceReal, "node_modules")].map(value => fs.realpathSync(value));
const inside = (value, root) => value === root || value.startsWith(`${root}${path.sep}`);
const allowed = value => allowedRoots.some(root => inside(value, root));
function resolveSymlinkTarget(start) {
  let current = path.resolve(start);
  const seen = new Set();
  while (true) {
    const identity = path.normalize(current);
    if (seen.has(identity)) throw new Error(`Cyclic symlink rejected: ${start}`);
    seen.add(identity);
    let info;
    try { info = fs.lstatSync(current); }
    catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") throw new Error(`Dangling symlink rejected: ${start}`);
      throw error;
    }
    if (!info.isSymbolicLink()) {
      const real = fs.realpathSync(current);
      if (!allowed(real)) throw new Error(`Symlink target escapes allowed dependency roots: ${start}`);
      return real;
    }
    const link = fs.readlinkSync(current);
    if (path.isAbsolute(link)) current = path.resolve(link);
    else current = path.resolve(path.dirname(current), link);
  }
}
const stableFields = ["dev", "ino", "size", "ctimeMs", "mtimeMs", "mode", "nlink"];
const active = new Set();
let members = 0, total = 0;

function validateName(relative) {
  const posix = relative.split(path.sep).join("/");
  if (!/^[\x21-\x7e]+$/.test(posix) || posix.includes("\\") || posix.split("/").some(x => !x || x === "." || x === "..")) throw new Error(`Unsupported release path: ${JSON.stringify(posix)}`);
  if (Buffer.byteLength(posix) > limits.maxPathBytes || posix.split("/").length > limits.maxPathDepth) throw new Error(`Release path limit exceeded: ${posix}`);
  const parts = posix.split("/");
  if (parts.some(x => limits.forbiddenSegments.includes(x))) throw new Error(`Forbidden release member: ${posix}`);
  if (limits.forbiddenBasenamePatterns.some(x => new RegExp(x, "i").test(parts.at(-1))) || limits.forbiddenPathPatterns.some(x => new RegExp(x, "i").test(posix))) throw new Error(`Forbidden release member: ${posix}`);
  return posix;
}

function copyFileStable(from, to, before) {
  if (!before.isFile() || before.nlink < 1) throw new Error(`Special file or invalid link count rejected: ${from}`);
  const real = fs.realpathSync(from);
  if (!allowed(real)) throw new Error(`File escapes allowed dependency roots: ${from}`);
  if (before.size > limits.maxFileBytes) throw new Error(`Release file too large: ${from}`);
  const input = fs.openSync(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let output;
  let complete = false;
  try {
    const opened = fs.fstatSync(input);
    if (!opened.isFile() || opened.nlink < 1) throw new Error(`Source is not a regular file: ${from}`);
    for (const key of stableFields) if (opened[key] !== before[key]) throw new Error(`Source changed before copy: ${from}`);
    output = fs.openSync(to, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, before.mode & 0o777);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const count = fs.readSync(input, buffer, 0, buffer.length, position);
      if (!count) break;
      let written = 0;
      while (written < count) written += fs.writeSync(output, buffer, written, count - written, null);
      position += count;
    }
    const after = fs.fstatSync(input);
    for (const key of stableFields) if (after[key] !== opened[key]) throw new Error(`Source changed during copy: ${from}`);
    const copied = fs.fstatSync(output);
    if (!copied.isFile() || copied.nlink !== 1 || copied.size !== opened.size) throw new Error(`Materialized target is not a complete single-link regular file: ${to}`);
    fs.fsyncSync(output);
    complete = true;
  } finally {
    fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
    if (!complete) {
      try { fs.unlinkSync(to); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }
  total += before.size; members++;
  if (total > limits.maxTotalBytes || members > limits.maxMembers) throw new Error("Release resource limit exceeded");
}

function materialize(from, to, relative) {
  if (/\.map$/i.test(path.basename(relative))) return;
  const initial = fs.lstatSync(from, { bigint: false });
  if (initial.isSymbolicLink()) {
    const real = resolveSymlinkTarget(from);
    return materialize(real, to, relative);
  }
  validateName(relative);
  if (initial.isDirectory()) {
    const real = fs.realpathSync(from);
    if (!allowed(real)) throw new Error(`Directory escapes allowed dependency roots: ${from}`);
    if (active.has(real)) throw new Error(`Directory symlink cycle rejected: ${from}`);
    if (initial.nlink < 1) throw new Error(`Invalid directory link count: ${from}`);
    active.add(real); fs.mkdirSync(to, { mode: initial.mode & 0o777 }); members++;
    if (members > limits.maxMembers) throw new Error("Release member limit exceeded");
    try { for (const name of fs.readdirSync(from).sort()) materialize(path.join(from, name), path.join(to, name), path.join(relative, name)); }
    finally { active.delete(real); }
    return;
  }
  copyFileStable(from, to, initial);
}

if (!fs.lstatSync(source).isDirectory() || fs.readdirSync(stage).length) throw new Error("Invalid materialization roots");
for (const name of fs.readdirSync(source).sort()) materialize(path.join(source, name), path.join(stage, name), name);
function verifyStage(directory) {
  for (const name of fs.readdirSync(directory)) {
    const target = path.join(directory, name);
    const info = fs.lstatSync(target);
    if (info.isDirectory()) verifyStage(target);
    else if (!info.isFile() || info.nlink !== 1) throw new Error(`Materialized stage contains a link, special file, or hard link: ${target}`);
  }
}
verifyStage(stage);
