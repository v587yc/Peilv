import { expect, test, type Page, type Route } from "@playwright/test";
import {
  APP_ORIGIN,
  expectCleanRuntime,
  observeRuntime,
  useSession as setSession,
} from "./fixtures/admin-local-isolation.fixture";

const RUN_ID = "10000000-0000-4000-8000-000000000001";
const PREDICTION_ID = "10000000-0000-4000-8000-000000000002";

const metric = {
  counted: 2,
  unavailable: 1,
  outcomes: { win: 1, halfWin: 1, push: 0, halfLoss: 0, loss: 0 },
  profitMicros: "1500000",
  stakeMicros: "2000000",
  roi: "0.75",
};

const cells = ["A", "B", "C", "D"].flatMap(strategy =>
  ["T1215", "T30", "T03"].map(checkpoint => ({
    strategy,
    checkpoint,
    sample: strategy === "D" ? 0 : 2,
    fallback: strategy === "C" ? 1 : 0,
    executable: strategy !== "D",
    compatibilityOnly: strategy === "D",
    decisions: { recommend: 1, observe: 1, reanalyze: 0, insufficient: 0 },
    snapshotQuality: { ready: 1, partial: 0, insufficient: 0, invalid: 0, missing: 1 },
    actual: metric,
    theoretical: { ...metric, counted: 0, roi: null },
  })),
);

function envelope(value: unknown) {
  return {
    contractVersion: "read-v1",
    generatedAt: "2026-07-18T00:00:00Z",
    requestId: "e2e-request",
    appliedFilters: {},
    ...(value as object),
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "private, no-store" },
    body: JSON.stringify(body),
  });
}

async function mockStrategyLabReadonlyApis(page: Page) {
  const methods: string[] = [];

  await page.route("**/api/admin/strategy-lab/**", async route => {
    const request = route.request();
    methods.push(request.method());
    const url = request.url();

    if (request.method() !== "GET") {
      await fulfillJson(route, { success: false, message: "readonly surface" }, 403);
      return;
    }

    if (url.includes("/settlement-chain")) {
      await fulfillJson(route, envelope({
        data: {
          integrity: { revision: "verified", quoteDrift: "verified" },
          revisions: [
            {
              id: "r1",
              revision: 1,
              quoteBasis: "actual",
              outcome: "loss",
              profitMicros: "-1000000",
              isCounted: true,
              evidenceHash: "evidence111111",
              calculatorVersion: "v1",
              quoteHandicapRaw: "0.5",
              quoteSelectedWaterMillionths: 900000,
              scoreRevision: 1,
              scoreRevisionHash: "score111111",
              current: false,
              superseded: true,
              excludedFromStatistics: true,
              settledAt: "2026-07-17T18:00:00Z",
            },
            {
              id: "r2",
              revision: 2,
              quoteBasis: "actual",
              outcome: "win",
              profitMicros: "1000000",
              isCounted: true,
              evidenceHash: "evidence222222",
              calculatorVersion: "v1",
              quoteHandicapRaw: "0.5",
              quoteSelectedWaterMillionths: 900000,
              scoreRevision: 2,
              scoreRevisionHash: "score222222",
              current: true,
              superseded: false,
              excludedFromStatistics: false,
              settledAt: "2026-07-17T19:00:00Z",
            },
          ],
        },
        pageInfo: null,
      }));
      return;
    }

    if (url.includes("/overview")) {
      await fulfillJson(route, envelope({
        data: {
          coverage: {
            predictions: 12,
            matches: 1,
            recommend: 6,
            observe: 3,
            reanalyze: 2,
            insufficient: 1,
            cFallback: 1,
            dBaseline: 3,
          },
          policy: {
            capture: {
              mode: "user_focused_leagues",
              artifactHash: "abcdef1234567890",
              captureId: "capture",
              capturedAt: "2026-07-17T00:00:00Z",
            },
            currentChanged: "unknown",
          },
          health: { reader: "ready" },
        },
        pageInfo: null,
      }));
      return;
    }

    if (url.includes("/matrix")) {
      await fulfillJson(route, envelope({ data: cells, pageInfo: null }));
      return;
    }

    if (url.includes("/report")) {
      await fulfillJson(route, envelope({
        data: {
          validSample: 11,
          coverage: {
            matches: 1,
            recommend: 6,
            observe: 3,
            reanalyze: 1,
            insufficient: 1,
          },
          cFallback: 1,
          dBaseline: 3,
          actual: metric,
          theoretical: { ...metric, counted: 0, roi: null },
          metricDefinitions: { roi: "server" },
          timeSeries: null,
        },
        pageInfo: null,
      }));
      return;
    }

    if (url.includes("/audit")) {
      await fulfillJson(route, envelope({
        data: [{ status: "audit_pending" }],
        pageInfo: { limit: 50, hasMore: false, nextCursor: null },
      }));
      return;
    }

    if (url.includes("/predictions")) {
      await fulfillJson(route, envelope({
        data: [{
          id: PREDICTION_ID,
          matchId: "match-1",
          matchDate: "20260717",
          checkpoint: "T30",
          requestedStrategy: "C",
          executedStrategy: "A",
          fallback: true,
          fallbackReason: "C unavailable",
          compatibilityOnly: false,
          decisionStatus: "recommend",
          selection: "home",
          inputHash: "inputhash123456",
          outputHash: "outputhash123456",
          snapshotHash: "evidencehash123456",
          createdAt: "2026-07-17T00:00:00Z",
        }],
        pageInfo: { limit: 50, hasMore: false, nextCursor: null },
      }));
      return;
    }

    if (url.includes("/runs/") || url.endsWith("/runs") || url.includes("/runs?")) {
      await fulfillJson(route, envelope({
        data: [{
          id: RUN_ID,
          status: "running",
          startDate: "20260717",
          endDate: "20260717",
          datasetMode: "strict_asof",
          createdAt: "2026-07-17T00:00:00Z",
          coverage: { predictions: 12, matches: 1, settled: 2 },
          auditStatus: "audit_pending",
        }],
        pageInfo: { limit: 50, hasMore: false, nextCursor: null },
      }));
      return;
    }

    await fulfillJson(route, envelope({ data: [], pageInfo: { limit: 50, hasMore: false, nextCursor: null } }));
  });

  return {
    methods,
    assertReadonlyNetwork() {
      const strategyLabMethods = methods.filter(Boolean);
      expect(strategyLabMethods.length).toBeGreaterThan(0);
      expect(strategyLabMethods.every(method => method === "GET")).toBe(true);
    },
  };
}

