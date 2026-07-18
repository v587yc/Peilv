import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
function scrypt(password: string, salt: Buffer, keyLength: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => nodeScrypt(password, salt, keyLength, options, (error, key) => {
    if (error) reject(error);
    else resolve(key);
  }));
}
const KEY_LENGTH = 64;
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 32 * 1024 * 1024;
const COMMON_PASSWORDS = new Set([
  "password123", "password1234", "admin123456", "administrator123",
  "qwerty123456", "abc123456789", "123456789abc", "letmein123456",
  "welcome123456", "changeme123456",
]);

export function validateAdminPassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 12) return "密码至少需要 12 个字符";
  if (password.length > 200) return "密码不能超过 200 个字符";
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return "密码必须同时包含字母和数字";
  const normalized = password.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (COMMON_PASSWORDS.has(normalized)) return "密码过于常见，请使用更强的密码";
  return null;
}

export async function hashAdminPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
    maxmem: MAX_MEMORY,
  });
  return `scrypt$v=1$N=${COST},r=${BLOCK_SIZE},p=${PARALLELIZATION}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyAdminPassword(password: unknown, encoded: unknown): Promise<boolean> {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  const parts = encoded.split("$");
  if (parts.length !== 5 || parts[0] !== "scrypt" || parts[1] !== "v=1") return false;
  const parameters = Object.fromEntries(parts[2].split(",").map(item => item.split("=")));
  const N = Number(parameters.N);
  const r = Number(parameters.r);
  const p = Number(parameters.p);
  if (N !== COST || r !== BLOCK_SIZE || p !== PARALLELIZATION) return false;
  try {
    const salt = Buffer.from(parts[3], "base64url");
    const expected = Buffer.from(parts[4], "base64url");
    if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;
    const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAX_MEMORY });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
