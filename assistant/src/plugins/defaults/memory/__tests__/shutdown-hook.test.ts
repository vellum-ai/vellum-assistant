/**
 * The memory plugin's `shutdown` hook stops the in-process jobs-worker
 * supervisor — the counterpart of the worker start in the `init` hook's
 * `runMemoryStartup`. The worker module is mocked so the test pins only the
 * delegation, not the worker loop.
 */
import { describe, expect, mock, test } from "bun:test";

const stopCalls = { count: 0 };
mock.module("../jobs-worker.js", () => ({
  stopMemoryJobsWorker: () => {
    stopCalls.count += 1;
  },
}));

const memoryShutdown = (await import("../hooks/shutdown.js")).default;

describe("memory shutdown hook", () => {
  test("stops the in-process jobs-worker supervisor", async () => {
    await memoryShutdown({
      assistantVersion: "0.0.0-test",
      reason: "shutdown",
    });
    expect(stopCalls.count).toBe(1);
  });
});
