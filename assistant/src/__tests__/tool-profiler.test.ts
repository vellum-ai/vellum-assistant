import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  disposeToolProfiler,
  emitToolProfilingSummary,
  recordToolCompletion,
  startToolProfilingRequest,
  ToolProfiler,
} from "../tools/tool-profiler.js";

describe("ToolProfiler", () => {
  let profiler: ToolProfiler;

  beforeEach(() => {
    profiler = new ToolProfiler();
  });

  test("tracks single tool completion", () => {
    profiler.startRequest();
    profiler.recordToolCompletion("file_read", 42, false);

    const summary = profiler.getSummary();
    expect(summary.toolCount).toBe(1);
    expect(summary.totalToolTimeMs).toBe(42);
    expect(summary.tools["file_read"]).toEqual({
      count: 1,
      totalMs: 42,
      maxMs: 42,
      errors: 0,
    });
  });

  test("accumulates multiple invocations of the same tool", () => {
    profiler.startRequest();
    profiler.recordToolCompletion("bash", 100, false);
    profiler.recordToolCompletion("bash", 200, false);
    profiler.recordToolCompletion("bash", 50, true);

    const summary = profiler.getSummary();
    expect(summary.toolCount).toBe(3);
    expect(summary.totalToolTimeMs).toBe(350);
    expect(summary.tools["bash"]).toEqual({
      count: 3,
      totalMs: 350,
      maxMs: 200,
      errors: 1,
    });
  });

  test("tracks multiple different tools", () => {
    profiler.startRequest();
    profiler.recordToolCompletion("file_read", 10, false);
    profiler.recordToolCompletion("bash", 500, false);
    profiler.recordToolCompletion("file_write", 30, false);

    const summary = profiler.getSummary();
    expect(summary.toolCount).toBe(3);
    expect(summary.totalToolTimeMs).toBe(540);
    expect(Object.keys(summary.tools)).toHaveLength(3);
  });

  test("wallClockMs tracks elapsed time since startRequest", async () => {
    profiler.startRequest();
    await new Promise((r) => setTimeout(r, 50));

    const summary = profiler.getSummary();
    expect(summary.wallClockMs).toBeGreaterThanOrEqual(40);
  });

  test("startRequest resets previous state", () => {
    profiler.startRequest();
    profiler.recordToolCompletion("bash", 100, false);
    expect(profiler.getSummary().toolCount).toBe(1);

    profiler.startRequest();
    expect(profiler.getSummary().toolCount).toBe(0);
    expect(profiler.getSummary().totalToolTimeMs).toBe(0);
  });

  test("tracks RSS memory", () => {
    profiler.startRequest();
    profiler.recordToolCompletion("bash", 10, false);

    const summary = profiler.getSummary();
    expect(summary.peakRssMb).toBeGreaterThan(0);
    expect(typeof summary.rssDeltaMb).toBe("number");
  });

  test("emitSummary returns without throwing when no tools were called", () => {
    profiler.startRequest();
    expect(() => profiler.emitSummary("req-1")).not.toThrow();
  });

  test("emitSummary returns without throwing after tool completions", () => {
    profiler.startRequest();
    profiler.recordToolCompletion("file_read", 10, false);
    profiler.recordToolCompletion("bash", 200, false);
    expect(() => profiler.emitSummary("req-1")).not.toThrow();
  });
});

/**
 * A `process.memoryUsage` replacement that reproduces the Bun 1.3.11
 * `SystemError: Failed to get memory usage, errno: 2` syscall failure. Cast to
 * the real signature because an always-throwing arrow infers a `never` return.
 */
const throwingMemoryUsage = (() => {
  throw new Error("Failed to get memory usage, errno: 2");
}) as unknown as typeof process.memoryUsage;

describe("ToolProfiler RSS sampling failures", () => {
  let profiler: ToolProfiler;

  beforeEach(() => {
    profiler = new ToolProfiler();
  });

  afterEach(() => {
    // Restore the real implementation between cases.
    spyOn(process, "memoryUsage").mockRestore();
  });

  test("startRequest tolerates a throwing memoryUsage syscall", () => {
    // Simulate the Bun 1.3.11 `SystemError: Failed to get memory usage` bug.
    spyOn(process, "memoryUsage").mockImplementation(throwingMemoryUsage);

    expect(() => profiler.startRequest()).not.toThrow();
  });

  test("recordToolCompletion still records stats when memoryUsage throws", () => {
    profiler.startRequest();
    spyOn(process, "memoryUsage").mockImplementation(throwingMemoryUsage);

    // The RSS sample fails, but the tool's timing stats are still recorded and
    // no exception escapes to the caller (the agent loop).
    expect(() =>
      profiler.recordToolCompletion("bash", 123, false),
    ).not.toThrow();

    const summary = profiler.getSummary();
    expect(summary.toolCount).toBe(1);
    expect(summary.tools["bash"]).toEqual({
      count: 1,
      totalMs: 123,
      maxMs: 123,
      errors: 0,
    });
  });
});

describe("conversation-keyed profiler registry", () => {
  test("recording before a request window is a silent no-op", () => {
    expect(() =>
      recordToolCompletion("conv-none", "file_read", 5, false),
    ).not.toThrow();
    // No active profiler for the conversation → summary emits nothing / no throw.
    expect(() => emitToolProfilingSummary("conv-none", "req-x")).not.toThrow();
  });

  test("start/record/emit/dispose round-trip does not throw and isolates by conversation", () => {
    startToolProfilingRequest("conv-a");
    startToolProfilingRequest("conv-b");
    recordToolCompletion("conv-a", "bash", 10, false);
    recordToolCompletion("conv-b", "file_read", 20, true);

    expect(() => emitToolProfilingSummary("conv-a", "req-a")).not.toThrow();
    expect(() => emitToolProfilingSummary("conv-b", "req-b")).not.toThrow();

    disposeToolProfiler("conv-a");
    disposeToolProfiler("conv-b");
    // After dispose the conversation has no profiler again — recording no-ops.
    expect(() =>
      recordToolCompletion("conv-a", "bash", 1, false),
    ).not.toThrow();
  });

  test("recordToolCompletion swallows profiler failures instead of throwing", () => {
    startToolProfilingRequest("conv-throwing");
    const spy = spyOn(process, "memoryUsage").mockImplementation(
      throwingMemoryUsage,
    );

    try {
      // A throwing RSS syscall must never propagate to the executor/agent loop.
      expect(() =>
        recordToolCompletion("conv-throwing", "bash", 42, false),
      ).not.toThrow();
    } finally {
      spy.mockRestore();
    }

    // The turn's timing stats survived even though the RSS sample failed.
    expect(() =>
      emitToolProfilingSummary("conv-throwing", "req-throwing"),
    ).not.toThrow();
    disposeToolProfiler("conv-throwing");
  });

  test("startToolProfilingRequest resets a conversation's prior window", () => {
    startToolProfilingRequest("conv-reset");
    recordToolCompletion("conv-reset", "bash", 100, false);
    // A new request window clears prior stats; emitting the fresh (empty)
    // window must not throw.
    startToolProfilingRequest("conv-reset");
    expect(() =>
      emitToolProfilingSummary("conv-reset", "req-reset"),
    ).not.toThrow();
    disposeToolProfiler("conv-reset");
  });
});
