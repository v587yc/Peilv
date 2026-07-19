import { createHash } from "node:crypto";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL;
if (!baseURL) throw new Error("PLAYWRIGHT_BASE_URL must be injected by playwright.config.ts");
const sessionToken = "smoke-persistent-session";
const fixtureCredentials = { username: "smoke.admin", password: "SmokePassword123!" };
const capabilities = ["admin:view", "admin:configure", "admin:execute", "admin:dangerous", "admin:manage"];
const user = { id: "00000000-0000-0000-0000-000000000001", username: fixtureCredentials.username, displayName: "Smoke Admin", role: "super_admin" };
const browserIssues = new WeakMap<Page, string[]>();
const browserProductionRequests = new WeakMap<Page, string[]>();

function sessionPayload(authenticated: boolean) {
  return authenticated
    ? { initialized: true, authenticated: true, user, capabilities }
    : { initialized: true, authenticated: false, user: null, capabilities: [] };
}

async function installSessionMock(page: Page, initiallyAuthenticated = false) {
  let authenticated = initiallyAuthenticated;
  const calls: string[] = [];
  await page.route("**/api/auth/session", async route => {
    const method = route.request().method();
    calls.push(method);
    if (method === "POST") {
      expect(route.request().postDataJSON()).toEqual(fixtureCredentials);
      authenticated = true;
      await page.context().addCookies([{ name: "admin_session", value: sessionToken, url: baseURL, httpOnly: true, sameSite: "Strict" }]);
      await route.fulfill({ status: 200, json: sessionPayload(true), headers: { "Set-Cookie": `admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict` } });
      return;
    }
    if (method === "DELETE") {
      authenticated = false;
      await page.context().clearCookies({ name: "admin_session" });
      await route.fulfill({ status: 200, json: { success: true }, headers: { "Set-Cookie": "admin_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict" } });
      return;
    }
    await route.fulfill({ status: 200, json: sessionPayload(authenticated) });
  });
  return calls;
}

async function establishServerSession(context: BrowserContext) {
  await context.addCookies([{ name: "admin_session", value: sessionToken, url: baseURL, httpOnly: true, sameSite: "Strict" }]);
}

async function establishRequestSession(request: APIRequestContext) {
  const response = await request.get("/api/auth/session", { headers: { Cookie: `admin_session=${sessionToken}` } });
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ authenticated: true, user: { username: fixtureCredentials.username, role: "super_admin" } });
}

async function loginAdmin(page: Page, next = "/admin") {
  const calls = await installSessionMock(page);
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("管理员账号").fill(fixtureCredentials.username);
  await page.getByLabel("密码", { exact: true }).fill(fixtureCredentials.password);
  await page.getByRole("button", { name: "登录管理控制台" }).click();
  await expect(page).toHaveURL(new RegExp(`${next.replace(/[?]/g, "\\?")}$`));
  expect(calls).toContain("GET");
  expect(calls).toContain("POST");
  return calls;
}

test.beforeAll(() => {
  expect(createHash("sha256").update(sessionToken).digest("hex")).toHaveLength(64);
});

test.beforeEach(({ page }) => {
  const issues: string[] = [];
  browserIssues.set(page, issues);
  browserProductionRequests.set(page, []);
  page.on("console", message => { if (message.type() === "error") issues.push(`console: ${message.text()}`); });
  page.on("pageerror", error => issues.push(`pageerror: ${error.message}`));
  page.on("request", request => {
    const host = new URL(request.url()).hostname;
    if (host !== "localhost" && !host.startsWith("127.")) browserProductionRequests.get(page)?.push(`${request.method()} ${request.url()}`);
  });
  page.on("requestfailed", request => {
    const error = request.failure()?.errorText || "failed";
    if (error === "net::ERR_ABORTED" && request.url().includes("_rsc=")) return;
    issues.push(`network: ${request.method()} ${request.url()} ${error}`);
  });
});

test.afterEach(({ page }) => {
  expect(browserIssues.get(page) || []).toEqual([]);
  expect(browserProductionRequests.get(page) || []).toEqual([]);
});

test("旧部署入口收敛到当前账号密码登录", async ({ page, request }) => {
  await installSessionMock(page);
  await page.goto("/deployments");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fdeployments$/);
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await expect(page.getByLabel("管理员账号")).toBeVisible();
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "登录管理控制台" })).toBeDisabled();
  expect((await request.get("/api/deployments/overview")).status()).toBe(410);
  const response = await request.get("/api/admin/deployments/overview");
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ success: false, error: "需要管理员登录" });
});

