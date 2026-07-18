import { createHash, scryptSync } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.FAKE_ADMIN_DB_PORT || 54329);
const VIRTUAL_TOKENS = {
  auditor: "crow5-e2e-virtual-auditor-session-token",
  operator: "crow5-e2e-virtual-operator-session-token",
  super: "crow5-e2e-virtual-super-session-token",
  expired: "crow5-e2e-virtual-expired-session-token",
  revoked: "crow5-e2e-virtual-revoked-session-token",
};
const hash = value => createHash("sha256").update(value).digest("hex");
const now = "2026-07-14T00:00:00.000Z";
const smokeUser = {
  id: "00000000-0000-0000-0000-000000000001",
  username: "smoke.admin",
  display_name: "Smoke Admin",
  role: "super_admin",
  is_active: true,
  password_hash: (() => {
    const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const derived = scryptSync("SmokePassword123!", salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
    return `scrypt$v=1$N=16384,r=8,p=1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
  })(),
  password_changed_at: now,
  last_login_at: null,
  created_at: now,
  updated_at: now,
};
const sessions = new Map(Object.entries(VIRTUAL_TOKENS).map(([kind, token], index) => {
  const role = kind === "super" || kind === "expired" || kind === "revoked" ? "super_admin" : kind;
  const username = `virtual.${kind}`;
  return [hash(token), {
    admin_user_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    role,
    username,
    expires_at: kind === "expired" ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
    revoked_at: kind === "revoked" ? "2098-01-01T00:00:00.000Z" : null,
    admin_users: { id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, is_active: true, role, username, display_name: username, password_changed_at: now, status: "active" },
  }];
}));

const smokeSession = {
  admin_user_id: smokeUser.id,
  role: smokeUser.role,
  username: smokeUser.username,
  expires_at: "2099-01-01T00:00:00.000Z",
  revoked_at: null,
  admin_users: { id: smokeUser.id, is_active: true, role: smokeUser.role, username: smokeUser.username, display_name: smokeUser.display_name, password_changed_at: smokeUser.password_changed_at, status: "active" },
};
sessions.set(hash("smoke-persistent-session"), smokeSession);

const state = { requests: [], mutations: 0, auditMutations: 0, businessMutations: 0 };
const json = (response, status, body, headers = {}) => {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(JSON.stringify(body));
};
const requestBody = request => new Promise(resolve => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => resolve(body));
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/health") return json(response, 200, { ready: true });
  if (url.pathname === "/__state") return json(response, 200, state);
  if (url.pathname === "/__reset" && request.method === "POST") {
    state.requests.length = 0; state.mutations = 0; state.auditMutations = 0; state.businessMutations = 0;
    return json(response, 200, { reset: true });
  }

  const rpcMatch = url.pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/);
  if (rpcMatch) {
    const body = await requestBody(request);
    const rpc = rpcMatch[1];
    state.requests.push({ method: request.method, table: `rpc:${rpc}`, query: url.search, body });
    state.mutations += 1; state.businessMutations += 1;
    if (rpc === "reserve_admin_login_attempt_v2") return json(response, 200, { allowed: true, retry_after_seconds: 0 });
    if (rpc === "settle_admin_login_attempt_v2") return json(response, 200, { settled: true, audit_failure: false });
    return json(response, 200, null);
  }
  const tableMatch = url.pathname.match(/^\/rest\/v1\/([^/]+)$/);
  if (!tableMatch) return json(response, 404, { message: `Unhandled fake database request: ${request.method} ${url.pathname}` });
  const table = tableMatch[1];
  const body = await requestBody(request);
  state.requests.push({ method: request.method, table, query: url.search, body });
  if (!["GET", "HEAD"].includes(request.method || "")) {
    state.mutations += 1;
    if (table === "audit_logs") state.auditMutations += 1;
    else state.businessMutations += 1;
  }

  if (request.method === "GET" && table === "admin_sessions") {
    const filter = url.searchParams.get("token_hash") || "";
    const record = sessions.get(filter.replace(/^eq\./, ""));
    return json(response, 200, record || null);
  }
  if (request.method === "GET" && table === "admin_users") {
    const username = (url.searchParams.get("username") || "").replace(/^eq\./, "");
    const id = (url.searchParams.get("id") || "").replace(/^eq\./, "");
    const record = username === smokeUser.username || id === smokeUser.id ? smokeUser : null;
    return json(response, 200, record || (username || id ? null : [smokeUser]));
  }
  if (request.method === "HEAD") {
    const count = table === "admin_users" ? 1 : 0;
    return json(response, 200, null, { "Content-Range": count ? "0-0/1" : "*/0" });
  }
  if (request.method === "GET") return json(response, 200, []);
  if (request.method === "POST" && table === "admin_sessions") {
    const payload = JSON.parse(body || "{}");
    if (payload.token_hash) sessions.set(payload.token_hash, { ...payload, revoked_at: null, admin_users: smokeSession.admin_users });
  }
  if (request.method === "PATCH" && table === "admin_users" && body) Object.assign(smokeUser, JSON.parse(body));
  if (request.method === "PATCH" && table === "admin_sessions") {
    const tokenHash = (url.searchParams.get("token_hash") || "").replace(/^eq\./, "");
    const session = sessions.get(tokenHash);
    if (session) Object.assign(session, JSON.parse(body || "{}"));
  }
  return json(response, request.method === "PATCH" ? 200 : 201, {});
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
