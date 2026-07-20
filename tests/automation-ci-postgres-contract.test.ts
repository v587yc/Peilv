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

  it("runs the Linux-only Host TCB root suite as a required CI command", async () => {
    const workflow = await readFile(workflowUrl, "utf8");
    const job = workflow.match(/  host-tcb-linux-real-semantics:\n([\s\S]*?)(?=\n  [a-z][a-z0-9-]+:|$)/)?.[1];
    const vitestConfig = await readFile(new URL("../vitest.config.ts", import.meta.url), "utf8");

    expect(job).toBeDefined();
    expect(job).toContain("sudo env PATH=\"$PATH\" pnpm exec vitest run tests/deploy-v3-bootstrap-linux.test.ts");
    expect(job).toContain("command -v sudo visudo flock sha256sum");
    expect(job).not.toContain("continue-on-error");
    expect(job).not.toMatch(/\bskip\b/i);
    expect(vitestConfig).toContain('"**/*-linux.test.ts"');
    expect(vitestConfig).not.toContain('"**/*.linux.test.ts"');
  });
});
