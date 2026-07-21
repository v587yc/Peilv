import { describe, expect, it } from "vitest";
import { buildLockedMigrationSql } from "../scripts/run-migrations.mjs";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

describe("run-migrations 0001 alias compatibility", () => {
  it("does not insert both 0001 aliases into migration_expected", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mig-"));
    const sql = "-- baseline\n";
    const sha = createHash("sha256").update(sql).digest("hex");
    await writeFile(path.join(dir, "0001_production_baseline.sql"), sql);
    const plan = ["0001_production_baseline.sql", "0001_production_baseline", sha, "true", "managed"].join("\t") + "\n";
    const out = await buildLockedMigrationSql({ migrationsDirectory: dir, planText: plan });
    expect(out).toContain("INSERT INTO migration_expected(version) VALUES ('0001_production_baseline')");
    expect(out).not.toContain("('0001_production_baseline'),('0001_canonical_baseline')");
    expect(out).toContain("m.version='0001_canonical_baseline' AND e.version='0001_production_baseline'");
    expect(out).not.toContain("UPDATE migration_expected SET version='0001_canonical_baseline'");
  });
});
