import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), state: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth/admin-capabilities", () => ({ requireAdminCapability: mocks.auth }));
vi.mock("@/features/strategy-lab/server", () => ({ getStrategyLabServerState: mocks.state }));
vi.mock("@/lib/audit-log", () => ({ writeAuditLog: mocks.audit }));

import { GET } from "@/app/api/admin/strategy-lab/health/route";

const dependencies = (status: "ready" | "unavailable") => ({ status, missing: status === "ready" ? [] : ["snapshotProvider"] });
const request = (requestId = "health-request") => new Request("https://app.invalid/api/admin/strategy-lab/health", { headers: { "x-request-id": requestId } });
const readyCatalog = {
  tables_secure:true,policies_secure:true,policies_private:true,public_denied:true,default_public_denied:true,anonymous_denied:true,
  migration_read_limited:true,migration_public_denied:true,migration_anonymous_denied:true,
  schema_allowed:true,schema_limited:true,runtime_allowed:true,runtime_limited:true,updates_allowed:true,base_reads_allowed:true,
  canonical_execute_allowed:true,canonical_execute_private:true,migration_registered:true,writer_member:true,
  owner_isolated:true,identity_safe:true,roles_safe:true,
};
type QueryResult = { rows: readonly Record<string, unknown>[] };
type QueryExecutor = { query: ReturnType<typeof vi.fn<(sql: string) => Promise<QueryResult>>> };
const sqlClient = (options: { catalog?: Record<string, unknown>; failure?: unknown; queryFailure?: (sql: string) => unknown } = {}) => {
  const executor = {
    query: vi.fn(async (sql: string): Promise<QueryResult> => {
      const failure = options.queryFailure?.(sql);
      if (failure) throw failure;
      return { rows: sql.includes("WITH expected_tables") ? [options.catalog ?? readyCatalog] : [] };
    }),
  } satisfies QueryExecutor;
  return {
    query: vi.fn(),
    executor,
    transaction: vi.fn(async (callback: (transaction: QueryExecutor) => Promise<unknown>) => {
      if (options.failure) throw options.failure;
      return callback(executor);
    }),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ ok: true, principal: { actorId: "auditor", actorType: "admin", capabilities: ["admin:view"] } });
});

