import "dotenv/config";

import { defineConfig } from "@playwright/test";

/**
 * Parallel execution configuration.
 *
 * Desktop-app tests interact with native macOS UI via AppleScript/System Events
 * and have constraints that prevent safe parallel execution on a single runner.
 * Workers is fixed at 1 — each runner executes tests sequentially.
 *
 * To run in parallel, use CI sharding (--shard) across multiple runners.
 *
 * `fullyParallel` is enabled so that Playwright's --shard flag distributes
 * individual tests (not just files) across shards. This is critical because
 * cases.spec.ts generates all test cases dynamically in a single file —
 * without fullyParallel, all of those tests would land on one shard.
 * With workers=1 per runner, tests still execute sequentially within each shard.
 */

export default defineConfig({
  testDir: "./tests",
  timeout: 10 * 60_000, // 10 minutes — agent tests can be long-running
  retries: 0,
  workers: 1,
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    video: "on",
    trace: "retain-on-failure",
    // Agent tests need Chromium for the AI agent to browse
    browserName: "chromium",
  },
});
