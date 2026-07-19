import { expect, test } from "@playwright/test";
import {
  APP_ORIGIN,
  VIRTUAL_INTERNAL_SECRET,
  expectCleanRuntime,
  fakeDbState,
  observeRuntime,
  resetFakeDb,
  useSession as setSession,
} from "./fixtures/admin-local-isolation.fixture";

const pageMatrix = [
  { role: "auditor" as const, allowed: ["/admin", "/admin/audit", "/admin/sources"], forbidden: ["/admin/settings", "/admin/automation", "/admin/strategies", "/admin/backtests", "/admin/roles", "/admin/admins", "/admin/deployments"] },
  { role: "operator" as const, allowed: ["/admin", "/admin/settings", "/admin/automation", "/admin/backtests"], forbidden: ["/admin/roles", "/admin/admins", "/admin/deployments"] },
  { role: "super" as const, allowed: ["/admin", "/admin/settings", "/admin/roles", "/admin/admins", "/admin/deployments"], forbidden: [] },
];

for (const row of pageMatrix) {
  test(`${row.role} page capability matrix`, async ({ page, context }) => {
    await setSession(context, row.role);
    for (const path of row.allowed) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      await expect(page.getByRole("heading", { name: "没有此页面的访问权限" })).toHaveCount(0);
    }
    for (const path of row.forbidden) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      await expect(page.getByRole("heading", { name: "没有此页面的访问权限" })).toBeVisible();
    }
  });
}

test("anonymous, expired and revoked sessions fail closed on pages and APIs", async ({ page, context }) => {
  for (const kind of ["anonymous", "expired", "revoked"] as const) {
    await context.clearCookies();
    if (kind !== "anonymous") await setSession(context, kind);
    const pageResponse = await page.goto("/admin/settings");
    expect(pageResponse?.status()).toBe(200);
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fsettings$/);
    const apiResponse = await page.request.get("/api/admin/settings");
    expect(apiResponse.status(), kind).toBe(401);
    expect(await apiResponse.json()).toMatchObject({ success: false });
  }
});

test("API role matrix is deny-by-default and read endpoints remain available", async ({ page, context }) => {
  const cases = [
    { role: "auditor" as const, get: 200, configure: 403, manage: 403 },
    { role: "operator" as const, get: 200, configure: 400, manage: 403 },
    { role: "super" as const, get: 200, configure: 400, manage: 200 },
  ];
  for (const row of cases) {
    await setSession(context, row.role);
    expect((await page.request.get("/api/admin/settings")).status(), `${row.role}:view`).toBe(row.get);
    const configure = await page.request.patch("/api/admin/settings", {
      headers: { Origin: APP_ORIGIN, "Content-Type": "application/json" },
      data: {},
    });
    expect(configure.status(), `${row.role}:configure`).toBe(row.configure);
    expect((await page.request.get("/api/admin/roles")).status(), `${row.role}:manage`).toBe(row.manage);
  }
});

test("forbidden business component never mounts and sends zero business requests", async ({ page, context }) => {
  await setSession(context, "auditor");
  const businessRequests: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/admin/roles")) businessRequests.push(request.url()); });
  await page.goto("/admin/roles");
  await expect(page.getByRole("heading", { name: "没有此页面的访问权限" })).toBeVisible();
  await expect(page.getByText("角色与权限")).toHaveCount(0);
  expect(businessRequests).toEqual([]);
});

test("Windows production rejects environment-delivered internal credentials", async ({ page }) => {
  const headers = { "x-internal-api-secret": VIRTUAL_INTERNAL_SECRET };
  for (const [method, path, expected] of [["GET", "/api/storage/health", 401], ["GET", "/api/admin/settings", 401], ["GET", "/api/settings", 401], ["GET", "/api/backtest", 401], ["POST", "/api/storage/health", 405]] as const) {
    const response = method === "GET" ? await page.request.get(path, { headers }) : await page.request.post(path, { headers });
    expect(response.status(), `${method} ${path}`).toBe(expected);
  }
});

test("legacy management tombstone returns 410 before audit or business mutation", async ({ page, context, request }) => {
  await resetFakeDb(request);
  await setSession(context, "super");
  const response = await page.request.post("/api/settings", {
    headers: { Origin: APP_ORIGIN, "Content-Type": "application/json" },
    data: { virtualOnly: true },
  });
  expect(response.status()).toBe(410);
  expect(await response.json()).toMatchObject({ errorCode: "LEGACY_MANAGEMENT_WRITE_GONE" });
  expect(await fakeDbState(request)).toMatchObject({ auditMutations: 0, businessMutations: 0 });
});

test("malicious next cannot navigate an authenticated user outside admin", async ({ page, context }) => {
  await setSession(context, "super");
  await page.goto("/login?next=https%3A%2F%2Fevil.invalid%2Fsteal");
  await expect(page).toHaveURL(`${APP_ORIGIN}/admin`);
});

test("non-JSON session failures render a stable generic error", async ({ page }) => {
  await page.route("**/api/auth/session", route => route.fulfill({ status: 502, contentType: "text/html", body: "<h1>virtual bad gateway</h1>" }));
  await page.goto("/login");
  await expect(page.locator("#login-error")).toContainText("管理员会话服务暂时不可用");
  await expect(page.getByText("virtual bad gateway")).toHaveCount(0);
});

test("auditor automation and backtests are strictly read-only with zero mutation", async ({ page, context, request }) => {
  await resetFakeDb(request);
  await setSession(context, "auditor");
  for (const path of ["/admin/automation", "/admin/backtests"]) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: /执行每日任务补偿|启动回测/ })).toHaveCount(0);
  }
  const mutation = await page.request.post("/api/admin/automation", {
    headers: { Origin: APP_ORIGIN, "Content-Type": "application/json" }, data: {},
  });
  expect(mutation.status()).toBe(403);
  expect(await fakeDbState(request)).toMatchObject({ auditMutations: 0, businessMutations: 0 });
});

test("390, 768 and 1440 layouts stay within the viewport", async ({ page, context }) => {
  await setSession(context, "super");
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/settings");
    await expect(page.getByRole("heading", { name: "业务设置" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${width}px horizontal overflow`).toBeLessThanOrEqual(1);
  }
});

test("console and network allowlist is exact and production-domain traffic stays zero", async ({ page, context }) => {
  await setSession(context, "super");
  const runtime = observeRuntime(page);
  await page.goto("/admin/settings");
  await expect(page.getByRole("heading", { name: "业务设置" })).toBeVisible();
  expectCleanRuntime(runtime);
});