describe("strategy lab production health route", () => {
  it.each([
    [401, "ADMIN_AUTH_REQUIRED"],
    [403, "ADMIN_PERMISSION_DENIED"],
    [503, "ADMIN_AUTH_UNAVAILABLE"],
  ] as const)("requires admin:view and maps auth status %s to a minimal response", async (status, errorCode) => {
    mocks.auth.mockResolvedValue({ ok: false, status, error: "secret auth detail" });
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-request-id")).toBe("health-request");
    expect(await response.json()).toEqual({ success: false, status: "unavailable", errorCode, requestId: "health-request" });
    expect(mocks.state).not.toHaveBeenCalled();
  });

  it("returns 200 ready only after read-only database and complete dependency checks", async () => {
    const client = sqlClient();
    mocks.state.mockReturnValue({ configured: true, sqlClient: client, dependencies: dependencies("ready"), service: {} });
    const response = await GET(request("ready-id"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, status: "ready", requestId: "ready-id" });
    expect(client.transaction).toHaveBeenCalledOnce();
    expect(client.executor.query).toHaveBeenCalledTimes(17);
    expect(client.executor.query).toHaveBeenNthCalledWith(1, "SET TRANSACTION READ ONLY");
    expect(client.executor.query.mock.calls[1]?.[0]).toContain("WITH expected_tables");
    const catalogProbe = client.executor.query.mock.calls[1]?.[0] ?? "";
    expect(catalogProbe).toContain("WHEN r.relacl IS NULL THEN acldefault((CASE WHEN r.relkind='S' THEN 'S' ELSE 'r' END)::\"char\",r.relowner)");
    expect(catalogProbe).toContain("WHEN array_ndims(r.relacl)=1 AND cardinality(r.relacl)>0 THEN r.relacl");
    expect(catalogProbe).toContain("ELSE NULL::aclitem[]");
    expect(catalogProbe).toContain("CROSS JOIN LATERAL aclexplode(r.acl_items) acl");
    expect(catalogProbe).not.toContain("aclexplode(COALESCE(r.relacl");
    expect(catalogProbe).not.toContain("aclexplode('{}'::aclitem[])");
    expect(catalogProbe).toContain("grantee=0 AND privilege_type IN('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')");
    expect(catalogProbe).toContain("FROM pg_default_acl d");
    expect(catalogProbe).toContain("n.nspname='public' AND d.defaclobjtype='r'");
    expect(catalogProbe).toContain("WHEN array_ndims(d.defaclacl)=1 AND cardinality(d.defaclacl)>0 THEN d.defaclacl");
    expect(catalogProbe).toContain("CROSS JOIN LATERAL aclexplode(d.acl_items) acl");
    expect(catalogProbe).toContain(") AS default_public_denied");
    expect(catalogProbe).not.toContain("has_table_privilege('public'");
    expect(catalogProbe).toContain("r.rolname IN('anon','authenticated')");
    expect(catalogProbe).toContain("has_table_privilege(r.oid,e.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')");
    expect(catalogProbe).toContain("has_column_privilege(current_user,'public.schema_migrations','version','SELECT')");
    expect(catalogProbe).toContain("NOT has_table_privilege(current_user,'public.schema_migrations','SELECT')");
    expect(catalogProbe).toContain("has_function_privilege('strategy_lab_writer','public.strategy_lab_canonicalize_text(text)','EXECUTE')");
    expect(catalogProbe).toContain("WHEN p.proacl IS NULL THEN acldefault('f',p.proowner)");
    expect(catalogProbe).toContain("WHEN array_ndims(p.proacl)=1 AND cardinality(p.proacl)>0 THEN p.proacl");
    expect(catalogProbe).toContain("acl.grantee=0 AND acl.privilege_type='EXECUTE'");
    expect(client.executor.query.mock.calls.slice(2).every(([sql]) => sql.startsWith("SELECT * FROM strategy_lab_") && sql.endsWith(" LIMIT 0"))).toBe(true);
    expect(client.query).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    ["missing migration", { migration_registered: false }],
    ["migration ledger permission denied", null],
  ] as const)("returns a sanitized 503 when readiness has %s", async (_name, catalogOverride) => {
    const client = catalogOverride
      ? sqlClient({ catalog: { ...readyCatalog, ...catalogOverride } })
      : sqlClient({ queryFailure: sql => sql.includes("schema_migrations") ? new Error("permission denied for schema_migrations version 0021_strategy_lab_policy_and_artifacts") : null });
    mocks.state.mockReturnValue({ configured:true,sqlClient:client,dependencies:dependencies("ready"),service:{} });
    const response = await GET(request("readiness-unavailable"));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ success:false,status:"unavailable",errorCode:"STRATEGY_LAB_DATABASE_UNAVAILABLE",requestId:"readiness-unavailable" });
    expect(JSON.stringify(body)).not.toMatch(/schema_migrations|0021_strategy_lab_policy_and_artifacts|version|migration/i);
  });

  it.each(["NULL", "zero-dimensional empty", "one-dimensional empty", "owner-only", "normal non-PUBLIC"])(
    "accepts normalized %s relation ACL when no PUBLIC privilege is present",
    async aclShape => {
      const client = sqlClient({ catalog: { ...readyCatalog, public_denied: true } });
      mocks.state.mockReturnValue({ configured:true,sqlClient:client,dependencies:dependencies("ready"),service:{} });
      const response = await GET(request(`safe-${aclShape}`));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success:true,status:"ready" });
    },
  );

  it.each(["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"])(
    "fails closed when PUBLIC has explicit %s on any protected table",
    async privilege => {
      const client = sqlClient({ catalog: { ...readyCatalog, public_denied: false } });
      mocks.state.mockReturnValue({ configured:true,sqlClient:client,dependencies:dependencies("ready"),service:{} });
      const response = await GET(request("acl-denied"));
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toEqual({ success:false,status:"unavailable",errorCode:"STRATEGY_LAB_DATABASE_UNAVAILABLE",requestId:"acl-denied" });
      expect(client.executor.query.mock.calls[1]?.[0]).toContain(`'${privilege}'`);
      expect(JSON.stringify(body)).not.toMatch(/PUBLIC|strategy_lab_snapshot|SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|SQL/i);
    },
  );

  it("fails closed for a PUBLIC table privilege carrying grant option", async () => {
    const client = sqlClient({ catalog: { ...readyCatalog, public_denied: false } });
    mocks.state.mockReturnValue({ configured:true,sqlClient:client,dependencies:dependencies("ready"),service:{} });
    const response = await GET(request("grant-option-denied"));
    expect(response.status).toBe(503);
    expect(client.executor.query.mock.calls[1]?.[0]).toContain("acl.is_grantable");
    expect(await response.json()).toEqual({ success:false,status:"unavailable",errorCode:"STRATEGY_LAB_DATABASE_UNAVAILABLE",requestId:"grant-option-denied" });
  });

  it.each([
    ["PUBLIC default table privilege", false, 503],
    ["owner-only default table ACL", true, 200],
    ["empty default table ACL", true, 200],
  ] as const)("handles %s without confusing owner and PUBLIC", async (_name, defaultPublicDenied, status) => {
    const client = sqlClient({ catalog: { ...readyCatalog, default_public_denied: defaultPublicDenied } });
    mocks.state.mockReturnValue({ configured:true,sqlClient:client,dependencies:dependencies("ready"),service:{} });
    const response = await GET(request("default-acl"));
    expect(response.status).toBe(status);
  });

  it("passes again after every explicit PUBLIC table grant is revoked", async () => {
    const client = sqlClient({ catalog: { ...readyCatalog, public_denied: true } });
    mocks.state.mockReturnValue({ configured:true,sqlClient:client,dependencies:dependencies("ready"),service:{} });
    const response = await GET(request("public-revoked"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success:true,status:"ready",requestId:"public-revoked" });
  });

  it.each(["anon","authenticated"])("fails closed when existing %s role has a protected table privilege", async role => {
    const client = sqlClient({ catalog: { ...readyCatalog, anonymous_denied: false } });
    mocks.state.mockReturnValue({ configured:true,sqlClient:client,dependencies:dependencies("ready"),service:{} });
    const response = await GET(request("role-denied"));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ success:false,status:"unavailable",errorCode:"STRATEGY_LAB_DATABASE_UNAVAILABLE",requestId:"role-denied" });
    expect(client.executor.query.mock.calls[1]?.[0]).toContain(`'${role}'`);
    expect(JSON.stringify(body)).not.toMatch(/anon|authenticated|privilege|table|SQL/i);
  });

  it.each(Object.keys(readyCatalog))("fails closed with the same stable code when catalog check %s fails", async key => {
    const client = sqlClient({ catalog: { ...readyCatalog, [key]: false } });
    mocks.state.mockReturnValue({ configured: true, sqlClient: client, dependencies: dependencies("ready"), service: {} });
    const response = await GET(request("matrix-id"));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ success:false,status:"unavailable",errorCode:"STRATEGY_LAB_DATABASE_UNAVAILABLE",requestId:"matrix-id" });
    expect(JSON.stringify(body)).not.toMatch(/canonicalize|function|execute/i);
  });

  it("fails closed when any one of the fifteen LIMIT 0 probes is rejected", async () => {
    const client = sqlClient({ queryFailure: sql => sql.includes("strategy_lab_settlements") && sql.includes("LIMIT 0") ? new Error("private relation detail") : null });
    mocks.state.mockReturnValue({ configured:true,sqlClient:client,dependencies:dependencies("ready"),service:{} });
    const response = await GET(request("limit-id"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success:false,status:"unavailable",errorCode:"STRATEGY_LAB_DATABASE_UNAVAILABLE",requestId:"limit-id" });
  });

  it.each([
    ["missing configuration", { configured: false, sqlClient: null, dependencies: dependencies("unavailable"), service: null }, "STRATEGY_LAB_CONFIGURATION_MISSING"],
    ["invalid database configuration", { configured: true, sqlClient: null, dependencies: dependencies("unavailable"), service: null }, "STRATEGY_LAB_DATABASE_UNAVAILABLE"],
    ["incomplete providers", { configured: true, sqlClient: sqlClient(), dependencies: dependencies("unavailable"), service: null }, "STRATEGY_LAB_DEPENDENCIES_INCOMPLETE"],
    ["database failure", { configured: true, sqlClient: sqlClient({ failure: new Error("postgresql://user:password@host/db SELECT secret params PUBLIC ACL strategy_lab_secret") }), dependencies: dependencies("ready"), service: null }, "STRATEGY_LAB_DATABASE_UNAVAILABLE"],
  ])("returns sanitized 503 for %s", async (_name, state, errorCode) => {
    mocks.state.mockReturnValue(state);
    const response = await GET(request("unavailable-id"));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ success: false, status: "unavailable", errorCode, requestId: "unavailable-id" });
    expect(JSON.stringify(body)).not.toMatch(/password|postgresql:|SELECT|params|host|schema|migration|provider|environment|PUBLIC|ACL|strategy_lab_secret/i);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
