import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.AUTOMATION_TEST_DATABASE_URL;
const databaseAck = process.env.AUTOMATION_TEST_DATABASE_ACK;
if (process.env.CI && !databaseUrl) throw new Error("AUTOMATION_TEST_DATABASE_URL is required in CI");
if (databaseUrl && databaseAck !== "ephemeral") throw new Error("AUTOMATION_TEST_DATABASE_ACK=ephemeral is required for destructive ephemeral database tests");
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) || /production|peilv/i.test(parsed.pathname)) {
    throw new Error("Refusing to run automation concurrency tests against a production-looking database");
  }
}
const migrationUrl = new URL("../migrations/0024_automation_task_idempotent_ensure.sql", import.meta.url);
const testName = `automation_${process.pid}_${Date.now()}`;

function databaseConnection(base: string, database: string) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function closeEphemeralDatabase(pool: Pool, admin: Pool, dbName: string, unexpectedErrors: Error[]) {
  pool.on("error", (error: Error & { code?: string }) => {
    if (error.code !== "57P01") unexpectedErrors.push(error);
  });
  await pool.end();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
  await admin.end();
  expect(unexpectedErrors).toEqual([]);
}

function task(id: string, key: string, payload: Record<string, unknown>) {
  return {
    id,
    task_type: "analysis",
    date_key: "20260719",
    match_id: null,
    source: "production",
    idempotency_key: key,
    status: "pending",
    attempt_count: 0,
    max_attempts: 3,
    payload,
    scheduled_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
  };
}