async function expectNoMutationButtons(page: Page) {
  const forbidden = /^(创建|启动|取消|执行|结算|发布|暂停|恢复|导出)$/;
  const labels = await page.locator("button").allTextContents();
  expect(labels.some(label => forbidden.test(label.trim()))).toBe(false);
}

async function expectNoHorizontalOverflow(page: Page, width: number) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${width}px horizontal overflow`).toBeLessThanOrEqual(1);
}

test("Strategy Lab readonly observer works on 390 / 768 / 1440", async ({ page, context }) => {
  await setSession(context, "auditor");
  const network = await mockStrategyLabReadonlyApis(page);
  const runtime = observeRuntime(page);

  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/admin/strategies/lab?tab=matrix");
  await page.waitForLoadState("networkidle");

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });

    await expect(page.getByRole("heading", { name: "没有此页面的访问权限" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Strategy Lab 管理观察台" })).toBeVisible();
    await expect(page.getByText("只读", { exact: true })).toBeVisible();
    await expect(page.getByText("Compatibility-only · 不可执行").first()).toBeVisible();
    await expectNoMutationButtons(page);
    await expectNoHorizontalOverflow(page, width);

    if (width < 1024) {
      const mobileCards = page.getByTestId("matrix-mobile-cards");
      await expect(mobileCards.first()).toBeVisible();
      await expect(mobileCards.getByText("C→A 1").first()).toBeVisible();
      await expect(mobileCards.getByText(/覆盖 推1\/观1\/重0\/缺0/).first()).toBeVisible();
      await expect(mobileCards.getByText("Actual 实际").first()).toBeVisible();
      await expect(mobileCards.getByText("Theoretical 理论").first()).toBeVisible();
      await expect(mobileCards.getByText("ROI —").first()).toBeVisible();
    } else {
      const desktopTables = page.locator('section[aria-label="12格策略矩阵"] table');
      await expect(desktopTables.first()).toBeVisible();
      await expect(desktopTables.locator("td", { hasText: "C→A 1" }).first()).toBeVisible();
      await expect(desktopTables.getByText("Actual 实际").first()).toBeVisible();
      await expect(desktopTables.getByText("Theoretical 理论").first()).toBeVisible();
      await expect(desktopTables.getByText("ROI —").first()).toBeVisible();
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveURL(/tab=matrix/);
  await page.getByRole("tab", { name: "决策证据" }).click();
  await expect(page).toHaveURL(/tab=decision/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Audit pending", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "专业" }).click();
  await expect(page.getByText("Input · inputhash1").first()).toBeVisible();
  await page.getByRole("button", { name: "查看结算修订" }).click();
  await expect(page.getByRole("heading", { name: "结算修订链" })).toBeVisible();
  await expect(page.getByText("current", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("superseded", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "关闭对话框" }).click();

  await page.getByRole("tab", { name: "观察报告" }).click();
  await expect(page).toHaveURL(/tab=report/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("有效样本 11")).toBeVisible();
  await expect(page.getByText("D baseline 3")).toBeVisible();
  await expect(page.getByText("unavailable 1").first()).toBeVisible();

  await page.getByRole("tab", { name: "影子运行" }).click();
  await expect(page).toHaveURL(/tab=shadow/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(RUN_ID.slice(0, 8)).first()).toBeVisible();

  await page.getByRole("tab", { name: "策略矩阵" }).click();
  await expect(page).toHaveURL(/tab=matrix/);
  await page.waitForLoadState("networkidle");

  const write = await page.request.post("/api/admin/strategy-lab/runs", {
    headers: { Origin: APP_ORIGIN, "Content-Type": "application/json" },
    data: {},
  });
  expect(write.status()).toBe(403);

  network.assertReadonlyNetwork();
  expectCleanRuntime(runtime);
});

test("anonymous Strategy Lab page and API fail closed", async ({ page, context }) => {
  await context.clearCookies();
  const pageResponse = await page.goto("/admin/strategies/lab");
  expect(pageResponse?.status()).toBe(200);
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fstrategies%2Flab/);

  const apiResponse = await page.request.get("/api/admin/strategy-lab/runs");
  expect(apiResponse.status()).toBe(401);
  expect(await apiResponse.json()).toMatchObject({ success: false });
});
