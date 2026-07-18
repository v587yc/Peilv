import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getInternalApiSecret, normalizeInternalApiSecret, readInternalApiSecretFile, resolveInternalApiSecretPath, type InternalSecretFileOps } from "@/lib/internal-secret";

const roots: string[] = [];
const originalNodeEnv = process.env.NODE_ENV;
const originalSecret = process.env.INTERNAL_API_SECRET;
const originalFile = process.env.INTERNAL_API_SECRET_FILE;
const originalCredentials = process.env.CREDENTIALS_DIRECTORY;
const mutableEnv = process.env as Record<string, string | undefined>;
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV; else mutableEnv.NODE_ENV = originalNodeEnv;
  if (originalSecret === undefined) delete process.env.INTERNAL_API_SECRET; else process.env.INTERNAL_API_SECRET = originalSecret;
  if (originalFile === undefined) delete process.env.INTERNAL_API_SECRET_FILE; else process.env.INTERNAL_API_SECRET_FILE = originalFile;
  if (originalCredentials === undefined) delete process.env.CREDENTIALS_DIRECTORY; else process.env.CREDENTIALS_DIRECTORY = originalCredentials;
});

async function credential(content: string, mode = 0o600) {
  const root = await mkdtemp(join(tmpdir(), "peilv-secret-")); roots.push(root);
  const path = join(root, "internal-api-secret");
  await writeFile(path, content, { mode }); await chmod(path, mode);
  return { root, path };
}

