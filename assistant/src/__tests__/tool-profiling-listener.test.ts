import { beforeEach, describe, expect, test } from "bun:test";

import type { TraceEventKind } from "../daemon/message-protocol.js";
import type {
  TraceEmitOptions,
  TraceEmitter,
} from "../daemon/trace-emitter.js";
import { EventBus } from "../events/bus.js";
import type { AssistantDomainEvents } from "../events/domain-events.js";
import {
  registerToolProfilingListener,
  ToolProfiler,
} from "../events/tool-profiling-listener.js";

interface EmittedTrace {
  kind: TraceEventKind;
  summary: string;
  opts?: TraceEmitOptions;
}

let traces: EmittedTrace[];

function createMockTraceEmitter(): TraceEmitter {
  return {
    emit(kind: TraceEventKind, summary: string, opts?: TraceEmitOptions) {
      traces.push({ kind, summary, opts });
    },
  } as TraceEmitter;
}

describe("ToolProfiler", () => {
  let profiler: ToolProfiler;

  beforeEach(() => {
    traces = [];
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

  test("emitSummary does nothing when no tools were called", () => {
    const emitter = createMockTraceEmitter();
    profiler.startRequest();
    profiler.emitSummary(emitter, "req-1");

    expect(traces).toHaveLength(0);
  });

  test("emitSummary emits tool_profiling_summary trace", () => {
    const emitter = createMockTraceEmitter();
    profiler.startRequest();
    profiler.recordToolCompletion("file_read", 10, false);
    profiler.recordToolCompletion("bash", 200, false);
    profiler.recordToolCompletion("bash", 50, true);

    profiler.emitSummary(emitter, "req-1");

    expect(traces).toHaveLength(1);
    expect(traces[0].kind).toBe("tool_profiling_summary");
    expect(traces[0].opts?.requestId).toBe("req-1");
    expect(traces[0].opts?.status).toBe("info");
    expect(traces[0].opts?.attributes?.toolCount).toBe(3);
    expect(traces[0].opts?.attributes?.totalToolTimeMs).toBe(260);
    expect(traces[0].opts?.attributes?.slowestTool).toBe("bash");
    expect(traces[0].opts?.attributes?.slowestToolMaxMs).toBe(200);
  });

  test("emitSummary summary text includes key metrics", () => {
    const emitter = createMockTraceEmitter();
    profiler.startRequest();
    profiler.recordToolCompletion("bash", 100, false);

    profiler.emitSummary(emitter);

    expect(traces[0].summary).toContain("1 tool calls");
    expect(traces[0].summary).toContain("tool time: 100ms");
    expect(traces[0].summary).toContain("slowest: bash 100ms");
  });
});

describe("registerToolProfilingListener", () => {
  let bus: EventBus<AssistantDomainEvents>;
  let profiler: ToolProfiler;

  beforeEach(() => {
    bus = new EventBus<AssistantDomainEvents>();
    profiler = new ToolProfiler();
    profiler.startRequest();
    registerToolProfilingListener(bus, profiler);
  });

  test("records tool.execution.finished events", async () => {
    await bus.emit("tool.execution.finished", {
      conversationId: "conv-1",
      requestId: "req-1",
      toolName: "file_read",
      decision: "allow",
      riskLevel: "low",
      isError: false,
      durationMs: 42,
      finishedAtMs: 4042,
    });

    const summary = profiler.getSummary();
    expect(summary.toolCount).toBe(1);
    expect(summary.tools["file_read"]).toEqual({
      count: 1,
      totalMs: 42,
      maxMs: 42,
      errors: 0,
    });
  });

  test("records tool.execution.finished with isError=true", async () => {
    await bus.emit("tool.execution.finished", {
      conversationId: "conv-1",
      toolName: "bash",
      decision: "allow",
      riskLevel: "low",
      isError: true,
      durationMs: 55,
      finishedAtMs: 4055,
    });

    expect(profiler.getSummary().tools["bash"].errors).toBe(1);
  });

  test("records tool.execution.failed events as errors", async () => {
    await bus.emit("tool.execution.failed", {
      conversationId: "conv-1",
      requestId: "req-2",
      toolName: "bash",
      decision: "allow",
      riskLevel: "high",
      durationMs: 100,
      error: "Command not found",
      isExpected: false,
      failedAtMs: 5100,
    });

    const summary = profiler.getSummary();
    expect(summary.toolCount).toBe(1);
    expect(summary.tools["bash"]).toEqual({
      count: 1,
      totalMs: 100,
      maxMs: 100,
      errors: 1,
    });
  });

  test("ignores non-completion events", async () => {
    await bus.emit("tool.execution.started", {
      conversationId: "conv-1",
      toolName: "file_read",
      input: {},
      startedAtMs: 1000,
    });

    await bus.emit("tool.permission.requested", {
      conversationId: "conv-1",
      toolName: "bash",
      riskLevel: "high",
      requestedAtMs: 2000,
    });

    expect(profiler.getSummary().toolCount).toBe(0);
  });

  test("subscription can be disposed", async () => {
    bus.dispose();
    bus = new EventBus<AssistantDomainEvents>();
    const subscription = registerToolProfilingListener(bus, profiler);

    await bus.emit("tool.execution.finished", {
      conversationId: "conv-1",
      toolName: "file_read",
      decision: "allow",
      riskLevel: "low",
      isError: false,
      durationMs: 10,
      finishedAtMs: 3010,
    });
    expect(profiler.getSummary().toolCount).toBe(1);

    subscription.dispose();
    profiler.startRequest(); // reset

    await bus.emit("tool.execution.finished", {
      conversationId: "conv-1",
      toolName: "file_read",
      decision: "allow",
      riskLevel: "low",
      isError: false,
      durationMs: 10,
      finishedAtMs: 4010,
    });
    expect(profiler.getSummary().toolCount).toBe(0);
  });
});
