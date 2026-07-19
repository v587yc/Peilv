import { createHash } from "node:crypto";

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
    return value;
  }
  if (["undefined", "bigint", "function", "symbol"].includes(typeof value)) throw new TypeError("Canonical JSON rejects unsupported values");
  if (typeof value !== "object") throw new TypeError("Canonical JSON rejects unsupported values");
  if (seen.has(value)) throw new TypeError("Canonical JSON rejects cyclic values");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => canonicalize(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Canonical JSON requires plain objects");
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    for (const key of keys) result[key] = canonicalize((value as Record<string, unknown>)[key], seen);
    return result;
  } finally { seen.delete(value); }
}

export function stableCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256").update(stableCanonicalJson(value), "utf8").digest("hex");
}
