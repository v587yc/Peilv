import { timingSafeEqual } from "node:crypto";
import { getInternalApiSecret } from "@/lib/internal-secret";
import { getInternalRoutePurpose, type InternalRoutePurpose } from "@/lib/api-protection";

function secretMatches(value: string | null): boolean {
  if (!value) return false;
  let expected: string;
  try { expected = getInternalApiSecret(); } catch { return false; }
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

export function isAuthorizedInternalRoute(request: Request, expectedPurpose: InternalRoutePurpose): boolean {
  if (!isInternalRequest(request)) return false;
  const url = new URL(request.url);
  return getInternalRoutePurpose(url.pathname, request.method) === expectedPurpose;
}