test("登录页按初始化状态展示当前账号密码表单", async ({ page }) => {
  const calls = await installSessionMock(page);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await expect(page.getByLabel("管理员账号")).toBeVisible();
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "登录管理控制台" })).toBeDisabled();
  expect(calls).toEqual(["GET"]);
});

test("未认证请求无法访问敏感 API", async ({ request }) => {
  const response = await request.post("/api/settings", { data: { llm_model: "should-not-be-written" }, headers: { Origin: baseURL } });
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ success: false, error: "需要管理员登录" });
});

test("账号密码登录与退出覆盖 session GET POST DELETE", async ({ page }) => {
  await page.route("**/api/admin/audit**", route => route.fulfill({ json: { success: true, data: [], total: 0, page: 1, pageSize: 50 } }));
  await page.goto("/admin/audit?actorId=smoke.admin");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Faudit%3FactorId%3Dsmoke.admin$/);
  const calls = await loginAdmin(page, "/admin/audit?actorId=smoke.admin");
  await expect(page.getByRole("heading", { name: "审计日志" })).toBeVisible();
  await expect(page.getByRole("link", { name: "业务设置" })).toHaveAttribute("href", "/admin/settings");
  await expect(page.getByRole("link", { name: "数据源" })).toHaveAttribute("href", "/admin/sources");
  await expect(page.getByRole("link", { name: "版本更新" })).toHaveAttribute("href", "/admin/deployments");
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(calls).toContain("DELETE");
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin$/);
});

test("后台会话失效后自动返回登录页并保留原地址", async ({ page }) => {
  await loginAdmin(page);
  await page.route("**/api/admin/settings", route => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ success: false, error: "未登录" }),
  }));
  await page.goto("/admin/settings");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fsettings$/);
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  const issues = browserIssues.get(page) || [];
  browserIssues.set(page, issues.filter(issue => !issue.includes("401 (Unauthorized)")));
});

test("管理 API 保持未认证 401 与已认证跨站 403", async ({ request }) => {
  const unauthenticated = await request.get("/api/admin/audit");
  expect(unauthenticated.status()).toBe(401);
  await expect(unauthenticated.json()).resolves.toMatchObject({ success: false, error: "需要管理员登录" });
  await establishRequestSession(request);
  const crossSite = await request.post("/api/admin/audit", { data: {}, headers: { Cookie: `admin_session=${sessionToken}`, Origin: "https://evil.example" } });
  expect(crossSite.status()).toBe(403);
  await expect(crossSite.json()).resolves.toMatchObject({ success: false, error: "跨站请求校验失败" });
});

test("一键更新只发送预检且部署请求保持零副作用", async ({ page, context }) => {
  await establishServerSession(context);
  await installSessionMock(page, true);
  await page.route("**/api/admin/deployments/overview", route => route.fulfill({ json: { success: true, overview: {
    repository: "owner/repo", currentRelease: "r100-a1-aaaaaaaaaaaa", previousRelease: null,
    candidates: [{ runId: 101, runAttempt: 2, releaseId: "r101-a2-bbbbbbbbbbbb", commitSha: "b".repeat(40), commitTitle: "release", author: "ci", status: "ready", artifactId: 501, artifactSize: 1, artifactExpiresAt: "2099-01-01T00:00:00Z", createdAt: "2026-07-14T00:00:00Z", url: "https://example.test/run" }],
    operations: [], fetchedAt: "2026-07-14T00:00:00Z",
  } } }));
  let preflightBody: Record<string, unknown> | null = null;
  let deployRequests = 0;
  await page.route("**/api/admin/deployments/preflight", async route => {
    preflightBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, json: { success: false, error: "可控验证：未触发生产预检" } });
  });
  await page.route("**/api/admin/deployments/deploy", async route => {
    deployRequests += 1;
    await route.abort("blockedbyclient");
  });
  await page.goto("/admin/deployments");
  await page.getByRole("button", { name: /立即更新到 r101-a2-bbbbbbbbbbbb/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认更新" }).click();
  await expect.poll(() => preflightBody).not.toBeNull();
  expect(preflightBody).toMatchObject({ runId: 101, runAttempt: 2, artifactId: 501, releaseId: "r101-a2-bbbbbbbbbbbb" });
  expect(deployRequests).toBe(0);
});

