import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const scriptPath = new URL("../scripts/production-preflight.sh", import.meta.url);
const scriptRelativePath = path.relative(process.cwd(), fileURLToPath(scriptPath));

describe("production preflight shell syntax", () => {
  it("keeps Linux shell control words free of carriage returns", async () => {
    const source = await readFile(scriptPath);

    expect(source.includes(0x0d)).toBe(false);
  });

  it("parses without executing preflight", async () => {
    await expect(exec("bash", ["-n", scriptRelativePath], { cwd: process.cwd() })).resolves.toMatchObject({
      stderr: "",
    });
  });

  it("keeps workflow embedded remote shells parseable", async () => {
    const workflow = await readFile(new URL("../.github/workflows/production-preflight.yml", import.meta.url), "utf8");
    const blocks = ["CAPACITY", "PUBLISH", "CLEANUP", "REMOTE"].map(label => {
      const match = workflow.match(new RegExp(`<<'${label}'[^\\n]*\\r?\\n([\\s\\S]*?)\\r?\\n {10}${label}`));
      return match?.[1];
    }).filter((block): block is string => Boolean(block));
    expect(blocks).toHaveLength(4);
    for (const block of blocks) {
      await expect(exec("bash", ["-n", "-c", block.replace(/^ {10}/gm, "")], { cwd: process.cwd() })).resolves.toMatchObject({ stderr: "" });
    }
  });
});
