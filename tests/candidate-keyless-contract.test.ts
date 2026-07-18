import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readInternalApiSecretFile, resolveInternalApiSecretPath, type InternalSecretFileOps } from "@/lib/internal-secret";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const candidateBlock = (script: string): string => {
  const start = script.indexOf('candidate_start', script.indexOf('candidate_started_at='));
  const end = script.indexOf("stop_candidate", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
};
const hardening = [
  "NoNewPrivileges=true", "PrivateTmp=true", "ProtectSystem=strict", "ProtectHome=true",
  "PrivateDevices=true", "ProtectKernelTunables=true", "ProtectKernelModules=true",
  "ProtectControlGroups=true", "RestrictSUIDSGID=true", "LockPersonality=true",
];

describe("keyless deployment candidate contract", () => {
  it.each(["deploy-production.sh", "rollback-production.sh"])("keeps the candidate and trusted helper boundary keyless in %s", async name => {
    const script = await read(`scripts/${name}`);
    const candidate = `${candidateBlock(script)}\n${await read("scripts/lib/candidate-lifecycle.sh")}`;
    expect(candidate).not.toMatch(/LoadCredential|INTERNAL_API_SECRET|internal_secret_file|curl_secret_helper|curl-secret\.sh/i);
    expect(candidate).toContain("check_candidate_application 5001");
    const lifecycle = await read("scripts/lib/candidate-lifecycle.sh");
    const checkStart = lifecycle.indexOf("candidate_probe() {");
    const checkEnd = lifecycle.indexOf(String.fromCharCode(10) + "}", checkStart);
    const readinessCheck = lifecycle.slice(checkStart, checkEnd);
    expect(readinessCheck).toContain("/api/readiness");
    expect(readinessCheck).not.toMatch(/LoadCredential|INTERNAL_API_SECRET|internal_secret_file|curl_secret_helper|curl-secret\.sh|\/api\/storage\/health/i);
    expect(script).not.toContain("install_release_curl_secret_helper");
    expect(script).not.toMatch(/(?:candidate|target|current)_curl_secret_helper/);
  });

  it.each(["INTERNAL_API_SECRET", "INTERNAL_API_SECRET_FILE", "CREDENTIALS_DIRECTORY", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD"])("blocks %s in app.env", async key => {
    const preflight = await read("scripts/production-preflight.sh");
    const guard = preflight.split(String.fromCharCode(10)).find(line => line.includes("grep -E") && line.includes("app.env")) || "";
    expect(guard, key).toContain(key);
    expect(preflight.slice(preflight.indexOf(guard), preflight.indexOf(guard) + 500)).toContain("check_blocked internal_secret_environment");
  });

  it("rejects production secret-file injection and constrains the systemd credential directory", () => {
    expect(() => resolveInternalApiSecretPath({ NODE_ENV: "production", INTERNAL_API_SECRET_FILE: "/tmp/forged" }, "linux")).toThrow(/禁止通过环境变量/);
    expect(() => resolveInternalApiSecretPath({ NODE_ENV: "production", INTERNAL_API_SECRET: "A".repeat(32) }, "linux")).toThrow(/禁止通过环境变量/);
    expect(() => resolveInternalApiSecretPath({ NODE_ENV: "production", CREDENTIALS_DIRECTORY: "/tmp/forged" }, "linux")).toThrow(/systemd运行凭据目录/);
    expect(resolveInternalApiSecretPath({ NODE_ENV: "production", CREDENTIALS_DIRECTORY: "/run/credentials/peilv.service" }, "linux")).toBe("/run/credentials/peilv.service/internal-api-secret");
    expect(() => resolveInternalApiSecretPath({ NODE_ENV: "production", CREDENTIALS_DIRECTORY: "/run/credentials/../forged" }, "linux")).toThrow(/systemd运行凭据目录/);
  });

  it("rejects a same-size credential rewrite using the second complete fstat", () => {
    let count = 0;
    const base = {
      dev: 1, ino: 2, size: 32, mode: 0o100600, uid: 0, nlink: 1,
      mtimeMs: 100, ctimeMs: 100,
      isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
    };
    const parent = { ...base, mode: 0o40755, isFile: () => false, isDirectory: () => true } as never;
    const ops: InternalSecretFileOps = {
      open: () => 9, close: () => {}, read: () => "B".repeat(32), lstat: () => parent,
      fstat: () => ({ ...base, mtimeMs: ++count === 1 ? 100 : 101, ctimeMs: count === 1 ? 100 : 101 }) as never,
    };
    expect(() => readInternalApiSecretFile("/secure/credentials/internal-api-secret", ops, { platform: "linux", uid: 1000 })).toThrow(/读取期间发生变化/);
  });

  it("compares complete identity and timestamp metadata across both fstat calls", async () => {
    const source = await read("src/lib/internal-secret.ts");
    for (const field of ["dev", "ino", "size", "mtime", "ctime"]) {
      expect(source, field).toMatch(new RegExp(`before\.${field}(?:Ms)?[^\n]+after\.${field}(?:Ms)?`));
    }
  });

  it("ships a dedicated hardened dispatch service with its own identity and credential", async () => {
    const unit = await read("infra/systemd/peilv-dispatch.service");
    expect(unit).toMatch(/^User=peilv-dispatch$/m);
    expect(unit).toMatch(/^Group=[a-z][a-z0-9_-]*$/m);
    expect(unit).toContain("LoadCredential=internal-api-secret:/opt/peilv/shared/credentials/internal-api-secret");
    expect(unit).not.toMatch(/^User=peilv$/m);
    expect(unit).not.toMatch(/^Environment=INTERNAL_API_SECRET/m);
    for (const setting of hardening) expect(unit, setting).toContain(setting);
  });

  it("keeps secret rotation dry-run-only until explicit production approval", async () => {
    const names = await readdir(new URL("../scripts/", import.meta.url));
    const rotation = names.filter(name => /rotate.*(?:secret|credential).*\.sh$/i.test(name));
    expect(rotation).toHaveLength(1);
    const script = await read(`scripts/${rotation[0]}`);
    expect(script).toContain('[[ "${1:-}" == --dry-run && $# == 1 ]]');
    expect(script).toMatch(/explicit production approval/i);
    expect(script).toMatch(/DRY-RUN ONLY/i);
    expect(script).toMatch(/no credential was read or changed/i);
    const executableLines = script.split(String.fromCharCode(10)).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    expect(executableLines.some(line => /^(?:mv|install)\s/.test(line))).toBe(false);
  });
});
