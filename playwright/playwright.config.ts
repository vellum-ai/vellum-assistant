import "dotenv/config";

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 10 * 60_000, // 10 minutes — agent tests can be long-running
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    video: "on",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "standard",
      testMatch: /^(?!.*agent-cases).*\.spec\.ts$/,
      timeout: 120_000,
    },
    {
      name: "agent",
      testMatch: "agent-cases.spec.ts",
      timeout: 10 * 60_000,
      use: {
        // Agent tests need Chromium for the AI agent to browse
        browserName: "chromium",
      },
    },
  ],
});
