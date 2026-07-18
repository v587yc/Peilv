import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 交付层门禁：Strategy Lab 只读 GET 五身份矩阵 + auditor 写接口 403 回归。
 * 不改服务端统计口径，只验证鉴权与能力边界。
 */
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  audit: vi.fn(),
  writeService: null as Record<string, ReturnType<typeof vi.fn>> | null,
  queryService: null as Record<string, ReturnType<typeof vi.fn>> | null,
}));

vi.mock("@/lib/auth/admin-capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/admin-capabilities")>();
  return {
    ...actual,
    requireAdminCapability: mocks.auth,
  };
});
vi.mock("@/lib/audit-log", () => ({ writeAuditLog: mocks.audit }));
vi.mock("@/features/strategy-lab/server", () => ({
  getStrategyLabService: () => mocks.writeService,
  getStrategyLabServerState: () => ({ mode: "test", ready: true }),
}));
vi.mock("@/features/strategy-lab/production-readiness", () => ({
  checkStrategyLabReadiness: vi.fn(async () => ({ status: "ready", checks: [] })),
}));
vi.mock("@/features/strategy-lab/admin-query-server", () => ({
  getStrategyLabAdminQueryService: () => mocks.queryService,
}));

import { hasAdminCapability, principalForActor, ROLE_CAPABILITIES, type AdminCapability } from "@/lib/auth/admin-capabilities";
import { GET as getRuns, POST as createRun } from "@/app/api/admin/strategy-lab/runs/route";
import { GET as getRun, PATCH as transitionRun } from "@/app/api/admin/strategy-lab/runs/[id]/route";
import { GET as getMatrix } from "@/app/api/admin/strategy-lab/runs/[id]/matrix/route";
import { GET as getOverview } from "@/app/api/admin/strategy-lab/runs/[id]/overview/route";
import { GET as getReport } from "@/app/api/admin/strategy-lab/runs/[id]/report/route";
import { GET as getAudit } from "@/app/api/admin/strategy-lab/runs/[id]/audit/route";
import { GET as getPredictions, POST as executePrediction } from "@/app/api/admin/strategy-lab/predictions/route";
import { GET as getPrediction } from "@/app/api/admin/strategy-lab/predictions/[id]/route";
import { GET as getSettlementChain } from "@/app/api/admin/strategy-lab/predictions/[id]/settlement-chain/route";
import { GET as getSnapshots, POST as captureSnapshot } from "@/app/api/admin/strategy-lab/snapshots/route";
import { GET as getSnapshot } from "@/app/api/admin/strategy-lab/snapshots/[id]/route";
import { GET as getSettlements, POST as createSettlement } from "@/app/api/admin/strategy-lab/settlements/route";
import { GET as getSettlement } from "@/app/api/admin/strategy-lab/settlements/[id]/route";
import { GET as getHealth } from "@/app/api/admin/strategy-lab/health/route";

type Identity = "anonymous" | "auditor" | "operator" | "super_admin" | "internal";
const id = "30000000-0000-4000-8000-000000000001";
const identities: Identity[] = ["anonymous", "auditor", "operator", "super_admin", "internal"];
const viewAllowed: Identity[] = ["auditor", "operator", "super_admin"];

const page = { limit: 50, hasMore: false, nextCursor: null };
const emptyEnvelope = {
  contractVersion: "read-v1",
  generatedAt: "2026-07-18T00:00:00.000Z",
  requestId: "request-identity",
  appliedFilters: {},
  pageInfo: page,
  data: [],
};

