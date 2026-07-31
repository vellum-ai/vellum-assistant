/**
 * The memory-worker process bounds how long its shutdown waits for the
 * embedding backend to reap the ONNX worker it owns. That bound has to clear
 * one full worker teardown (the SIGTERM wait plus the SIGKILL wait), or the
 * process exits mid-reap and leaves the child orphaned, which is the failure
 * JARVIS-1125 exists to remove.
 *
 * The two constants cannot be shared by import: the plugin-import boundary
 * guard forbids the memory plugin from reaching into `persistence/`, and
 * re-exporting through `embedding-backend.ts` would force a static import of
 * `embedding-local.ts`, defeating the dynamic import that keeps
 * onnxruntime-node from loading at daemon startup in compiled binaries.
 *
 * This test is not plugin code, so it may import both and fail if they drift.
 * The plugin-side constant lives in its own module because `worker.ts` starts
 * the worker process in its module body.
 */

import { describe, expect, test } from "bun:test";

import { WORKER_TEARDOWN_BUDGET_MS } from "../persistence/embeddings/embedding-local.js";
import { SHUTDOWN_REAP_BUDGET_MS } from "../plugins/defaults/memory/shutdown-budget.js";

describe("memory worker shutdown budget", () => {
  test("clears one full embedding worker teardown", () => {
    expect(SHUTDOWN_REAP_BUDGET_MS).toBeGreaterThan(WORKER_TEARDOWN_BUDGET_MS);
  });

  test("stays close enough to the teardown budget to exit promptly", () => {
    // Guards the other direction: a wildly oversized budget would stall
    // shutdown for the daemon that is waiting on this process.
    expect(SHUTDOWN_REAP_BUDGET_MS).toBeLessThanOrEqual(
      WORKER_TEARDOWN_BUDGET_MS * 2,
    );
  });
});
