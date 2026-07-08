import { beforeEach, describe, expect, test } from "bun:test";

import { ToolProfiler } from "../tools/tool-profiler.js";

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
