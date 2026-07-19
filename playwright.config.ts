import { defineConfig, devices } from "@playwright/test";
import { createHash } from "node:crypto";

const portOffset = Number.parseInt(createHash("sha256").update(process.cwd()).digest("hex").slice(0, 6), 16) % 1000;
const configuredBaseURL = process.env.PLAYWRIGHT_BASE_URL || process.env.BASE_URL;
const configuredFakeDbURL = process.env.PLAYWRIGHT_FAKE_DB_URL;
const port = Number(process.env.PLAYWRIGHT_APP_PORT || (configuredBaseURL ? new URL(configuredBaseURL).port : 31_000 + portOffset));
const fakeDbPort = Number(process.env.PLAYWRIGHT_FAKE_DB_PORT || (configuredFakeDbURL ? new URL(configuredFakeDbURL).port : 41_000 + portOffset));
const baseURL = configuredBaseURL || `http://127.0.0.1:${port}`;
const readinessURL = `${baseURL}/api/readiness`;
const fakeDbURL = configuredFakeDbURL || `http://127.0.0.1:${fakeDbPort}`;

// Keep test-side cookies, Origin headers, URL assertions and fake-DB controls
// on the same isolated ports selected for this workspace.
process.env.PLAYWRIGHT_BASE_URL = baseURL;
process.env.PLAYWRIGHT_FAKE_DB_URL = fakeDbURL;

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
      url: `${fakeDbURL}/health`,
      timeout: 10_000,
      reuseExistingServer: false,
      env: { ...process.env, FAKE_ADMIN_DB_PORT: String(fakeDbPort) },
    },
    {
      command: "node .next/standalone/server.js",
      url: readinessURL,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        DATA_BACKEND: "local",
        LOCAL_SUPABASE_URL: fakeDbURL,
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
