import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", 
  timeout: 60_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5173",
  },
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER || false
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://127.0.0.1:5173",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
