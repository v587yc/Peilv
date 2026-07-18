import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url);
const read = (name: string) => readFile(new URL(name, root), "utf8");

function plannerSource(script: string): string {
  const marker = 'RELEASE_MIGRATIONS="$release_dir/migrations" MIGRATION_PLAN="$migration_plan" node <<\'NODE\'\n';
  const start = script.indexOf(marker);
  const end = script.indexOf("\nNODE\n", start + marker.length);
  if (start < 0 || end < 0) throw new Error("migration planner heredoc missing");
  return script.slice(start + marker.length, end);
}

function functionSource(script: string, name: string, nextName: string): string {
  const start = script.indexOf(`${name}() {`);
  const end = script.indexOf(`${nextName}() {`, start + name.length);
  if (start < 0 || end < 0) throw new Error(`${name} function missing`);
  return script.slice(start, end);
}

async function runPlanner(entries: Array<{ file: string; version: string; sql: string; sha?: string }>) {
  const sandbox = await mkdtemp(join(tmpdir(), "peilv-migrations-"));
  const migrationRoot = join(sandbox, "migrations");
  await mkdir(migrationRoot);
  const migrations = [];
  for (const entry of entries) {
    await writeFile(join(migrationRoot, entry.file), entry.sql);
    migrations.push({ file: entry.file, version: entry.version, sha256: entry.sha ?? createHash("sha256").update(entry.sql).digest("hex"), codeRollbackSafe: true });
  }
  await writeFile(join(migrationRoot, "manifest.json"), JSON.stringify({ schemaVersion: 1, migrations }));
  const planner = join(sandbox, "planner.cjs");
  const plan = join(sandbox, "plan.tsv");
  await writeFile(planner, plannerSource(await read("scripts/deploy-production.sh")));
  return exec(process.execPath, [planner], { env: { ...process.env, RELEASE_MIGRATIONS: migrationRoot, MIGRATION_PLAN: plan } }).then(async result => ({ ...result, plan: await readFile(plan, "utf8") }));
}