test("首页提供全部核心页面导航", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "实时赔率监控系统" })).toBeVisible();
  await expect(page.getByRole("link", { name: /赔率监控/ })).toHaveAttribute("href", "/odds");
  await expect(page.getByRole("link", { name: /AI 配置/ })).toHaveAttribute("href", "/test-ai");
  await expect(page.getByRole("link", { name: /学习系统 \/ 回测/ })).toHaveAttribute("href", "/backtest");
  await expect(page.getByRole("link", { name: /记忆系统/ })).toHaveAttribute("href", "/memory");
});

test("已认证 SSRF 请求到达目标 API 后仍被策略拒绝", async ({ request }) => {
  await establishRequestSession(request);
  const response = await request.post("/api/fetch-url", { data: { url: "https://127.0.0.1/private" }, headers: { Cookie: `admin_session=${sessionToken}`, Origin: baseURL } });
  expect(response.status()).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ error: "URL 不允许使用 IP 字面量" });
});

test("super-admin 总览展示六分区并允许 settings 单独降级", async ({ page, context }) => {
  await establishServerSession(context);
  await installSessionMock(page, true);
  await page.route("**/api/admin/overview", route => route.fulfill({ json: { success: true, status: "degraded", sections: { settings: { status: "degraded", observedAt: "2026-07-14", error: "设置暂时不可用" }, sources: { status: "ok", observedAt: "2026-07-14", data: {} }, automation: { status: "ok", observedAt: "2026-07-14", data: {} }, strategy: { status: "ok", observedAt: "2026-07-14", data: null }, backtests: { status: "ok", observedAt: "2026-07-14", data: {} }, audit: { status: "ok", observedAt: "2026-07-14", data: {} } } } }));
  await page.goto("/admin");
  for (const section of ["运行配置", "数据源", "自动化", "分析策略", "回测任务", "审计链路"]) await expect(page.getByRole("link", { name: new RegExp(`^${section}`) }).first()).toBeVisible();
  await expect(page.getByText("设置暂时不可用").first()).toBeVisible();
});

test("super-admin 治理操作发送统一命令信封", async ({ page, context }) => {
  await establishServerSession(context);
  await installSessionMock(page, true);
  const commands: Array<Record<string, unknown>> = [];
  await page.route("**/api/admin/settings", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { success: true, settings: [{ id: "setting.llm_model", label: "LLM 模型", source: "default", sensitive: false, configured: true, effectiveAfter: "cache-refresh", value: "gpt-4o-mini" }] } });
    commands.push(route.request().postDataJSON()); return route.fulfill({ json: { success: true, changedKeys: ["llm_model"] } });
  });
  await page.goto("/admin/settings");
  await page.getByRole("textbox", { name: "输入配置值" }).fill("test-model");
  await page.getByRole("button", { name: "保存更改" }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ targetId: "setting.batch", reason: "管理员后台操作", payload: { replacements: { "setting.llm_model": "test-model" } } });
  expect(String(commands[0].idempotencyKey)).toMatch(/^setting\.batch:/);

  commands.length = 0;
  await page.route("**/api/admin/strategies", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { success: true, items: [{ version: "strategy-draft", name: "Draft", status: "draft", model_version: "analysis-v1" }] } });
    commands.push(route.request().postDataJSON()); return route.fulfill({ json: { success: true, item: { version: "strategy-draft", status: "published" } } });
  });
  await page.goto("/admin/strategies");
  await page.getByRole("button", { name: "发布" }).click();
  expect(commands).toHaveLength(0);
  const strategyPatch = page.waitForResponse(response =>
    response.url().includes("/api/admin/strategies") && response.request().method() === "PATCH",
  );
  await Promise.all([
    strategyPatch,
    page.getByRole("alertdialog").getByRole("button", { name: "确认发布" }).click(),
  ]);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ targetId: "strategy.publish", confirmation: "strategy.publish", payload: { version: "strategy-draft" } });

  commands.length = 0;
  await page.route("**/api/admin/backtests", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { success: true, limits: { maxDateRangeDays: 31, maxMatches: 500 }, items: [{ id: "job-existing", status: "error", start_date: "20260101", end_date: "20260102", processed_dates: 1, total_dates: 2, accuracy: "50%" }] } });
    commands.push(route.request().postDataJSON()); return route.fulfill({ json: { success: true, jobId: "job-existing", resumed: true } });
  });
  await page.goto("/admin/backtests");
  await page.getByRole("button", { name: "继续" }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ targetId: "backtest.resume", payload: { jobId: "job-existing" } });
});
