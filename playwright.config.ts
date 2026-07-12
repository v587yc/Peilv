import { defineConfig, devices } from "@playwright/test";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

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
  webServer: {
    command: "pnpm start",
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      ADMIN_API_TOKEN: "playwright-admin-token",
      INTERNAL_API_SECRET: "playwright-internal-secret",
      COZE_PROJECT_ENV: "PROD",
      DEPLOY_RUN_PORT: String(port),
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
    },
  },
});
