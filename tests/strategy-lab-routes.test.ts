import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { StrategyLabServiceError } from "@/features/strategy-lab/service-errors";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), audit: vi.fn(), service: null as Record<string, ReturnType<typeof vi.fn>> | null }));
vi.mock("@/lib/auth/admin-capabilities", () => ({ requireAdminCapability: mocks.auth }));
vi.mock("@/lib/audit-log", () => ({ writeAuditLog: mocks.audit }));
vi.mock("@/features/strategy-lab/server", () => ({ getStrategyLabService: () => mocks.service }));

import { POST as createRun } from "@/app/api/admin/strategy-lab/runs/route";
import { GET as getRun, PATCH as transitionRun } from "@/app/api/admin/strategy-lab/runs/[id]/route";
import { POST as captureSnapshot } from "@/app/api/admin/strategy-lab/snapshots/route";
import { GET as getSnapshot } from "@/app/api/admin/strategy-lab/snapshots/[id]/route";
import { POST as executePrediction } from "@/app/api/admin/strategy-lab/predictions/route";
import { GET as getPrediction } from "@/app/api/admin/strategy-lab/predictions/[id]/route";
import { POST as createSettlement } from "@/app/api/admin/strategy-lab/settlements/route";
import { GET as getSettlement } from "@/app/api/admin/strategy-lab/settlements/[id]/route";

const id = "30000000-0000-4000-8000-000000000001";
const principal = { actorId: "real-admin", actorType: "admin", role: "super_admin", capabilities: ["admin:view", "admin:configure", "admin:execute", "admin:dangerous"] };
const request = (path: string, method = "GET", body?: unknown) => new NextRequest(`https://app.invalid${path}`, {
  method, headers: { "content-type": "application/json", "x-request-id": "request-route-1" }, body: body === undefined ? undefined : JSON.stringify(body),
});
const context = { params: Promise.resolve({ id }) };

function service() {
  return {
    createRun: vi.fn(), transitionRun: vi.fn(), captureSnapshotSet: vi.fn(), executeStrategy: vi.fn(), createSettlement: vi.fn(),
    getRun: vi.fn(), getSnapshotSet: vi.fn(), getPrediction: vi.fn(), getSettlement: vi.fn(),
    markCommandAudit: vi.fn(async () => ({ status: "audited" })),
  };
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.mockResolvedValue({ ok: true, principal }); mocks.audit.mockResolvedValue(true); mocks.service = service();
});