async function prepare(pool: Pool) {
  await pool.query("CREATE ROLE service_role NOLOGIN BYPASSRLS").catch((error: { code?: string }) => { if (error.code !== "42710") throw error; });
  await pool.query("CREATE ROLE anon NOLOGIN").catch((error: { code?: string }) => { if (error.code !== "42710") throw error; });
  await pool.query("CREATE ROLE authenticated NOLOGIN").catch((error: { code?: string }) => { if (error.code !== "42710") throw error; });
  await pool.query("GRANT USAGE ON SCHEMA public TO service_role");
  await pool.query("CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, description TEXT NOT NULL)");
  await pool.query(`CREATE TABLE automation_tasks (
    id TEXT PRIMARY KEY,
    task_type TEXT NOT NULL,
    date_key VARCHAR(8) NOT NULL,
    match_id VARCHAR(20),
    source TEXT NOT NULL DEFAULT 'production',
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    current_step TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lock_owner TEXT,
    lock_expires_at TIMESTAMPTZ,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    result JSONB,
    last_error TEXT,
    scheduled_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE UNIQUE INDEX automation_tasks_idempotency_unique ON automation_tasks(idempotency_key)");
  await pool.query("GRANT SELECT, INSERT, UPDATE, DELETE ON automation_tasks TO service_role");
  await pool.query(await readFile(migrationUrl, "utf8"));
}

describe.skipIf(!databaseUrl)("automation task real PostgreSQL concurrency", () => {
  it("ensures one row and one id for 100 concurrent connections without 23505", async () => {
    const admin = new Pool({ connectionString: databaseUrl, max: 2 });
    const dbName = `${testName}_same`.replace(/[^a-z0-9_]/gi, "_");
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const pool = new Pool({ connectionString: databaseConnection(databaseUrl!, dbName), max: 100 });
    const unexpectedErrors: Error[] = [];
    pool.on("error", (error: Error & { code?: string }) => { if (error.code !== "57P01") unexpectedErrors.push(error); });
    try {
      await prepare(pool);
      const results = await Promise.all(Array.from({ length: 100 }, (_, index) => pool.query<{ id: string }>(
        "SELECT id FROM public.ensure_automation_task($1::jsonb)",
        [JSON.stringify(task(`task-${index}`, "same-key", { winner: 0 }))],
      )));
      const ids = results.flatMap((result) => result.rows.map((row) => row.id));
      expect(new Set(ids).size).toBe(1);
      expect((await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM automation_tasks")).rows[0].count).toBe("1");
      const stored = (await pool.query<{ payload: Record<string, unknown> }>("SELECT payload FROM automation_tasks WHERE id=$1", [ids[0]])).rows[0].payload;
      expect(stored).toEqual({ winner: 0 });
    } finally {
      await closeEphemeralDatabase(pool, admin, dbName, unexpectedErrors);
    }
  }, 30_000);

  it("does not swallow a different partial unique conflict", async () => {
    const admin = new Pool({ connectionString: databaseUrl, max: 2 });
    const dbName = `${testName}_unique`.replace(/[^a-z0-9_]/gi, "_");
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const pool = new Pool({ connectionString: databaseConnection(databaseUrl!, dbName), max: 4 });
    const unexpectedErrors: Error[] = [];
    try {
      await prepare(pool);
      await pool.query("CREATE UNIQUE INDEX automation_tasks_single_running_analysis ON automation_tasks ((1)) WHERE status='running' AND task_type IN ('analysis','match-t30-analysis')");
      await pool.query("SELECT id FROM public.ensure_automation_task($1::jsonb)", [JSON.stringify({ ...task("running-task", "running-key", {}), status: "running" })]);
      await expect(pool.query("SELECT id FROM public.ensure_automation_task($1::jsonb)", [JSON.stringify({ ...task("second-task", "different-key", {}), status: "running" })])).rejects.toMatchObject({ code: "23505" });
    } finally {
      await closeEphemeralDatabase(pool, admin, dbName, unexpectedErrors);
    }
  });

  it("returns existing task for mutable-state replay and rejects immutable conflicts", async () => {
    const admin = new Pool({ connectionString: databaseUrl!, max: 2 });
    const dbName = `${testName}_replay`.replace(/[^a-z0-9_]/gi, "_");
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const pool = new Pool({ connectionString: databaseConnection(databaseUrl!, dbName), max: 4 });
    const unexpectedErrors: Error[] = [];
    try {
      await prepare(pool);
      const first = task("replay-task", "replay-key", { a: 1, b: 2 });
      const created = await pool.query("SELECT * FROM public.ensure_automation_task($1::jsonb)", [JSON.stringify(first)]);
      for (const status of ["running", "completed", "failed"]) {
        const replay = await pool.query("SELECT * FROM public.ensure_automation_task($1::jsonb)", [JSON.stringify({ ...first, status, attempt_count: 7, max_attempts: 9, payload: { b: 2, a: 1 }, scheduled_at: "2026-07-20T00:00:00.000Z", updated_at: "2026-07-20T00:00:00.000Z" })]);
        expect(replay.rows[0].id).toBe(created.rows[0].id);
      }
      await expect(pool.query("SELECT * FROM public.ensure_automation_task($1::jsonb)", [JSON.stringify({ ...first, task_type: "odds-fetch" })])).rejects.toMatchObject({ code: "P0001", detail: "IDEMPOTENCY_PAYLOAD_CONFLICT" });
      await expect(pool.query("SELECT * FROM public.ensure_automation_task($1::jsonb)", [JSON.stringify({ ...first, match_id: "different" })])).rejects.toMatchObject({ code: "P0001", detail: "IDEMPOTENCY_PAYLOAD_CONFLICT" });
      await expect(pool.query("SELECT * FROM public.ensure_automation_task($1::jsonb)", [JSON.stringify({ ...first, id: "invalid-integer", idempotency_key: "invalid-integer", attempt_count: 999999999999999999999 })])).rejects.toMatchObject({ code: "22023" });
      await expect(pool.query("SELECT * FROM public.ensure_automation_task($1::jsonb)", [JSON.stringify({ ...first, id: "invalid-date", idempotency_key: "invalid-date", date_key: "20260230" })])).rejects.toMatchObject({ code: "22023" });
      await expect(pool.query("SELECT * FROM public.ensure_automation_task($1::jsonb)", [JSON.stringify({ ...first, id: "invalid-timestamp", idempotency_key: "invalid-timestamp", scheduled_at: "not-a-timestamp" })])).rejects.toMatchObject({ code: "22023" });
    } finally {
      await closeEphemeralDatabase(pool, admin, dbName, unexpectedErrors);
    }
  });

  it("enforces owner, security definer, search_path, ACL, service_role and RLS contract", async () => {
    const admin = new Pool({ connectionString: databaseUrl!, max: 2 });
    const dbName = `${testName}_acl`.replace(/[^a-z0-9_]/gi, "_");
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const pool = new Pool({ connectionString: databaseConnection(databaseUrl!, dbName), max: 4 });
    const unexpectedErrors: Error[] = [];
    try {
      await prepare(pool);
      const acl = await pool.query<{ prosecdef: boolean; owner: string; proconfig: string[] | null }>("SELECT p.prosecdef, r.rolname AS owner, p.proconfig FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.ensure_automation_task(jsonb)'::regprocedure");
      expect(acl.rows[0]).toMatchObject({ prosecdef: true, owner: "automation_task_owner", proconfig: ["search_path=pg_catalog, public, pg_temp"] });
      const grants = await pool.query<{ grantee: string; privilege_type: string }>("SELECT grantee, privilege_type FROM information_schema.routine_privileges WHERE routine_schema='public' AND routine_name='ensure_automation_task'");
      expect(grants.rows).toEqual(expect.arrayContaining([{ grantee: "service_role", privilege_type: "EXECUTE" }]));
      expect(grants.rows.some(row => ["PUBLIC", "anon", "authenticated"].includes(row.grantee))).toBe(false);
      const rls = await pool.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid='public.automation_tasks'::regclass");
      expect(rls.rows[0].relrowsecurity).toBe(false);
    } finally {
      await closeEphemeralDatabase(pool, admin, dbName, unexpectedErrors);
    }
  });
});
