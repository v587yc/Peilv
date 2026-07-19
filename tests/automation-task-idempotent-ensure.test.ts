import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../migrations/0024_automation_task_idempotent_ensure.sql", import.meta.url);

describe("automation task atomic ensure", () => {
  it("defines a canonical JSONB task contract with key-order-independent payloads", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source).toContain("jsonb_typeof(p_task) <> 'object'");
    expect(source).toContain("jsonb_typeof(p_task->'payload') <> 'object'");
    expect(source).toContain("IDEMPOTENCY_PAYLOAD_CONFLICT");
    expect(JSON.stringify({ a: 1, b: 2 })).not.toBe(JSON.stringify({ b: 2, a: 1 }));
  });

  it("keeps migration hash and rollback contract explicit", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(createHash("sha256").update(source).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
    expect(source).toContain("SECURITY DEFINER");
    expect(source).toContain("SET search_path = pg_catalog, public, pg_temp");
    expect(source).not.toContain("FOR SHARE");
    expect(source).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(source).toContain("REVOKE ALL ON FUNCTION public.ensure_automation_task(JSONB) FROM PUBLIC, anon, authenticated");
    expect(source).toContain("ON CONFLICT (version) DO NOTHING");
  });
});
