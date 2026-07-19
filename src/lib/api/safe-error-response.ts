import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

const noStoreHeaders = { "Cache-Control": "private, no-store" };

export class SafeClientError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
    this.name = "SafeClientError";
  }
}

export function requestIdFor(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && supplied.length <= 200 ? supplied : randomUUID();
}

export function safeErrorResponse(input: {
  requestId: string;
  errorCode: string;
  message: string;
  status: number;
}) {
  return NextResponse.json(
    { success: false, errorCode: input.errorCode, requestId: input.requestId, message: input.message },
    { status: input.status, headers: { ...noStoreHeaders, "x-request-id": input.requestId } },
  );
}

export function logServerError(scope: string, error: unknown, context: Record<string, unknown> = {}): void {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  console.error(JSON.stringify({
    level: "error",
    scope,
    error: {
      name: safeLogText(candidate?.name),
      code: safeLogText(candidate?.code),
      message: safeLogText(candidate?.message),
    },
    context: sanitizeLogValue(context),
  }));
}

function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return safeLogText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeLogValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([key, child]) => [
    key,
    /(?:token|secret|password|authorization|cookie|api[_-]?key|webhook)/i.test(key) ? "[redacted]" : sanitizeLogValue(child, depth + 1),
  ]));
}

function safeLogText(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  return value
    .slice(0, 1000)
    .replace(/(password|secret|token|authorization|cookie|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, "postgresql://[redacted]@");
}