describe("strategy laboratory protected admin routes", () => {
  it.each([
    [401, { ok: false, status: 401, error: "未登录" }],
    [403, { ok: false, status: 403, error: "权限不足" }],
  ])("preserves admin guard status %s", async (status, authorization) => {
    mocks.auth.mockResolvedValue(authorization);
    const response = await createRun(request("/api/admin/strategy-lab/runs", "POST", {}));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      success: false,
      errorCode: status === 401 ? "ADMIN_AUTH_REQUIRED" : "ADMIN_PERMISSION_DENIED",
      requestId: "request-route-1",
    });
    expect(mocks.service!.createRun).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("requests the expected capability for reads, writes, execution and settlement", async () => {
    mocks.service!.getRun.mockResolvedValue({ id }); await getRun(request(`/api/admin/strategy-lab/runs/${id}`), context);
    mocks.service!.createRun.mockResolvedValue({ status: "created", replayed: false, value: { id } }); await createRun(request("/api/admin/strategy-lab/runs", "POST", {}));
    mocks.service!.executeStrategy.mockResolvedValue({ status: "created", replayed: false, value: { id } }); await executePrediction(request("/api/admin/strategy-lab/predictions", "POST", {}));
    mocks.service!.createSettlement.mockResolvedValue({ status: "created", replayed: false, value: { id } }); await createSettlement(request("/api/admin/strategy-lab/settlements", "POST", {}));
    expect(mocks.auth.mock.calls.map(call => call[1])).toEqual(["admin:view", "admin:configure", "admin:execute", "admin:dangerous"]);
  });

  it("returns 503 when the transaction repository service is not configured", async () => {
    mocks.service = null;
    const response = await createRun(request("/api/admin/strategy-lab/runs", "POST", { operationKey: "operation-0001" }));
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ errorCode: "STRATEGY_LAB_REPOSITORY_UNAVAILABLE", requestId: "request-route-1" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "strategy-lab.run.create.failed", actorId: principal.actorId }));
  });

  it("maps invalid body to 400 and rejects forged actor identity", async () => {
    mocks.service!.createRun.mockRejectedValue(new StrategyLabServiceError("validation_error"));
    const response = await createRun(request("/api/admin/strategy-lab/runs", "POST", { actorId: "forged", operationKey: "bad" }));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ errorCode: "STRATEGY_LAB_VALIDATION_ERROR", message: "请求参数无效" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "strategy-lab.run.create.failed", metadata: { status: "failed", errorCode: "validation_error" } }));
  });

  it("uses authenticated actor and request ID instead of body identity", async () => {
    mocks.service!.createRun.mockResolvedValue({ status: "created", replayed: false, value: { id, status: "pending" } });
    const body = { startDate: "20260717", endDate: "20260717", datasetCutoffAt: "2026-07-17T12:15:00.000Z", operationKey: "operation-run-1" };
    const response = await createRun(request("/api/admin/strategy-lab/runs", "POST", body));
    expect(response.status).toBe(201);
    expect(mocks.service!.createRun).toHaveBeenCalledWith(body, { actorId: principal.actorId, traceId: "request-route-1" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ actorId: principal.actorId, requestId: "request-route-1", idempotencyKey: body.operationKey, newValue: { id, status: "pending" } }));
    expect(mocks.service!.markCommandAudit).toHaveBeenCalledWith("run.create", body.operationKey, true, undefined);
    expect(await response.clone().json()).toMatchObject({ result: { auditStatus: "audited", replayed: false } });
  });

  it("returns 201 for created and 200 for idempotent existing", async () => {
    mocks.service!.captureSnapshotSet.mockResolvedValueOnce({ status: "created", replayed: false, value: { id } }).mockResolvedValueOnce({ status: "existing", replayed: true, value: { id } });
    expect((await captureSnapshot(request("/api/admin/strategy-lab/snapshots", "POST", {}))).status).toBe(201);
    expect((await captureSnapshot(request("/api/admin/strategy-lab/snapshots", "POST", {}))).status).toBe(200);
    expect(mocks.audit.mock.calls[1][0]).toMatchObject({ metadata: { status: "succeeded", replay: true } });
  });

  it.each([
    [new StrategyLabServiceError("not_found"), 404, "STRATEGY_LAB_NOT_FOUND"],
    [new StrategyLabServiceError("concurrency_conflict"), 409, "STRATEGY_LAB_CONCURRENCY_CONFLICT"],
    [new StrategyLabServiceError("idempotency_conflict"), 409, "STRATEGY_LAB_IDEMPOTENCY_CONFLICT"],
    [new StrategyLabServiceError("integrity_error"), 422, "STRATEGY_LAB_INTEGRITY_ERROR"],
    [new StrategyLabServiceError("capability_unavailable"), 503, "STRATEGY_LAB_CAPABILITY_UNAVAILABLE"],
    [new StrategyLabServiceError("dependency_unavailable"), 503, "STRATEGY_LAB_DEPENDENCY_UNAVAILABLE"],
    [new StrategyLabServiceError("strategy_d_not_executable"), 422, "STRATEGY_D_NOT_EXECUTABLE"],
  ])("maps safe service error %s", async (error, status, errorCode) => {
    mocks.service!.transitionRun.mockRejectedValue(error);
    const response = await transitionRun(request(`/api/admin/strategy-lab/runs/${id}`, "PATCH", { transition: "pending_to_running" }), context);
    expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ success: false, errorCode, requestId: "request-route-1" });
  });

  it("never leaks raw errors, SQL, stack or secrets", async () => {
    mocks.service!.createSettlement.mockRejectedValue(new Error("SELECT * FROM secret_table token=super-secret"));
    const response = await createSettlement(request("/api/admin/strategy-lab/settlements", "POST", { predictionId:id,quoteBasis:"actual",operationKey:"raw-error-settlement" }));
    expect(response.status).toBe(500); const body = await response.json();
    expect(body).toMatchObject({ errorCode: "STRATEGY_LAB_UNEXPECTED", message: "策略实验室操作失败" });
    expect(JSON.stringify(body)).not.toMatch(/SELECT|secret_table|super-secret|stack/i);
  });

  it.each(["outcome","profit","profitMicros","profitDecimal","result","selection","quote","actualQuoteSnapshotId","revision","supersedes","matchResultRevisionId","evidence","evidenceHash","calculatorVersion","legs"])("strictly rejects forged settlement field %s before service or audit", async field => {
    const response = await createSettlement(request("/api/admin/strategy-lab/settlements", "POST", { predictionId:id,quoteBasis:"actual",operationKey:"strict-settlement-0001",[field]:field==="revision"?1:"forged" }));
    expect(response.status).toBe(400);
    expect(mocks.service!.createSettlement).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each(["actual","theoretical"] as const)("accepts minimal legal %s settlement input", async quoteBasis => {
    mocks.service!.createSettlement.mockResolvedValue({ status:"created",replayed:false,value:{id} });
    const body={predictionId:id,quoteBasis,operationKey:`legal-${quoteBasis}-settlement`};
    const response=await createSettlement(request("/api/admin/strategy-lab/settlements","POST",body));
    expect(response.status).toBe(201); expect(mocks.service!.createSettlement).toHaveBeenCalledWith(body,expect.anything());
  });

  it("records successful and failed writes without full odds or settlement payloads", async () => {
    mocks.service!.executeStrategy.mockResolvedValue({ status: "created", replayed: false, value: { id, decisionStatus: "recommend", decisionPayload: { secretOdds: "0.90" } } });
    await executePrediction(request("/api/admin/strategy-lab/predictions", "POST", { operationKey: "prediction-operation-1" }));
    const entry = mocks.audit.mock.calls[0][0];
    expect(entry).toMatchObject({ action: "strategy-lab.prediction.execute.succeeded", objectId: id, newValue: { id, decisionStatus: "recommend" } });
    expect(JSON.stringify(entry)).not.toContain("secretOdds");
  });

  it.each(["false", "throw"] as const)("keeps committed business success pending when audit %s", async mode => {
    mocks.service!.createRun.mockResolvedValue({ status: "created", replayed: false, value: { id, status: "pending" } });
    mocks.service!.markCommandAudit.mockResolvedValue({ status: "audit_pending" });
    if (mode === "false") mocks.audit.mockResolvedValue(false);
    else mocks.audit.mockRejectedValue(new Error("audit unavailable secret"));
    const response = await createRun(request("/api/admin/strategy-lab/runs", "POST", {
      startDate: "20260717", endDate: "20260717", datasetCutoffAt: "2026-07-17T12:15:00.000Z", operationKey: `audit-${mode}-0001`,
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ result: { auditStatus: "pending", replayed: false } });
    expect(mocks.service!.markCommandAudit).toHaveBeenCalledWith("run.create", `audit-${mode}-0001`, false, "AUDIT_PERSISTENCE_FAILED");
  });

  it("keeps success pending when receipt audit marking fails", async () => {
    mocks.service!.createRun.mockResolvedValue({ status: "created", replayed: false, value: { id } });
    mocks.service!.markCommandAudit.mockRejectedValue(new Error("receipt update failed"));
    const response = await createRun(request("/api/admin/strategy-lab/runs", "POST", { operationKey: "mark-failed-0001" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ result: { auditStatus: "pending" } });
  });

  it("replays without duplicate route execution and retries pending audit", async () => {
    mocks.audit.mockResolvedValue(false);
    mocks.service!.markCommandAudit.mockResolvedValue({ status: "audit_pending" });
    mocks.service!.createRun.mockResolvedValue({ status: "existing", replayed: true, value: { id } });
    const response = await createRun(request("/api/admin/strategy-lab/runs", "POST", { operationKey: "route-replay-0001" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { replayed: true, auditStatus: "pending" } });
    expect(mocks.service!.createRun).toHaveBeenCalledOnce();
    expect(mocks.service!.markCommandAudit).toHaveBeenCalledOnce();
  });

  it("does not let failed-operation audit errors overwrite the business error", async () => {
    mocks.service!.transitionRun.mockRejectedValue(new StrategyLabServiceError("concurrency_conflict"));
    mocks.audit.mockRejectedValue(new Error("audit failed"));
    const response = await transitionRun(request(`/api/admin/strategy-lab/runs/${id}`, "PATCH", { operationKey: "failed-audit-0001" }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: "STRATEGY_LAB_CONCURRENCY_CONFLICT" });
  });

  it("serves all four GET-by-id routes and no list endpoint", async () => {
    mocks.service!.getRun.mockResolvedValue({ id, kind: "run" });
    mocks.service!.getSnapshotSet.mockResolvedValue({ id, kind: "snapshot" });
    mocks.service!.getPrediction.mockResolvedValue({ id, kind: "prediction" });
    mocks.service!.getSettlement.mockResolvedValue({ id, kind: "settlement" });
    const responses = await Promise.all([
      getRun(request(`/api/admin/strategy-lab/runs/${id}`), context), getSnapshot(request(`/api/admin/strategy-lab/snapshots/${id}`), context),
      getPrediction(request(`/api/admin/strategy-lab/predictions/${id}`), context), getSettlement(request(`/api/admin/strategy-lab/settlements/${id}`), context),
    ]);
    expect(await Promise.all(responses.map(response => response.json()))).toEqual([
      expect.objectContaining({ result: { id, kind: "run" } }), expect.objectContaining({ result: { id, kind: "snapshot" } }),
      expect.objectContaining({ result: { id, kind: "prediction" } }), expect.objectContaining({ result: { id, kind: "settlement" } }),
    ]);
  });
});
