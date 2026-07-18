import { NextResponse } from "next/server";
import { requireAdminCapability, type AdminCapability, type AdminPrincipal } from "@/lib/auth/admin-capabilities";
import { writeAuditLog } from "@/lib/audit-log";
import { logServerError, requestIdFor, safeErrorResponse } from "@/lib/api/safe-error-response";
import { getStrategyLabService } from "./server";
import { StrategyLabServiceError, type StrategyLabServiceErrorCode } from "./service-errors";

const headers = { "Cache-Control": "private, no-store" };
const mapping: Record<StrategyLabServiceErrorCode, { status: number; errorCode: string; message: string }> = {
  validation_error: { status: 400, errorCode: "STRATEGY_LAB_VALIDATION_ERROR", message: "请求参数无效" },
  not_found: { status: 404, errorCode: "STRATEGY_LAB_NOT_FOUND", message: "策略实验室记录不存在" },
  idempotency_conflict: { status: 409, errorCode: "STRATEGY_LAB_IDEMPOTENCY_CONFLICT", message: "操作键已绑定其他数据" },
  concurrency_conflict: { status: 409, errorCode: "STRATEGY_LAB_CONCURRENCY_CONFLICT", message: "记录已变化，请刷新后重试" },
  integrity_error: { status: 422, errorCode: "STRATEGY_LAB_INTEGRITY_ERROR", message: "策略实验室证据不一致" },
  capability_unavailable: { status: 503, errorCode: "STRATEGY_LAB_CAPABILITY_UNAVAILABLE", message: "该能力暂时不可用" },
  dependency_unavailable: { status: 503, errorCode: "STRATEGY_LAB_DEPENDENCY_UNAVAILABLE", message: "策略实验室依赖暂时不可用" },
  policy_denied: { status: 403, errorCode: "STRATEGY_LAB_POLICY_DENIED", message: "赛事不符合策略实验室策略" },
  strategy_d_not_executable: { status: 422, errorCode: "STRATEGY_D_NOT_EXECUTABLE", message: "策略D当前不可执行" },
  unexpected: { status: 500, errorCode: "STRATEGY_LAB_UNEXPECTED", message: "策略实验室操作失败" },
};

function success(requestId: string, result: unknown, status = 200) {
  return NextResponse.json({ success: true, result, requestId }, { status, headers: { ...headers, "x-request-id": requestId } });
}

async function authorize(request: Request, capability: AdminCapability): Promise<
  | { ok: true; principal: AdminPrincipal; requestId: string }
  | { ok: false; response: NextResponse; requestId: string }
> {
  const requestId = requestIdFor(request); const auth = await requireAdminCapability(request, capability);
  if (!auth.ok) return {
    ok: false,
    response: safeErrorResponse({
      requestId,
      errorCode: auth.status === 401 ? "ADMIN_AUTH_REQUIRED" : auth.status === 403 ? "ADMIN_PERMISSION_DENIED" : "ADMIN_AUTH_UNAVAILABLE",
      message: auth.error,
      status: auth.status,
    }),
    requestId,
  };
  return { ok: true, principal: auth.principal, requestId };
}

function mappedError(requestId: string, error: unknown) {
  const entry = error instanceof StrategyLabServiceError ? mapping[error.code] : mapping.unexpected;
  return safeErrorResponse({ requestId, errorCode: entry.errorCode, message: entry.message, status: entry.status });
}

export async function strategyLabReadRoute(
  request: Request,
  load: (service: NonNullable<ReturnType<typeof getStrategyLabService>>) => Promise<unknown>,
) {
  const authorization = await authorize(request, "admin:view"); if (!authorization.ok) return authorization.response;
  const service = getStrategyLabService();
  if (!service) return safeErrorResponse({ requestId: authorization.requestId, errorCode: "STRATEGY_LAB_REPOSITORY_UNAVAILABLE", message: "策略实验室存储暂时不可用", status: 503 });
  try { return success(authorization.requestId, await load(service)); }
  catch (error) { logServerError("strategy-lab.read", error, { requestId: authorization.requestId, actorId: authorization.principal.actorId }); return mappedError(authorization.requestId, error); }
}

