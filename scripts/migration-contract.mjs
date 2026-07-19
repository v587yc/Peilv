#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const FILE = /^[0-9]{4}_[a-z0-9_]+\.sql$/;
const VERSION = /^[0-9]{4}_[a-z0-9_]+$/;
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

export function canonicalMigrationContract(manifest, appliedInput) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.migrations) || manifest.migrations.length === 0) throw new Error("Invalid migration manifest");
  const appliedRaw = Array.isArray(appliedInput) ? appliedInput : [];
  const applied = new Set(appliedRaw.map(value => value === "0001_canonical_baseline" ? "0001_production_baseline" : value));
  if (applied.size !== appliedRaw.length) throw new Error("Duplicate or alias-colliding migration ledger");
  const files = new Set(), versions = new Set();
  const ordered = manifest.migrations.map(entry => {
    if (!entry || !FILE.test(entry.file) || !VERSION.test(entry.version) || !SHA256.test(entry.sha256) || typeof entry.codeRollbackSafe !== "boolean" || files.has(entry.file) || versions.has(entry.version)) throw new Error("Invalid migration metadata");
    files.add(entry.file); versions.add(entry.version);
    return { file: entry.file, version: entry.version, sha256: entry.sha256, codeRollbackSafe: entry.codeRollbackSafe };
  });
  const unknown = [...applied].filter(version => !versions.has(version));
  const appliedEntries = ordered.filter(entry => applied.has(entry.version));
  const pendingEntries = ordered.filter(entry => !applied.has(entry.version));
  const canonical = entries => ({ schemaVersion: 1, migrations: entries });
  return {
    applied: appliedEntries.map(entry => entry.version), pending: pendingEntries.map(entry => entry.file), unknown,
    migrationLedgerDigest: digest(canonical(appliedEntries)), pendingPlanDigest: digest(canonical(pendingEntries)),
    pendingAllCodeRollbackSafe: pendingEntries.every(entry => entry.codeRollbackSafe),
  };
}

function main() {
  const [manifestPath, ledgerPath] = process.argv.slice(2);
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
  const applied = fs.readFileSync(path.resolve(ledgerPath), "utf8").split(/\r?\n/).filter(Boolean);
  process.stdout.write(`${JSON.stringify(canonicalMigrationContract(manifest, applied))}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