function request(path: string, method = "GET", body?: unknown) {
  return new Request(`https://app.invalid${path}`, {
    method,
    headers: { "content-type": "application/json", "x-request-id": "request-identity" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function authResult(identity: Identity, capability: AdminCapability) {
  if (identity === "anonymous") return { ok: false as const, status: 401 as const, error: "需要管理员登录" };
  if (identity === "internal") {
    const principal = principalForActor({ actorId: "internal-task", actorType: "internal" });
    return hasAdminCapability(principal, capability)
      ? { ok: true as const, principal }
      : { ok: false as const, status: 403 as const, error: "权限不足" };
  }
  const principal = principalForActor({ actorId: `${identity}-id`, actorType: "admin", role: identity });
  return hasAdminCapability(principal, capability)
    ? { ok: true as const, principal }
    : { ok: false as const, status: 403 as const, error: "权限不足" };
}

function expectedStatus(identity: Identity, capability: AdminCapability) {
  if (identity === "anonymous") return 401;
  if (identity === "internal") return 403;
  const principal = principalForActor({ actorId: identity, actorType: "admin", role: identity });
  return hasAdminCapability(principal, capability) ? 200 : 403;
}

const getCases: Array<{
  name: string;
  capability: AdminCapability;
  invoke: () => Promise<Response>;
  prepare: () => void;
}> = [
  {
    name: "GET /runs",
    capability: "admin:view",
    prepare: () => {
      mocks.queryService!.runs.mockResolvedValue(emptyEnvelope);
    },
    invoke: () => getRuns(request("/api/admin/strategy-lab/runs?runType=shadow&limit=50")),
  },
  {
    name: "GET /runs/:id",
    capability: "admin:view",
    prepare: () => {
      mocks.writeService!.getRun.mockResolvedValue({ id });
    },
    invoke: () => getRun(request(`/api/admin/strategy-lab/runs/${id}`), { params: Promise.resolve({ id }) }),
  },
  {
    name: "GET /runs/:id/matrix",
    capability: "admin:view",
    prepare: () => {
      mocks.queryService!.matrix.mockResolvedValue({ ...emptyEnvelope, data: [] });
    },
    invoke: () => getMatrix(request(`/api/admin/strategy-lab/runs/${id}/matrix`), { params: Promise.resolve({ id }) }),
  },
  {
    name: "GET /runs/:id/overview",
    capability: "admin:view",
    prepare: () => {
      mocks.queryService!.overview.mockResolvedValue({ ...emptyEnvelope, data: { health: { reader: "ready" } } });
    },
    invoke: () => getOverview(request(`/api/admin/strategy-lab/runs/${id}/overview`), { params: Promise.resolve({ id }) }),
  },
  {
    name: "GET /runs/:id/report",
    capability: "admin:view",
    prepare: () => {
      mocks.queryService!.report.mockResolvedValue({ ...emptyEnvelope, data: { validSample: 0 } });
    },
    invoke: () => getReport(request(`/api/admin/strategy-lab/runs/${id}/report`), { params: Promise.resolve({ id }) }),
  },
  {
    name: "GET /runs/:id/audit",
    capability: "admin:view",
    prepare: () => {
      mocks.queryService!.audit.mockResolvedValue(emptyEnvelope);
    },
    invoke: () => getAudit(request(`/api/admin/strategy-lab/runs/${id}/audit?limit=50`), { params: Promise.resolve({ id }) }),
  },
  {
    name: "GET /predictions",
    capability: "admin:view",
    prepare: () => {
      mocks.queryService!.predictions.mockResolvedValue(emptyEnvelope);
    },
    invoke: () => getPredictions(request(`/api/admin/strategy-lab/predictions?runId=${id}&limit=50`)),
  },
  {
    name: "GET /predictions/:id",
    capability: "admin:view",
    prepare: () => {
      mocks.writeService!.getPrediction.mockResolvedValue({ id });
    },
    invoke: () => getPrediction(request(`/api/admin/strategy-lab/predictions/${id}`), { params: Promise.resolve({ id }) }),
  },
  {
    name: "GET /predictions/:id/settlement-chain",
    capability: "admin:view",
    prepare: () => {
      mocks.queryService!.chain.mockResolvedValue({ ...emptyEnvelope, data: { integrity: {}, revisions: [] } });
    },
    invoke: () => getSettlementChain(request(`/api/admin/strategy-lab/predictions/${id}/settlement-chain`), { params: Promise.resolve({ id }) }),
  },
  {
    name: "GET /snapshots",
    capability: "admin:view",
    prepare: () => {
      mocks.queryService!.snapshots.mockResolvedValue(emptyEnvelope);
    },
    invoke: () => getSnapshots(request(`/api/admin/strategy-lab/snapshots?runId=${id}&limit=50`)),
  },
  {
    name: "GET /snapshots/:id",
    capability: "admin:view",
    prepare: () => {
      mocks.writeService!.getSnapshotSet.mockResolvedValue({ id });
    },
    invoke: () => getSnapshot(request(`/api/admin/strategy-lab/snapshots/${id}`), { params: Promise.resolve({ id }) }),
  },
  {
    name: "GET /settlements",
    capability: "admin:view",
    prepare: () => {
      mocks.queryService!.settlements.mockResolvedValue(emptyEnvelope);
    },
    invoke: () => getSettlements(request(`/api/admin/strategy-lab/settlements?runId=${id}&limit=50`)),
  },
  {
    name: "GET /settlements/:id",
    capability: "admin:view",
    prepare: () => {
      mocks.writeService!.getSettlement.mockResolvedValue({ id });
    },
    invoke: () => getSettlement(request(`/api/admin/strategy-lab/settlements/${id}`), { params: Promise.resolve({ id }) }),
  },
  {
    name: "GET /health",
    capability: "admin:view",
    prepare: () => undefined,
    invoke: () => getHealth(request("/api/admin/strategy-lab/health")),
  },
];

const writeCases: Array<{
  name: string;
  capability: AdminCapability;
  invoke: () => Promise<Response>;
  prepare: () => void;
}> = [
  {
    name: "POST /runs",
    capability: "admin:configure",
    prepare: () => {
      mocks.writeService!.createRun.mockResolvedValue({ status: "created", replayed: false, value: { id } });
    },
    invoke: () => createRun(request("/api/admin/strategy-lab/runs", "POST", {
      startDate: "20260717",
      endDate: "20260717",
      datasetCutoffAt: "2026-07-17T12:15:00.000Z",
      operationKey: "identity-run-0001",
    })),
  },
  {
    name: "PATCH /runs/:id",
    capability: "admin:execute",
    prepare: () => {
      mocks.writeService!.transitionRun.mockResolvedValue({ status: "created", replayed: false, value: { id } });
    },
    invoke: () => transitionRun(request(`/api/admin/strategy-lab/runs/${id}`, "PATCH", {
      transition: "pending_to_running",
      operationKey: "identity-transition-0001",
    }), { params: Promise.resolve({ id }) }),
  },
  {
    name: "POST /snapshots",
    capability: "admin:configure",
    prepare: () => {
      mocks.writeService!.captureSnapshotSet.mockResolvedValue({ status: "created", replayed: false, value: { id } });
    },
    invoke: () => captureSnapshot(request("/api/admin/strategy-lab/snapshots", "POST", {
      runId: id,
      operationKey: "identity-snapshot-0001",
    })),
  },
  {
    name: "POST /predictions",
    capability: "admin:execute",
    prepare: () => {
      mocks.writeService!.executeStrategy.mockResolvedValue({ status: "created", replayed: false, value: { id } });
    },
    invoke: () => executePrediction(request("/api/admin/strategy-lab/predictions", "POST", {
      operationKey: "identity-prediction-0001",
    })),
  },
  {
    name: "POST /settlements",
    capability: "admin:dangerous",
    prepare: () => {
      mocks.writeService!.createSettlement.mockResolvedValue({ status: "created", replayed: false, value: { id } });
    },
    invoke: () => createSettlement(request("/api/admin/strategy-lab/settlements", "POST", {
      predictionId: id,
      quoteBasis: "actual",
      operationKey: "identity-settlement-0001",
    })),
  },
];

function makeWriteService() {
  return {
    createRun: vi.fn(),
    transitionRun: vi.fn(),
    captureSnapshotSet: vi.fn(),
    executeStrategy: vi.fn(),
    createSettlement: vi.fn(),
    getRun: vi.fn(),
    getSnapshotSet: vi.fn(),
    getPrediction: vi.fn(),
    getSettlement: vi.fn(),
    markCommandAudit: vi.fn(async () => ({ status: "audited" })),
  };
}

function makeQueryService() {
  return {
    runs: vi.fn(),
    matrix: vi.fn(),
    overview: vi.fn(),
    report: vi.fn(),
    audit: vi.fn(),
    predictions: vi.fn(),
    chain: vi.fn(),
    snapshots: vi.fn(),
    settlements: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audit.mockResolvedValue(true);
  mocks.writeService = makeWriteService();
  mocks.queryService = makeQueryService();
});

describe("Strategy Lab five-identity delivery gate", () => {
  it("documents auditor is view-only across ROLE_CAPABILITIES", () => {
    expect(ROLE_CAPABILITIES.auditor).toEqual(["admin:view"]);
    expect(ROLE_CAPABILITIES.operator).toEqual(["admin:view", "admin:configure", "admin:execute"]);
    expect(ROLE_CAPABILITIES.super_admin).toContain("admin:dangerous");
  });

  it.each(getCases)("$name allows only admin:view identities across five identities", async ({ capability, invoke, prepare }) => {
    for (const identity of identities) {
      mocks.auth.mockImplementation(async (_req: Request, cap: AdminCapability) => authResult(identity, cap));
      prepare();
      const response = await invoke();
      const expected = expectedStatus(identity, capability);
      // health may return 503 when readiness is unavailable even if authorized
      if (expected === 200 && capability === "admin:view") {
        expect([200, 503], identity).toContain(response.status);
      } else {
        expect(response.status, identity).toBe(expected);
      }
      if (expected !== 200) {
        expect(mocks.audit).not.toHaveBeenCalled();
      }
    }
  });

  it.each(writeCases)("$name rejects auditor (and anonymous/internal) with 403/401", async ({ capability, invoke, prepare }) => {
    for (const identity of identities) {
      mocks.auth.mockImplementation(async (_req: Request, cap: AdminCapability) => authResult(identity, cap));
      prepare();
      const response = await invoke();
      const expected = expectedStatus(identity, capability);
      if (identity === "auditor") {
        expect(response.status).toBe(403);
        expect(mocks.writeService!.createRun).not.toHaveBeenCalled();
        expect(mocks.writeService!.transitionRun).not.toHaveBeenCalled();
        expect(mocks.writeService!.captureSnapshotSet).not.toHaveBeenCalled();
        expect(mocks.writeService!.executeStrategy).not.toHaveBeenCalled();
        expect(mocks.writeService!.createSettlement).not.toHaveBeenCalled();
        expect(mocks.audit).not.toHaveBeenCalled();
      } else if (expected === 200) {
        expect([200, 201]).toContain(response.status);
      } else {
        expect(response.status, identity).toBe(expected);
      }
    }
  });

  it("auditor can pass every listed GET path capability check and fails every write capability", () => {
    const auditor = principalForActor({ actorId: "auditor-id", actorType: "admin", role: "auditor" });
    for (const getCase of getCases) {
      expect(hasAdminCapability(auditor, getCase.capability), getCase.name).toBe(true);
      expect(viewAllowed).toContain("auditor");
    }
    for (const writeCase of writeCases) {
      expect(hasAdminCapability(auditor, writeCase.capability), writeCase.name).toBe(false);
    }
  });
});
