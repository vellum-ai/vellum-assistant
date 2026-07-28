/**
 * The memory plugin's `shutdown` hook SIGTERMs the memory jobs worker process —
 * the counterpart of the worker start in the `init` hook's `runMemoryStartup`.
 * The worker-control module is mocked so the test pins only the delegation, not
 * the process teardown.
 */
import { describe, expect, mock, test } from "bun:test";

const stopCalls = { count: 0 };
mock.module("../worker-control.js", () => ({
  stopMemoryWorkerProcess: () => {
    stopCalls.count += 1;
    return { status: "not_running" as const };
  },
}));

const memoryShutdown = (await import("../hooks/shutdown.js")).default;

describe("memory shutdown hook", () => {
  test("stops the memory jobs worker process", async () => {
    await memoryShutdown({
      assistantVersion: "0.0.0-test",
      reason: "shutdown",
    });
    expect(stopCalls.count).toBe(1);
  });
});
