#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

const strictUtcRfc3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

export function parseStrictUtcRfc3339(value) {
  const match = typeof value === "string" ? strictUtcRfc3339.exec(value) : null;
  if (!match) throw new Error("validUntil must be strict UTC RFC3339");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("validUntil is not a real UTC instant");
  const canonicalSeconds = new Date(milliseconds).toISOString().slice(0, 19);
  if (canonicalSeconds !== `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`) {
    throw new Error("validUntil is not a real UTC instant");
  }
  return milliseconds;
}

export function assertNotExpired(validUntil, now = Date.now()) {
  const expiry = parseStrictUtcRfc3339(validUntil);
  if (!Number.isFinite(now)) throw new Error("Current time is invalid");
  if (now >= expiry) throw new Error("Production preflight has expired");
  return validUntil;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { assertNotExpired(process.argv[2]); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