describe("production migration manifest and state regressions", () => {
  it("accepts the real 0008-0014 manifest mappings and SQL layouts", async () => {
    const manifest = JSON.parse(await read("migrations/manifest.json"));
    const selected = manifest.migrations.filter((migration: { version: string }) => /^00(?:0[89]|1[0-4])_/.test(migration.version));
    const result = await runPlanner(await Promise.all(selected.map(async (migration: { file: string; version: string }) => ({ ...migration, sql: await read(`migrations/${migration.file}`) }))));
    expect(result.plan.trim().split("\n")).toHaveLength(7);
    expect(result.plan).toContain("0008_management_command_receipts.sql\t0008_management_command_receipts");
    expect(result.plan).toContain("0012_admin_login_reservations.sql\t0012_admin_login_reservations");
  });

  it("accepts different SQL formatting but rejects mismatch, duplicate, missing and bad SHA", async () => {
    await expect(runPlanner([{ file: "0099_layout.sql", version: "0099_layout", sql: `INSERT INTO public.schema_migrations ( description , version ) VALUES ( 'x' , '0099_layout' );\n` }])).resolves.toMatchObject({ plan: expect.stringContaining("\tself\n") });
    await expect(runPlanner([{ file: "0099_semicolon.sql", version: "0099_semicolon", sql: `INSERT INTO schema_migrations(version, description) VALUES ('0099_semicolon', 'Keep literal semicolons; and escaped quote ''safe''') ON CONFLICT(version) DO NOTHING;\n` }])).resolves.toMatchObject({ plan: expect.stringContaining("0099_semicolon.sql\t0099_semicolon") });
    await expect(runPlanner([{ file: "0099_layout.sql", version: "0099_layout", sql: `INSERT INTO schema_migrations(version,description) VALUES ('0098_wrong','x');\n` }])).rejects.toThrow();
    await expect(runPlanner([{ file: "0099_dynamic.sql", version: "0099_dynamic", sql: `INSERT INTO schema_migrations(version,description) VALUES (current_setting('app.version'),'x');\n` }])).rejects.toThrow();
    await expect(runPlanner([{ file: "0099_a.sql", version: "0099_same", sql: "select 1;" }, { file: "0099_b.sql", version: "0099_same", sql: "select 2;" }])).rejects.toThrow();
    await expect(runPlanner([{ file: "0099_a.sql", version: "", sql: "select 1;" }])).rejects.toThrow();
    await expect(runPlanner([{ file: "0099_a.sql", version: "0099_a", sql: "select 1;", sha: "0".repeat(64) }])).rejects.toThrow();
  }, 20_000);

  it("quotes all state literals, validates a closed enum and preserves restoration failures", async () => {
    for (const name of ["scripts/deploy-production.sh", "scripts/rollback-production.sh", "scripts/production-preflight.sh"]) {
      const script = await read(name);
      const shellConditionals = script.split(/\r?\n/).filter(line => line.includes("[[")).join("\n");
      expect(shellConditionals).not.toMatch(/==\s+(?:active|inactive|failed|not-found|success|true|false)(?:\s|\]\])/);
    }
    const deploy = await read("scripts/deploy-production.sh");
    expect(deploy).toContain("active|inactive|failed|not-found");
    expect(deploy).toContain('restore_unit_state peilv.service "$original_app_state"');
    expect(deploy).toContain('restore_unit_state peilv-reconcile.timer "$original_reconcile_timer_state"');
    expect(deploy).toContain('restore_unit_state peilv-dispatch.timer "$original_dispatch_timer_state"');
    expect(deploy).toMatch(/state restoration failed[^\n]*status=1/);
    expect(deploy).not.toMatch(/restore_unit_state[^\n]*\|\| true/);
  });

  it("clears historical oneshot failures only after stopping timers and before fail-closed waits", async () => {
    const deploy = await read("scripts/deploy-production.sh");
    const stop = deploy.indexOf("systemctl stop peilv-dispatch.timer peilv-reconcile.timer", deploy.indexOf("write_transaction_state maintenance_entering"));
    const reset = deploy.indexOf("systemctl reset-failed peilv-dispatch.service peilv-reconcile.service", stop);
    const wait = deploy.indexOf("wait_for_inactive peilv-dispatch.service", reset);
    expect(stop).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(stop);
    expect(wait).toBeGreaterThan(reset);
  });

  it("dynamically restores active/inactive states, reports failures, and has no unbound variable", async () => {
    const script = await read("scripts/deploy-production.sh");
    const functions = script.slice(script.indexOf("validate_unit_state()"), script.indexOf("create_probe_runtime()"));
    const sandbox = await mkdtemp(join(tmpdir(), "peilv-state-"));
    const harness = join(sandbox, "state.sh");
    await writeFile(harness, `#!/usr/bin/env bash\nset -Eeuo pipefail\n${functions}\ndeclare -A states=([app]=inactive [timer]=active [broken]=inactive)\nsystemctl(){ local action=\"$1\" unit=\"$2\"; case \"$action\" in start) [[ \"$unit\" != broken ]] || return 9; states[$unit]=active;; stop) states[$unit]=inactive;; is-active) printf '%s\\n' \"\${states[$unit]}\";; *) return 1;; esac; }\nrestore_unit_state app active\n[[ \"\${states[app]}\" == active ]]\nrestore_unit_state timer inactive\n[[ \"\${states[timer]}\" == inactive ]]\nif restore_unit_state broken active; then exit 90; fi\nprintf 'recovery failure reported\\n' >&2\n`);
    const result = await exec("bash", [harness]);
    expect(result.stderr).toContain("recovery failure reported");
  });

  it.each(["scripts/deploy-production.sh", "scripts/rollback-production.sh"])("fails closed on indeterminate inactive waits in %s", async name => {
    const wait = functionSource(await read(name), "wait_for_inactive", "stop_candidate");
    const sandbox = await mkdtemp(join(tmpdir(), "peilv-inactive-"));
    const harness = join(sandbox, "inactive.sh");
    await writeFile(harness, `#!/usr/bin/env bash\nset -Eeuo pipefail\n${wait}\nsleep(){ :; }\nrun(){ local sequence="$1" expected="$2" counter="$3"; printf '0\\n' >"$counter"; systemctl(){ local calls value values; calls=$(<"$counter"); calls=$((calls+1)); printf '%s\\n' "$calls" >"$counter"; IFS=, read -ra values <<<"$sequence"; value="\${values[calls-1]:-EMPTY}"; [[ "$value" != EMPTY ]] && printf '%s\\n' "$value"; return 0; }; if wait_for_inactive sample.service >/dev/null 2>&1; then actual=ok; else actual=fail; fi; [[ "$actual" == "$expected" ]]; }\ncounter="$(dirname "$0")/counter"\nrun inactive ok "$counter"\nrun active,inactive ok "$counter"\nrun activating,inactive ok "$counter"\nrun deactivating,inactive ok "$counter"\nrun failed fail "$counter"\nrun not-found fail "$counter"\nrun EMPTY fail "$counter"\nrun maintenance fail "$counter"\n`);
    await expect(exec("bash", [harness])).resolves.toMatchObject({ stdout: "" });
  }, 30_000);
});
