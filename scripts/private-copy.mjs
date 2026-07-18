#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [source, target] = process.argv.slice(2);
if (!source || !target) throw new Error("Usage: private-copy.mjs <source> <target>");
const fields = ["dev", "ino", "size", "ctimeMs", "mtimeMs", "mode", "nlink"];
const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
let output;
try {
  const before = fs.fstatSync(input);
  if (!before.isFile() || before.nlink !== 1) throw new Error("Source must be a single-link regular file");
  output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (true) {
    const count = fs.readSync(input, buffer, 0, buffer.length, offset); if (!count) break;
    hash.update(buffer.subarray(0, count));
    let written = 0; while (written < count) written += fs.writeSync(output, buffer, written, count - written, null);
    offset += count;
  }
  const after = fs.fstatSync(input);
  for (const key of fields) if (after[key] !== before[key]) throw new Error(`Source changed during private copy (${key})`);
  fs.fsyncSync(output);
  process.stdout.write(`${hash.digest("hex")}\n`);
} catch (error) { try { fs.unlinkSync(target); } catch {} throw error; }
finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
const directory = fs.openSync(path.dirname(target), "r"); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