export async function strategyLabWriteRoute(
  request: Request,
  input: {
    capability: Extract<AdminCapability, "admin:configure" | "admin:execute" | "admin:dangerous">;
    action: string; objectType: string;
    successStatus?: number;
    validateBody?: (body: unknown) => { success: true; data: unknown } | { success: false };
    execute: (service: NonNullable<ReturnType<typeof getStrategyLabService>>, body: unknown, actor: { actorId: string; traceId: string }) => Promise<unknown>;
  },
) {
  const authorization = await authorize(request, input.capability); if (!authorization.ok) return authorization.response;
  const body = await request.json().catch(() => null);
  const validated = input.validateBody?.(body);
  if (validated && !validated.success) return safeErrorResponse({ requestId: authorization.requestId, errorCode: "STRATEGY_LAB_VALIDATION_ERROR", message: "请求参数无效", status: 400 });
  const commandBody = validated?.data ?? body;
  const service = getStrategyLabService();
  if (!service) return auditedFailure(authorization.principal, authorization.requestId, input, "repository_unavailable", 503);
  try {
    const result = await input.execute(service, commandBody, { actorId: authorization.principal.actorId, traceId: authorization.requestId });
    const summary = summarize(result);
    let audited = false;
    try {
      audited = await writeAuditLog({
        actorId: authorization.principal.actorId, actorType: "admin", action: `${input.action}.succeeded`,
        objectType: input.objectType, objectId: summary.objectId, requestId: authorization.requestId,
        idempotencyKey: operationKeyFrom(commandBody), newValue: summary.value,
        metadata: { status: "succeeded", replay: summary.replay },
      });
    } catch (error) {
      logServerError("strategy-lab.audit-write", error, { action: input.action, requestId: authorization.requestId });
    }
    const action = commandActionFor(input.action);
    let auditStatus: "audited" | "pending" = audited ? "audited" : "pending";
    try {
      const receipt = await service.markCommandAudit(action, operationKeyFrom(commandBody) || "", audited, audited ? undefined : "AUDIT_PERSISTENCE_FAILED");
      auditStatus = receipt.status === "audited" ? "audited" : "pending";
    } catch (error) {
      auditStatus = "pending";
      logServerError("strategy-lab.audit-receipt", error, { action: input.action, requestId: authorization.requestId });
    }
    return success(authorization.requestId, { ...(result as object), auditStatus, replayed: summary.replay }, summary.replay ? 200 : input.successStatus ?? 201);
  } catch (error) {
    const code = error instanceof StrategyLabServiceError ? error.code : "unexpected";
    try {
      await writeAuditLog({
        actorId: authorization.principal.actorId, actorType: "admin", action: `${input.action}.failed`,
        objectType: input.objectType, objectId: resourceIdFrom(body), requestId: authorization.requestId,
        idempotencyKey: operationKeyFrom(body), metadata: { status: "failed", errorCode: code },
      });
    } catch (auditError) {
      logServerError("strategy-lab.failed-audit", auditError, { action: input.action, requestId: authorization.requestId });
    }
    logServerError("strategy-lab.write", error, { action: input.action, requestId: authorization.requestId, actorId: authorization.principal.actorId });
    return mappedError(authorization.requestId, error);
  }
}

function commandActionFor(action: string) {
  if (action.endsWith("run.create")) return "run.create" as const;
  if (action.endsWith("run.transition")) return "run.transition" as const;
  if (action.endsWith("snapshot.capture")) return "snapshot.capture" as const;
  if (action.endsWith("prediction.execute")) return "prediction.execute" as const;
  return "settlement.create" as const;
}

async function auditedFailure(
  principal: AdminPrincipal,
  requestId: string,
  input: { action: string; objectType: string },
  errorCode: string,
  status: number,
) {
  try {
    await writeAuditLog({ actorId: principal.actorId, actorType: "admin", action: `${input.action}.failed`, objectType: input.objectType, requestId, metadata: { status: "failed", errorCode } });
  } catch (auditError) {
    logServerError("strategy-lab.unavailable-audit", auditError, { action: input.action, requestId });
  }
  return safeErrorResponse({ requestId, errorCode: "STRATEGY_LAB_REPOSITORY_UNAVAILABLE", message: "策略实验室存储暂时不可用", status });
}

function summarize(result: unknown) {
  const candidate = result as Record<string, unknown> | null;
  const nested = candidate?.value;
  const value = nested && typeof nested === "object" ? nested as Record<string, unknown> : candidate;
  const id = typeof value?.id === "string" ? value.id : null;
  const replay = candidate?.status === "existing";
  return {
    objectId: id,
    replay,
    value: { id, status: typeof value?.status === "string" ? value.status : undefined, decisionStatus: typeof value?.decisionStatus === "string" ? value.decisionStatus : undefined },
  };
}

function operationKeyFrom(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).operationKey;
  return typeof value === "string" && value.length <= 128 ? value : null;
}

function resourceIdFrom(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as Record<string, unknown>;
  for (const key of ["id", "predictionId", "snapshotSetId", "runId"]) {
    if (typeof candidate[key] === "string" && candidate[key] !== "") return candidate[key];
  }
  return null;
}
