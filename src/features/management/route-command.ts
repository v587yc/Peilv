import { NextResponse } from "next/server";
import type { AdminPrincipal } from "@/lib/auth/admin-capabilities";
import { writeAuditLog } from "@/lib/audit-log";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { createSupabaseCommandRepository } from "./command-repository";
import { AuditPersistenceError, CommandConflictError, executeAdminCommand } from "./commands";
import { CommandInputError } from "./commands";
import { logServerError, requestIdFor, safeErrorResponse } from "@/lib/api/safe-error-response";

const headers = { "Cache-Control": "private, no-store" };

export async function runRouteCommand<T>(request: Request, principal: AdminPrincipal, action: string, execute: (payload: Record<string, unknown>, targetId: string) => Promise<T>) {
  const requestId = requestIdFor(request);
  try {
    const raw = await request.json().catch(() => null);
    const outcome = await executeAdminCommand<Record<string, unknown>, T>({
      action,
      rawCommand: raw,
      principal,
      requestId,
      repository: createSupabaseCommandRepository(getSupabaseClient()),
      audit: writeAuditLog,
      execute: command => execute(command.payload, command.targetId),
    });
    return NextResponse.json({ success: true, accepted: outcome.commandStatus !== "completed", commandStatus: outcome.commandStatus, replayed: outcome.replayed, ...asObject(outcome.result) }, { status: outcome.commandStatus === "completed" ? 200 : 202, headers });
  } catch (error) {
    logServerError("management.route-command", error, { action, requestId });
    if (error instanceof CommandInputError) return safeErrorResponse({ requestId, errorCode: "INVALID_COMMAND", message: error.message, status: 400 });
    if (error instanceof CommandConflictError) return safeErrorResponse({ requestId, errorCode: "COMMAND_CONFLICT", message: error.message, status: 409 });
    if (error instanceof CommandRateLimitError) return safeErrorResponse({ requestId, errorCode: "RATE_LIMITED", message: "管理操作请求过于频繁", status: 429 });
    if (error instanceof AuditPersistenceError) return safeErrorResponse({ requestId, errorCode: "AUDIT_UNAVAILABLE", message: "审计服务暂时不可用，操作未执行", status: 503 });
    return safeErrorResponse({ requestId, errorCode: "MANAGEMENT_COMMAND_FAILED", message: "管理操作执行失败", status: 500 });
  }
}

function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { result: value }; }
export class CommandRateLimitError extends Error {}