describe("internal API credential reader", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;
  posixIt("prefers a private file and trims only one trailing LF", async () => {
    const { path } = await credential("File_Secret_0123456789abcdefABCDEF\n");
    process.env.INTERNAL_API_SECRET_FILE = path;
    process.env.INTERNAL_API_SECRET = "Environment_Secret_0123456789ABCDEF";
    const metadata = { dev: 1, ino: 2, size: 33, uid: 0, nlink: 1, mode: 0o100600, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
    const directoryMetadata = { ...metadata, mode: 0o40700, isFile: () => false, isDirectory: () => true };
    const ops: InternalSecretFileOps = {
      open: () => 41,
      close: () => {},
      fstat: () => metadata as never,
      read: () => "File_Secret_0123456789abcdefABCDEF\n",
      lstat: () => directoryMetadata as never,
    };
    expect(resolveInternalApiSecretPath()).toBe(path);
    expect(readInternalApiSecretFile(path, ops, { platform: "linux", uid: 1000 })).toBe("File_Secret_0123456789abcdefABCDEF");
  });
  it("fails closed in production when only an environment value exists", () => {
    mutableEnv.NODE_ENV = "production"; delete process.env.INTERNAL_API_SECRET;
    delete process.env.INTERNAL_API_SECRET_FILE; delete process.env.CREDENTIALS_DIRECTORY;
    expect(() => getInternalApiSecret()).toThrow(process.platform === "win32" ? "Windows生产自动化不受支持" : "生产环境必须使用内部认证凭据文件");
  });
  it.each(["", "bad\r\n", "bad\nvalue", "short", "x".repeat(129), "Invalid.Secret.0123456789ABCDEFGHIJ"])("rejects invalid content", content => {
    expect(() => normalizeInternalApiSecret(content)).toThrow();
  });
  it("trims exactly one trailing LF", () => {
    const valid = "A".repeat(32);
    expect(normalizeInternalApiSecret(valid + String.fromCharCode(10))).toBe(valid);
    expect(() => normalizeInternalApiSecret(valid + String.fromCharCode(10) + String.fromCharCode(10))).toThrow();
  });
  posixIt("rejects broad permissions and symlinks", async () => {
    const broad = await credential("Secret_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ", 0o644); process.env.INTERNAL_API_SECRET_FILE = broad.path;
    expect(() => getInternalApiSecret()).toThrow("权限过宽");
    const privateFile = await credential("Secret_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ"); const link = join(privateFile.root, "link");
    await symlink(privateFile.path, link); process.env.INTERNAL_API_SECRET_FILE = link;
    expect(() => getInternalApiSecret()).toThrow("凭据文件无效");
  });
  it("validates and reads through the same descriptor and closes it", () => {
    const calls: string[] = [];
    const metadataBase = { dev: 1, ino: 2, size: 32, uid: 0, nlink: 1, mode: 0o100600, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
    const metadata = metadataBase as never;
    const ops: InternalSecretFileOps = {
      open: (_path, flags) => { calls.push("open"); expect(flags & constants.O_RDONLY).toBe(constants.O_RDONLY); if (typeof constants.O_NOFOLLOW === "number") expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW); return 41; },
      fstat: fd => { expect(fd).toBe(41); calls.push("fstat"); return metadata; },
      read: fd => { expect(fd).toBe(41); calls.push("read"); return "A".repeat(32); },
      close: fd => { expect(fd).toBe(41); calls.push("close"); },
      lstat: () => ({ ...metadataBase, mode: 0o40755, uid: 0, isFile: () => false, isDirectory: () => true }) as never,
    };
    expect(readInternalApiSecretFile("/secure/credentials/internal-api-secret", ops, { platform: "linux", uid: 1000 })).toBe("A".repeat(32));
    expect(calls.slice(-5)).toEqual(["open", "fstat", "read", "fstat", "close"]);
  });

  it("accepts only root-owned 0440 systemd runtime credentials", () => {
    const metadataBase = { dev: 1, ino: 2, size: 32, uid: 0, nlink: 1, mode: 0o100440, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
    const ops = (metadata: typeof metadataBase): InternalSecretFileOps => ({
      open: () => 41,
      close: () => {},
      fstat: () => metadata as never,
      read: () => "A".repeat(32),
      lstat: () => ({ ...metadataBase, mode: 0o40755, uid: 0, isFile: () => false, isDirectory: () => true }) as never,
    });
    const path = "/run/credentials/peilv.service/internal-api-secret";
    expect(readInternalApiSecretFile(path, ops(metadataBase), { platform: "linux", uid: 1000 })).toBe("A".repeat(32));
    expect(() => readInternalApiSecretFile(path, ops({ ...metadataBase, mode: 0o100460 }), { platform: "linux", uid: 1000 })).toThrow("systemd运行凭据文件权限无效");
    expect(() => readInternalApiSecretFile(path, ops({ ...metadataBase, uid: 1000 }), { platform: "linux", uid: 1000 })).toThrow("systemd运行凭据文件权限无效");
  });

  it("rejects an unsafe parent before opening the credential on POSIX", () => {
    let opened = false;
    const metadata = { dev: 1, ino: 2, size: 32, uid: 1000, nlink: 1, mode: 0o040777, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false } as never;
    const ops: InternalSecretFileOps = { open: () => { opened = true; return 1; }, close: () => {}, fstat: () => metadata, read: () => "A".repeat(32), lstat: () => metadata };
    expect(() => readInternalApiSecretFile("/unsafe/credentials/internal-api-secret", ops, { platform: "linux", uid: 1000 })).toThrow(/父目录/);
    expect(opened).toBe(false);
  });

  it("rejects a credential changed during the same-descriptor read", () => {
    let statCount = 0;
    const base = { dev: 1, ino: 2, size: 32, uid: 0, nlink: 1, mode: 0o100600, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
    const ops: InternalSecretFileOps = {
      open: () => 41, close: () => {}, read: () => "A".repeat(32),
      fstat: () => ({ ...base, size: ++statCount === 1 ? 32 : 33 }) as never,
      lstat: () => ({ ...base, isFile: () => false, isDirectory: () => true }) as never,
    };
    expect(() => readInternalApiSecretFile("/secure/credentials/internal-api-secret", ops, { platform: "linux", uid: 1000 })).toThrow("读取期间发生变化");
  });

  it("rejects a same-size in-place rewrite detected by mtime and ctime", () => {
    let statCount = 0;
    const base = { dev: 1, ino: 2, size: 32, uid: 0, nlink: 1, mode: 0o100600, ctimeMs: 10, mtimeMs: 10, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
    const ops: InternalSecretFileOps = {
      open: () => 41, close: () => {}, read: () => "A".repeat(32),
      fstat: () => ({ ...base, ctimeMs: ++statCount === 1 ? 10 : 11, mtimeMs: statCount === 1 ? 10 : 11 }) as never,
      lstat: () => ({ ...base, mode: 0o40755, uid: 0, isFile: () => false, isDirectory: () => true }) as never,
    };
    expect(() => readInternalApiSecretFile("/secure/credentials/internal-api-secret", ops, { platform: "linux", uid: 1000 })).toThrow("读取期间发生变化");
  });

  it("accepts only a systemd runtime credential directory in production", () => {
    expect(() => resolveInternalApiSecretPath({ NODE_ENV: "production", INTERNAL_API_SECRET_FILE: "/tmp/secret" }, "linux")).toThrow("禁止通过环境变量指定");
    expect(() => resolveInternalApiSecretPath({ NODE_ENV: "production", CREDENTIALS_DIRECTORY: "/tmp/credentials" }, "linux")).toThrow("systemd运行凭据目录");
    expect(resolveInternalApiSecretPath({ NODE_ENV: "production", CREDENTIALS_DIRECTORY: "/run/credentials/peilv.service" }, "linux")).toBe("/run/credentials/peilv.service/internal-api-secret");
    expect(() => resolveInternalApiSecretPath({ NODE_ENV: "production", CREDENTIALS_DIRECTORY: "/run/credentials/peilv.service" }, "win32")).toThrow("Windows生产自动化不受支持");
  });

});
