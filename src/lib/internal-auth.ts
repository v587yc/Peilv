import { timingSafeEqual } from "node:crypto";

function secretMatches(value: string | null): boolean {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected || !value) return false;
  const actualBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isInternalRequest(request: Request): boolean {
  return secretMatches(request.headers.get("x-internal-api-secret"));
}

export function assertInternalSecret(value: string | null | undefined): void {
  if (!secretMatches(value || null)) {
    throw new Error("内部任务认证失败");
  }
}
