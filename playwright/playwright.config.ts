import "dotenv/config";

import { defineConfig } from "@playwright/test";

/**
 * Parallel execution configuration.
 *
 * We use 4 workers to speed up test runs, but desktop-app tests that interact
 * with native macOS UI via AppleScript/System Events have constraints that
 * currently prevent safe parallel execution (see PARALLEL.md for details).
 *
 * The `fullyParallel` flag controls whether tests *within* a single file run
 * in parallel. We keep it off by default so that the dynamically-generated
 * tests in cases.spec.ts are distributed across workers one-at-a-time.
 */
const workers = parseInt(process.env.PW_WORKERS ?? "4", 10);

export default defineConfig({
  testDir: "./tests",
  timeout: 10 * 60_000, // 10 minutes — agent tests can be long-running
  retries: 0,
  workers,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    video: "on",
    trace: "retain-on-failure",
    // Agent tests need Chromium for the AI agent to browse
    browserName: "chromium",
  },
});
