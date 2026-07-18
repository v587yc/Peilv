import { expect, test } from "@playwright/test";

test("uninitialized login stays informational and never collects bootstrap credentials", async ({ page }) => {
  let initialized = false;
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const bootstrapRequests: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", request => failedRequests.push(`${request.method()} ${request.url()}`));
  page.on("request", request => { if (request.url().includes("/api/auth/bootstrap")) bootstrapRequests.push(`${request.method()} ${request.url()}`); });
  await page.route("**/api/auth/session", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configured: initialized, initialized, authenticated: false, user: null }),
    });
  });

  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1, name: "系统尚未初始化" })).toBeVisible();
  const instructions = page.getByRole("button", { name: "查看初始化说明" });
  await expect(instructions).toBeVisible();
  await expect(instructions).toHaveAttribute("aria-expanded", "false");
  await instructions.focus();
  await expect(instructions).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(instructions).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("pnpm admin:bootstrap")).toBeVisible();
  await expect(page.locator("input")).toHaveCount(0);
  await expect(page.locator("form")).toHaveCount(0);
  expect(bootstrapRequests).toEqual([]);

  initialized = true;
  await page.getByRole("button", { name: "重新检查初始化状态" }).click();
  await expect(page.getByLabel("管理员账号")).toBeVisible();
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
  expect(bootstrapRequests).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
