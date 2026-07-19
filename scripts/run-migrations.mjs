#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const STRATEGY_LAB_MIGRATION_LOCK_KEY = "731947205601172021";
const safeFile = /^[0-9]{4}_[a-z0-9_]+\.sql$/;
const safeVersion = /^[0-9]{4}_[a-z0-9_]+$/;
const safeSha = /^[0-9a-f]{64}$/;
const literal = value => `'${value.replaceAll("'", "''")}'`;

export function parseMigrationPlan(text) {
  const rows = text.trim().split("\n").filter(Boolean).map(line => {
    const [file, version, sha256, rollbackSafe, ledgerMode] = line.split("\t");
    if (!safeFile.test(file || "") || !safeVersion.test(version || "") || !safeSha.test(sha256 || "") ||
      !["true", "false"].includes(rollbackSafe) || !["self", "managed"].includes(ledgerMode)) throw new Error("Invalid migration plan");
    return { file, version, sha256, ledgerMode };
  });
  if (!rows.length || new Set(rows.map(row => row.file)).size !== rows.length || new Set(rows.map(row => row.version)).size !== rows.length) throw new Error("Invalid migration plan");
  return rows;
}

export async function buildLockedMigrationSql({ migrationsDirectory, planText }) {
  const rows = parseMigrationPlan(planText);
  const declared = rows.flatMap(row => row.file === "0001_production_baseline.sql" ? [row.version, "0001_canonical_baseline"] : [row.version]);
  const blocks = [];
  for (const row of rows) {
    const sql = await readFile(path.join(migrationsDirectory, row.file), "utf8");
    if (createHash("sha256").update(sql).digest("hex") !== row.sha256) throw new Error("Migration checksum mismatch");
    if (sql.split(/\r?\n/).some(line => line.trimStart().startsWith("\\"))) {
      throw new Error("Migration contains unsupported psql meta-command");
    }
    const aliases = row.file === "0001_production_baseline.sql" ? [row.version, "0001_canonical_baseline"] : [row.version];
    const aliasSql = aliases.map(literal).join(",");
    blocks.push(`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version IN(${aliasSql})) AS migration_applied \\gset
\\if :migration_applied
\\else
${sql}
${row.ledgerMode === "managed" ? `INSERT INTO schema_migrations(version,description) VALUES(${literal(row.version)},'deployment manifest managed ledger') ON CONFLICT(version) DO NOTHING;` : ""}
SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=${literal(row.version)}) AS migration_registered \\gset
\\if :migration_registered
\\else
\\quit 74
\\endif
\\endif`);
  }
  const expectedValues = declared.map(value => `(${literal(value)})`).join(",");
  return `\\set ON_ERROR_STOP on
SELECT pg_try_advisory_lock(${STRATEGY_LAB_MIGRATION_LOCK_KEY}) AS migration_lock_acquired \\gset
\\if :migration_lock_acquired
\\else
\\quit 73
\\endif
CREATE TEMP TABLE migration_expected(version text PRIMARY KEY) ON COMMIT PRESERVE ROWS;
INSERT INTO migration_expected(version) VALUES ${expectedValues};
DO $$ BEGIN IF EXISTS(SELECT 1 FROM schema_migrations WHERE version='0001_canonical_baseline') THEN UPDATE migration_expected SET version='0001_canonical_baseline' WHERE version='0001_production_baseline'; END IF; END $$;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM schema_migrations m WHERE NOT EXISTS(SELECT 1 FROM migration_expected e WHERE e.version=m.version)) THEN RAISE EXCEPTION 'migration ledger contains unknown version'; END IF; END $$;
${blocks.join("\n")}
DO $$ BEGIN IF EXISTS(SELECT version FROM (VALUES ${rows.map(row => `(${literal(row.version)})`).join(",")}) expected(version) WHERE NOT EXISTS(SELECT 1 FROM schema_migrations m WHERE m.version=expected.version)) THEN RAISE EXCEPTION 'migration plan incomplete'; END IF; END $$;
SELECT pg_advisory_unlock(${STRATEGY_LAB_MIGRATION_LOCK_KEY}) AS migration_lock_released \\gset
\\if :migration_lock_released
\\else
\\quit 75
\\endif
`;
}

export async function runMigrationProcess({ command="docker", args=["exec","-i","local-data-postgres-1","sh","-lc",'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1'], sql, spawnImpl=spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ["pipe", "ignore", "inherit"] });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Migration runner failed")));
    child.stdin.end(sql);
  });
}

async function main() {
  const [migrationsDirectory, planFile] = process.argv.slice(2);
  if (!migrationsDirectory || !planFile) throw new Error("Usage: run-migrations.mjs <migrations-directory> <plan-file>");
  const sql = await buildLockedMigrationSql({ migrationsDirectory, planText: await readFile(planFile, "utf8") });
  await runMigrationProcess({ sql });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"))) {
  main().catch(() => { process.stderr.write("Migration runner failed\n"); process.exitCode=1; });
}
