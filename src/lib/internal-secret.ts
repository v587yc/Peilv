import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";

const MIN_SECRET_CHARS = 32;
const MAX_SECRET_CHARS = 128;
const SECRET_PATTERN = /^[A-Za-z0-9_-]+$/;

type FileMetadata = ReturnType<typeof fstatSync>;
export type InternalSecretFileOps = {
  open(path: string, flags: number): number;
  close(fd: number): void;
  fstat(fd: number): FileMetadata;
  lstat(path: string): FileMetadata;
  read(fd: number): string;
};

const realFileOps: InternalSecretFileOps = {
  open: openSync,
  close: closeSync,
  fstat: fstatSync,
  lstat: lstatSync,
  read: fd => readFileSync(fd, "utf8"),
};

export function normalizeInternalApiSecret(raw: string): string {
  const value = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (value.length < MIN_SECRET_CHARS || value.length > MAX_SECRET_CHARS || !SECRET_PATTERN.test(value)) {
    throw new Error("内部认证凭据必须是32至128位base64url字符");
  }
  return value;
}

export function resolveInternalApiSecretPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (env.NODE_ENV === "production") {
    if (platform === "win32") throw new Error("Windows生产自动化不受支持；请使用Linux systemd credential部署");
    if (env.INTERNAL_API_SECRET_FILE || env.INTERNAL_API_SECRET) {
      throw new Error("生产环境禁止通过环境变量指定内部认证凭据");
    }
    const directory = env.CREDENTIALS_DIRECTORY;
    if (!directory || !/^\/run\/credentials\/[A-Za-z0-9_.@-]+$/.test(directory)) {
      throw new Error("生产环境必须使用systemd运行凭据目录");
    }
    return `${directory}/internal-api-secret`;
  }
  if (env.INTERNAL_API_SECRET_FILE) return resolve(env.INTERNAL_API_SECRET_FILE);
  if (env.CREDENTIALS_DIRECTORY) return resolve(env.CREDENTIALS_DIRECTORY, "internal-api-secret");
  return null;
}

function validateParentDirectories(path: string, ops: InternalSecretFileOps): void {
  const root = parse(path).root;
  let current = dirname(path);
  while (current) {
    const metadata = ops.lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("内部认证凭据父目录无效");
    if (Number(metadata.uid) !== 0) throw new Error("内部认证凭据父目录所有者无效");
    if ((Number(metadata.mode) & 0o022) !== 0) throw new Error("内部认证凭据父目录权限过宽");
    if (current === root) break;
    current = dirname(current);
  }
}

function validateFileMetadata(metadata: FileMetadata, uid?: number, systemdRuntimeCredential = false): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("内部认证凭据文件无效");
  const permissions = Number(metadata.mode) & 0o777;
  if (systemdRuntimeCredential) {
    if (permissions !== 0o440 || Number(metadata.uid) !== 0) throw new Error("systemd运行凭据文件权限无效");
  } else if ((permissions & 0o077) !== 0) {
    throw new Error("内部认证凭据文件权限过宽");
  }
  if (Number(metadata.nlink) !== 1) throw new Error("内部认证凭据文件链接数无效");
  if (uid !== undefined) {
    if (Number(metadata.uid) !== 0 && Number(metadata.uid) !== uid) throw new Error("内部认证凭据文件所有者无效");
  }
  if (metadata.size < MIN_SECRET_CHARS || metadata.size > MAX_SECRET_CHARS + 1) throw new Error("内部认证凭据文件大小无效");
}

export function readInternalApiSecretFile(
  path: string,
  ops: InternalSecretFileOps = realFileOps,
  runtime: { platform: NodeJS.Platform; uid?: number } = {
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  },
): string {
  const systemdRuntimeCredential = runtime.platform !== "win32" && /^\/run\/credentials\/[A-Za-z0-9_.@-]+\/internal-api-secret$/.test(path);
  const resolved = resolve(path);
  if (runtime.platform !== "win32") validateParentDirectories(resolved, ops);
  const noFollow = runtime.platform !== "win32" && typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = ops.open(resolved, constants.O_RDONLY | noFollow);
  try {
    const before = ops.fstat(fd);
    if (runtime.platform !== "win32") validateFileMetadata(before, runtime.uid, systemdRuntimeCredential);
    const value = ops.read(fd);
    const after = ops.fstat(fd);
    if (runtime.platform !== "win32") validateFileMetadata(after, runtime.uid, systemdRuntimeCredential);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs ||
      before.mode !== after.mode || before.uid !== after.uid || before.nlink !== after.nlink
    ) {
      throw new Error("内部认证凭据文件在读取期间发生变化");
    }
    return normalizeInternalApiSecret(value);
  } finally {
    ops.close(fd);
  }
}

export function getInternalApiSecret(): string {
  const path = resolveInternalApiSecretPath();
  if (path) return readInternalApiSecretFile(path);
  if (process.env.NODE_ENV === "production") throw new Error("生产环境必须使用内部认证凭据文件");
  const value = process.env.INTERNAL_API_SECRET;
  if (!value) throw new Error("内部认证凭据未配置");
  return normalizeInternalApiSecret(value);
}
