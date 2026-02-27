import "dotenv/config";

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  retries: 0,
  reporter: "list",
  use: {
    video: "on",
  },
});
