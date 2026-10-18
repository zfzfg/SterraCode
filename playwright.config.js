import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.js",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: {
    timeout: 10000,
    toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.002 },
  },
  use: {
    baseURL: "http://127.0.0.1:3107",
    viewport: { width: 1366, height: 768 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/e2e/server.js",
    url: "http://127.0.0.1:3107",
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: "list",
});
