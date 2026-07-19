import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);

describe("CI real PostgreSQL concurrency contract", () => {
  it("reserves capacity for 100 independent connections and keeps real PG acknowledgement", async () => {
    const workflow = await readFile(workflowUrl, "utf8");

    expect(workflow).toContain("image: postgres:15-alpine");
    expect(workflow).toContain('ALTER SYSTEM SET max_connections = 200');
    expect(workflow).toContain("SHOW max_connections");
    expect(workflow).toContain('test "$max_connections" -ge 120');
    expect(workflow).toContain("AUTOMATION_TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres");
    expect(workflow).toContain("AUTOMATION_TEST_DATABASE_ACK: ephemeral");
    expect(workflow).toContain("pnpm exec vitest run");
  });
});
