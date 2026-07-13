import { expect, test } from "@playwright/test";

const internalSecret = "playwright-internal-secret";

test("未登录部署控制台会进入独立账号密码登录页", async ({ page, request }) => {
  await page.goto("/deployments");
  await expect(page).toHaveURL(/\/deployment-login$/);
  await expect(page.getByText("版本管理与部署控制台", { exact: true })).toBeVisible();
  await expect(page.getByLabel("管理员账号")).toBeVisible();
  await expect(page.getByLabel("管理员密码")).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "安全登录" })).toBeDisabled();

  const response = await request.get("/api/deployments/overview");
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ success: false, error: "需要部署控制台登录" });
});

test("登录页展示管理员令牌表单", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByText("管理员登录", { exact: true })).toBeVisible();
  await expect(page.getByLabel("管理员令牌")).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "安全登录" })).toBeDisabled();
});

test("未认证请求无法访问敏感 API", async ({ request }) => {
  const response = await request.post("/api/settings", {
    data: { llm_model: "should-not-be-written" },
    headers: { Origin: "http://127.0.0.1:3100" },
  });

  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    success: false,
    error: "需要管理员登录",
  });
});

test("首页提供全部核心页面导航", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "实时赔率监控系统" })).toBeVisible();
  await expect(page.getByRole("link", { name: /赔率监控/ })).toHaveAttribute("href", "/odds");
  await expect(page.getByRole("link", { name: /AI 配置/ })).toHaveAttribute("href", "/test-ai");
  await expect(page.getByRole("link", { name: /学习系统 \/ 回测/ })).toHaveAttribute("href", "/backtest");
  await expect(page.getByRole("link", { name: /记忆系统/ })).toHaveAttribute("href", "/memory");
});

test("已认证 URL 抓取仍拒绝 SSRF 目标", async ({ request }) => {
  const response = await request.post("/api/fetch-url", {
    data: { url: "https://127.0.0.1/private" },
    headers: { "x-internal-api-secret": internalSecret },
  });

  expect(response.status()).toBe(500);
  await expect(response.json()).resolves.toMatchObject({
    error: "目标域名不在允许列表中",
  });
});
