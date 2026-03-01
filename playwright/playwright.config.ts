import "dotenv/config";

import { defineConfig } from "@playwright/test";

/**
 * Parallel execution configuration.
 *
 * Desktop-app tests interact with native macOS UI via AppleScript/System Events
 * and have constraints that prevent safe parallel execution on a single runner
 * (see PARALLEL.md for details). Workers default to 1 for safety.
 *
 * To run in parallel, use CI sharding (--shard) across multiple runners, or
 * set PW_WORKERS=N for local experimentation with non-desktop tests.
 *
 * The `fullyParallel` flag controls whether tests *within* a single file run
 * in parallel. We keep it off so that the dynamically-generated tests in
 * cases.spec.ts are distributed across workers one-at-a-time.
 */
const workers = parseInt(process.env.PW_WORKERS ?? "1", 10);

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
