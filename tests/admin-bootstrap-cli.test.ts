import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/admin-bootstrap.mjs", import.meta.url));

function runCli(env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

describe("admin bootstrap CLI", () => {
  it("rejects argv input so secrets cannot enter shell history or process listings", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(process.execPath, [script, "forbidden-secret"], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.on("close", code => resolve({ code, stdout, stderr }));
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("不接受参数");
    expect(result.stdout).not.toContain("forbidden-secret");
    expect(result.stderr).not.toContain("forbidden-secret");
  });

  it.each([
    ["ftp://127.0.0.1:5000", "只允许 http 或 https"],
    ["http://user:secret@127.0.0.1:5000", "禁止包含凭据"],
    ["http://127.0.0.1:5000?token=secret", "禁止包含凭据"],
    ["http://example.com:5000", "远程初始化只允许 HTTPS"],
    ["https://example.com/bootstrap", "只能配置 origin"],
  ])("rejects unsafe base URL %s before reading credentials", async (url, message) => {
    const result = await runCli({ ADMIN_BOOTSTRAP_BASE_URL: url, ADMIN_BOOTSTRAP_TOKEN: "protected-test-token" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).not.toContain("protected-test-token");
    expect(result.stderr).not.toContain("protected-test-token");
  });

  it("requires an explicit boundary opt-in for remote HTTPS", async () => {
    const result = await runCli({ ADMIN_BOOTSTRAP_BASE_URL: "https://example.com", ADMIN_BOOTSTRAP_TOKEN: "protected-test-token", ADMIN_BOOTSTRAP_ALLOW_REMOTE_HTTPS: "false" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ADMIN_BOOTSTRAP_ALLOW_REMOTE_HTTPS=true");
  });
});
