import { defineConfig, devices } from "@playwright/test";

const port = 3100;
const baseURL = process.env.BASE_URL || `http://127.0.0.1:${port}`;
const readinessURL = `${baseURL}/api/readiness`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "node tests/e2e/helpers/fake-admin-session-db.mjs",
      url: "http://127.0.0.1:54329/health",
      timeout: 10_000,
      reuseExistingServer: false,
    },
    {
      command: "node dist/server.js",
      url: readinessURL,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        DATA_BACKEND: "local",
        LOCAL_SUPABASE_URL: "http://127.0.0.1:54329",
        LOCAL_SUPABASE_ANON_KEY: "playwright-anon-key",
        LOCAL_SUPABASE_SERVICE_ROLE_KEY: "playwright-service-role-key",
        INTERNAL_API_SECRET: "crow5_e2e_virtual_internal_secret_000000000000",
        ADMIN_API_TOKEN: "crow5-e2e-virtual-admin-api-token",
        COZE_PROJECT_ENV: "PROD",
        NODE_ENV: "test",
        DEPLOY_RUN_PORT: String(port),
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        BASE_URL: baseURL,
        INTERNAL_APP_BASE_URL: baseURL,
      },
    },
  ],
});
