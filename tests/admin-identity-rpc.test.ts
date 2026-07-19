import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const databases: PGlite[] = [];
async function database() {
  const db = new PGlite(); databases.push(db);
  await db.exec(`CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, description TEXT);`);
  await db.exec(await readFile(`${root}/migrations/0009_admin_identity.sql`, "utf8"));
  await db.exec(await readFile(`${root}/migrations/0010_admin_identity_guardrails.sql`, "utf8"));
  await db.exec(await readFile(`${root}/migrations/0011_admin_login_rate_limit.sql`, "utf8"));
  await db.exec(await readFile(`${root}/migrations/0012_admin_login_reservations.sql`, "utf8"));
  await db.exec(await readFile(`${root}/migrations/0013_admin_user_optimistic_concurrency.sql`, "utf8"));
  await db.exec(await readFile(`${root}/migrations/0014_admin_login_uniform_reservations.sql`, "utf8"));
  await db.exec(`CREATE TABLE audit_logs(id SERIAL PRIMARY KEY, actor_id TEXT, actor_type TEXT NOT NULL DEFAULT 'system', action TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT, request_id TEXT, idempotency_key TEXT, old_value JSONB, new_value JSONB, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await db.exec(await readFile(`${root}/migrations/0015_admin_lifecycle_strong_audit.sql`, "utf8"));
  await db.exec(await readFile(`${root}/migrations/0012_admin_login_reservations.sql`, "utf8"));
  await db.exec(await readFile(`${root}/migrations/0013_admin_user_optimistic_concurrency.sql`, "utf8"));
  return db;
}
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.close())); });

describe("administrator identity database guardrails", () => {
  it("atomically creates an administrator with requested and succeeded audit records", async () => {
    const db = await database();
    const id = "33333333-3333-4333-8333-333333333333";
    const result = await db.query<{ create_admin_user_audited: { ok: boolean } }>(`SELECT create_admin_user_audited($1,$2,$3,$4,$5,$6,$7)`, [id, "audited.admin", "Audited", "hash", "operator", "actor", "request"]);
    expect(result.rows[0].create_admin_user_audited.ok).toBe(true);
    const actions = await db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE object_id=$1 ORDER BY id`, [id]);
    expect(actions.rows.map(row => row.action)).toEqual(["admin.user_create.requested", "admin.user_create.succeeded"]);
  }, 15_000);

  it("rolls back administrator creation when audit persistence fails", async () => {
    const db = await database();
    const id = "44444444-4444-4444-8444-444444444444";
    await db.exec(`ALTER TABLE audit_logs ADD CONSTRAINT reject_admin_audit CHECK (action NOT LIKE 'admin.user_create.%');`);
    await expect(db.query(`SELECT create_admin_user_audited($1,$2,$3,$4,$5,$6,$7)`, [id, "blocked.admin", "Blocked", "hash", "operator", "actor", "request"])).rejects.toThrow();
    const users = await db.query<{ count: number }>(`SELECT COUNT(*)::int count FROM admin_users WHERE id=$1`, [id]);
    expect(users.rows[0].count).toBe(0);
  }, 15_000);

  it("allows only one first administrator", async () => {
    const db = await database();
    await db.query(`SELECT * FROM bootstrap_first_admin($1,$2,$3,$4)`, ["11111111-1111-4111-8111-111111111111", "first.admin", "First", "hash-1"]);
    await expect(db.query(`SELECT * FROM bootstrap_first_admin($1,$2,$3,$4)`, ["22222222-2222-4222-8222-222222222222", "second.admin", "Second", "hash-2"])).rejects.toThrow("ADMIN_ALREADY_INITIALIZED");
    const result = await db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM admin_users`);
    expect(result.rows[0].count).toBe(1);
  }, 15_000);

  it("protects the last active super administrator inside the update transaction", async () => {
    const db = await database();
    const id = "11111111-1111-4111-8111-111111111111";
    await db.query(`SELECT * FROM bootstrap_first_admin($1,$2,$3,$4)`, [id, "first.admin", "First", "hash-1"]);
    const version = (await db.query<{ updated_at: string }>(`SELECT updated_at FROM admin_users WHERE id=$1`, [id])).rows[0].updated_at;
    await expect(db.query(`SELECT * FROM update_admin_user_guarded($1,$2,NULL,$3,NULL,NULL)`, [id, version, "operator"])).rejects.toThrow("LAST_ACTIVE_SUPER_ADMIN");
    await expect(db.query(`SELECT * FROM update_admin_user_guarded($1,$2,NULL,NULL,$3,NULL)`, [id, version, false])).rejects.toThrow("LAST_ACTIVE_SUPER_ADMIN");
  }, 15_000);

  it("revokes active sessions atomically when role changes", async () => {
    const db = await database();
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    await db.query(`SELECT * FROM bootstrap_first_admin($1,$2,$3,$4)`, [first, "first.admin", "First", "hash-1"]);
    await db.query(`INSERT INTO admin_users(id,username,display_name,password_hash,role,is_active) VALUES ($1,'second.admin','Second','hash-2','super_admin',TRUE)`, [second]);
    await db.query(`INSERT INTO admin_sessions(token_hash,admin_user_id,role,username,expires_at) VALUES ($1,$2,'super_admin','first.admin',NOW()+INTERVAL '1 day')`, ["a".repeat(64), first]);
    const version = (await db.query<{ updated_at: string }>(`SELECT updated_at FROM admin_users WHERE id=$1`, [first])).rows[0].updated_at;
    await db.query(`SELECT * FROM update_admin_user_guarded($1,$2,NULL,$3,NULL,NULL)`, [first, version, "auditor"]);
    const result = await db.query<{ role: string; revoked_at: string | null }>(`SELECT u.role,s.revoked_at FROM admin_users u JOIN admin_sessions s ON s.admin_user_id=u.id WHERE u.id=$1`, [first]);
    expect(result.rows[0].role).toBe("auditor");
    expect(result.rows[0].revoked_at).not.toBeNull();
  }, 15_000);

  it("rejects a stale administrator version and preserves the newer value", async () => {
    const db = await database();
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    await db.query(`SELECT * FROM bootstrap_first_admin($1,$2,$3,$4)`, [first, "first.admin", "First", "hash-1"]);
    await db.query(`INSERT INTO admin_users(id,username,display_name,password_hash,role,is_active) VALUES ($1,'second.admin','Second','hash-2','operator',TRUE)`, [second]);
    const original = (await db.query<{ updated_at: string }>(`SELECT updated_at FROM admin_users WHERE id=$1`, [second])).rows[0].updated_at;
    const updated = await db.query<{ updated_at: string }>(`SELECT updated_at FROM update_admin_user_guarded($1,$2,NULL,$3,NULL,NULL)`, [second, original, "auditor"]);
    expect(updated.rows[0].updated_at).not.toBe(original);
    await expect(db.query(`SELECT * FROM update_admin_user_guarded($1,$2,NULL,$3,NULL,NULL)`, [second, original, "super_admin"])).rejects.toThrow("ADMIN_UPDATE_CONFLICT");
    const current = await db.query<{ role: string }>(`SELECT role FROM admin_users WHERE id=$1`, [second]);
    expect(current.rows[0].role).toBe("auditor");
  }, 15_000);
});

describe("administrator login reservation RPCs", () => {
  const globalKey="1".repeat(64), unknownKey="2".repeat(64), accountKey="3".repeat(64);
  it("caps 50 concurrent reservations and keeps random usernames in one unknown bucket",async()=>{const db=await database();const results=await Promise.all(Array.from({length:50},(_,i)=>db.query<{allowed:boolean}>(`SELECT * FROM reserve_admin_login_attempt($1,$2,NULL,$3,NULL,FALSE)`,[i.toString(16).padStart(64,"0"),globalKey,unknownKey])));expect(results.filter(result=>result.rows[0].allowed)).toHaveLength(4);const rows=await db.query<{count:number}>(`SELECT COUNT(*)::int count FROM admin_login_attempt_buckets`);expect(rows.rows[0].count).toBe(2);const active=await db.query<{count:number}>(`SELECT COUNT(*)::int count FROM admin_login_attempt_reservations`);expect(active.rows[0].count).toBe(4)},20_000);
  it("allows a controlled correct-password probe after repeated known-account failures",async()=>{const db=await database();for(let i=0;i<20;i++){const token=(100+i).toString(16).padStart(64,"0");const reserved=await db.query<{allowed:boolean}>(`SELECT * FROM reserve_admin_login_attempt($1,$2,NULL,$3,NULL,TRUE)`,[token,globalKey,accountKey]);expect(reserved.rows[0].allowed).toBe(true);await db.query(`SELECT * FROM settle_admin_login_attempt($1,FALSE)`,[token]);}const successToken="f".repeat(64);const probe=await db.query<{allowed:boolean}>(`SELECT * FROM reserve_admin_login_attempt($1,$2,NULL,$3,NULL,TRUE)`,[successToken,globalKey,accountKey]);expect(probe.rows[0].allowed).toBe(true);await db.query(`SELECT * FROM settle_admin_login_attempt($1,TRUE)`,[successToken]);const account=await db.query<{failure_count:number}>(`SELECT failure_count FROM admin_login_attempt_buckets WHERE key_hash=$1`,[accountKey]);expect(account.rows[0].failure_count).toBe(0)},20_000);
  it("cleans expired reservations and is idempotent",async()=>{const db=await database();await db.query(`INSERT INTO admin_login_attempt_reservations(token_hash,global_key,subject_key,subject_known,expires_at) VALUES($1,$2,$3,FALSE,NOW()-INTERVAL '1 minute')`,["e".repeat(64),globalKey,unknownKey]);const cleaned=await db.query<{cleanup_admin_login_attempts:number}>(`SELECT cleanup_admin_login_attempts(100)`);expect(cleaned.rows[0].cleanup_admin_login_attempts).toBeGreaterThan(0);await db.exec(await readFile(`${root}/migrations/0012_admin_login_reservations.sql`,"utf8"))},20_000);
});

describe("uniform administrator login admission", () => {
  const globalKey="9".repeat(64);
  async function reserveMany(db:PGlite,count:number,prefix:number){return Promise.all(Array.from({length:count},(_,index)=>db.query<{allowed:boolean;retry_after_seconds:number}>(`SELECT * FROM reserve_admin_login_attempt_v2($1,$2,NULL)`,[(prefix+index).toString(16).padStart(64,"0"),globalKey])))}
  it.each([4,5,10,12])("known and unknown labels have identical %i-request admission",async count=>{const knownDb=await database();const unknownDb=await database();const known=await reserveMany(knownDb,count,1000);const unknown=await reserveMany(unknownDb,count,2000);expect(known.map(result=>({allowed:result.rows[0].allowed,retry:result.rows[0].retry_after_seconds}))).toEqual(unknown.map(result=>({allowed:result.rows[0].allowed,retry:result.rows[0].retry_after_seconds})));expect(known.filter(result=>result.rows[0].allowed)).toHaveLength(count)},30_000);
  it("caps 50 concurrent requests at the same global scrypt capacity without subject rows",async()=>{const db=await database();const results=await reserveMany(db,50,3000);expect(results.filter(result=>result.rows[0].allowed)).toHaveLength(12);const reservations=await db.query<{count:number}>(`SELECT COUNT(*)::int count FROM admin_login_attempt_reservations`);expect(reservations.rows[0].count).toBe(12);const subjectBuckets=await db.query<{count:number}>(`SELECT COUNT(*)::int count FROM admin_login_attempt_buckets WHERE key_kind IN ('unknown','account','source_subject')`);expect(subjectBuckets.rows[0].count).toBe(0)},30_000);
  it("does not turn rejected global requests into a minute-long global lock",async()=>{const db=await database();const first=await reserveMany(db,13,4000);expect(first.filter(result=>result.rows[0].allowed)).toHaveLength(12);await db.query(`DELETE FROM admin_login_attempt_reservations`);const next=await reserveMany(db,1,5000);expect(next[0].rows[0].allowed).toBe(true)},30_000);
});

describe("administrator login rate-limit database RPCs", () => {
  it("atomically locks after the fifth username failure and clears on success", async () => {
    const db = await database();
    const usernameKey = "a".repeat(64);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const result = await db.query<{ allowed: boolean; retry_after_seconds: number }>(`SELECT * FROM record_admin_login_failure($1,NULL)`, [usernameKey]);
      expect(result.rows[0].allowed).toBe(true);
    }
    const fifth = await db.query<{ allowed: boolean; retry_after_seconds: number }>(`SELECT * FROM record_admin_login_failure($1,NULL)`, [usernameKey]);
    expect(fifth.rows[0].allowed).toBe(false);
    expect(fifth.rows[0].retry_after_seconds).toBe(5);
    const blocked = await db.query<{ allowed: boolean; retry_after_seconds: number }>(`SELECT * FROM check_admin_login_rate_limit($1,NULL)`, [usernameKey]);
    expect(blocked.rows[0].allowed).toBe(false);
    await db.query(`SELECT clear_admin_login_failures($1,NULL)`, [usernameKey]);
    const cleared = await db.query<{ allowed: boolean }>(`SELECT * FROM check_admin_login_rate_limit($1,NULL)`, [usernameKey]);
    expect(cleared.rows[0].allowed).toBe(true);
  }, 15_000);

  it("tracks IP independently and migration remains idempotent", async () => {
    const db = await database();
    const ipKey = "c".repeat(64);
    for (let attempt = 0; attempt < 20; attempt++) await db.query(`SELECT * FROM record_admin_login_failure($1,$2)`, [attempt.toString(16).padStart(64, "0"), ipKey]);
    const blocked = await db.query<{ allowed: boolean }>(`SELECT * FROM check_admin_login_rate_limit($1,$2)`, ["d".repeat(64), ipKey]);
    expect(blocked.rows[0].allowed).toBe(false);
    await db.exec(await readFile(`${root}/migrations/0011_admin_login_rate_limit.sql`, "utf8"));
  }, 15_000);
});
