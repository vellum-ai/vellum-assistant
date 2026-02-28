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
    // Agent tests need Chromium for the AI agent to browse
    browserName: "chromium",
  },
});
