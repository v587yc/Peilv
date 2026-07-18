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
});
