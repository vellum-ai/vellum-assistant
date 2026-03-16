import { beforeEach, describe, expect, test } from "bun:test";

import type { TraceEventKind } from "../daemon/message-protocol.js";
import type {
  TraceEmitOptions,
  TraceEmitter,
} from "../daemon/trace-emitter.js";
import { EventBus } from "../events/bus.js";
import type { AssistantDomainEvents } from "../events/domain-events.js";
import { registerToolTraceListener } from "../events/tool-trace-listener.js";

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

describe("registerToolTraceListener", () => {
  let bus: EventBus<AssistantDomainEvents>;
  let emitter: TraceEmitter;

  beforeEach(() => {
    traces = [];
    bus = new EventBus<AssistantDomainEvents>();
    emitter = createMockTraceEmitter();
    registerToolTraceListener(bus, emitter);
  });

  test("emits tool_started trace on tool.execution.started", async () => {
    await bus.emit("tool.execution.started", {
      conversationId: "conv-1",
      requestId: "req-1",
      toolName: "file_read",
      input: { path: "/tmp/test.txt" },
      startedAtMs: 1000,
    });

    expect(traces).toHaveLength(1);
    expect(traces[0].kind).toBe("tool_started");
    expect(traces[0].summary).toBe("Tool file_read started");
    expect(traces[0].opts?.requestId).toBe("req-1");
    expect(traces[0].opts?.attributes).toEqual({ toolName: "file_read" });
  });

  test("emits tool_permission_requested trace with riskLevel", async () => {
    await bus.emit("tool.permission.requested", {
      conversationId: "conv-1",
      requestId: "req-2",
      toolName: "bash",
      riskLevel: "high",
      requestedAtMs: 2000,
    });

    expect(traces).toHaveLength(1);
    expect(traces[0].kind).toBe("tool_permission_requested");
    expect(traces[0].summary).toBe("Permission requested for bash");
    expect(traces[0].opts?.attributes).toEqual({
      toolName: "bash",
      riskLevel: "high",
    });
  });

  test("emits tool_permission_decided trace with decision", async () => {
    await bus.emit("tool.permission.decided", {
      conversationId: "conv-1",
      requestId: "req-3",
      toolName: "bash",
      decision: "deny",
      riskLevel: "high",
      decidedAtMs: 3000,
    });

    expect(traces).toHaveLength(1);
    expect(traces[0].kind).toBe("tool_permission_decided");
    expect(traces[0].summary).toBe("Permission deny for bash");
    expect(traces[0].opts?.attributes).toEqual({
      toolName: "bash",
      decision: "deny",
    });
  });

  test("emits tool_finished trace with durationMs", async () => {
    await bus.emit("tool.execution.finished", {
      conversationId: "conv-1",
      requestId: "req-4",
      toolName: "file_read",
      decision: "allow",
      riskLevel: "low",
      isError: false,
      durationMs: 42,
      finishedAtMs: 4042,
    });

    expect(traces).toHaveLength(1);
    expect(traces[0].kind).toBe("tool_finished");
    expect(traces[0].summary).toBe("Tool file_read finished in 42ms");
    expect(traces[0].opts?.status).toBeUndefined();
    expect(traces[0].opts?.attributes).toEqual({
      toolName: "file_read",
      durationMs: 42,
      isError: false,
    });
  });

  test("emits tool_finished trace with error status when isError is true", async () => {
    await bus.emit("tool.execution.finished", {
      conversationId: "conv-1",
      requestId: "req-4b",
      toolName: "bash",
      decision: "allow",
      riskLevel: "low",
      isError: true,
      durationMs: 55,
      finishedAtMs: 4055,
    });

    expect(traces).toHaveLength(1);
    expect(traces[0].kind).toBe("tool_finished");
    expect(traces[0].summary).toBe("Tool bash finished in 55ms");
    expect(traces[0].opts?.status).toBe("error");
    expect(traces[0].opts?.attributes).toEqual({
      toolName: "bash",
      durationMs: 55,
      isError: true,
    });
  });

  test("emits tool_failed trace with error status", async () => {
    await bus.emit("tool.execution.failed", {
      conversationId: "conv-1",
      requestId: "req-5",
      toolName: "bash",
      decision: "allow",
      riskLevel: "high",
      durationMs: 100,
      error: "Command not found",
      isExpected: false,
      failedAtMs: 5100,
    });

    expect(traces).toHaveLength(1);
    expect(traces[0].kind).toBe("tool_failed");
    expect(traces[0].summary).toBe("Tool bash failed after 100ms");
    expect(traces[0].opts?.status).toBe("error");
    expect(traces[0].opts?.attributes).toEqual({
      toolName: "bash",
      durationMs: 100,
    });
  });

  test("emits secret_detected trace with warning status", async () => {
    await bus.emit("tool.secret.detected", {
      conversationId: "conv-1",
      requestId: "req-6",
      toolName: "file_read",
      action: "redact",
      matches: [{ type: "AWS Key", redactedValue: "<redacted />" }],
      detectedAtMs: 6000,
    });

    expect(traces).toHaveLength(1);
    expect(traces[0].kind).toBe("secret_detected");
    expect(traces[0].summary).toBe("Secret detected in file_read output");
    expect(traces[0].opts?.status).toBe("warning");
    expect(traces[0].opts?.attributes).toEqual({ toolName: "file_read" });
  });

  test("passes requestId from domain event payload", async () => {
    await bus.emit("tool.execution.started", {
      conversationId: "conv-1",
      requestId: "my-request-id",
      toolName: "file_read",
      input: {},
      startedAtMs: 7000,
    });

    expect(traces[0].opts?.requestId).toBe("my-request-id");
  });

  test("handles missing requestId gracefully", async () => {
    await bus.emit("tool.execution.started", {
      conversationId: "conv-1",
      toolName: "file_read",
      input: {},
      startedAtMs: 8000,
    });

    expect(traces).toHaveLength(1);
    expect(traces[0].opts?.requestId).toBeUndefined();
  });

  test("ignores non-tool domain events", async () => {
    await bus.emit("daemon.lifecycle.started", {
      pid: 123,
      startedAtMs: 9000,
    });

    expect(traces).toHaveLength(0);
  });

  test("subscription can be disposed to stop receiving events", async () => {
    bus.dispose();
    bus = new EventBus<AssistantDomainEvents>();
    const subscription = registerToolTraceListener(bus, emitter);

    await bus.emit("tool.execution.started", {
      conversationId: "conv-1",
      toolName: "file_read",
      input: {},
      startedAtMs: 10000,
    });
    expect(traces).toHaveLength(1);

    subscription.dispose();
    traces.length = 0;

    await bus.emit("tool.execution.started", {
      conversationId: "conv-1",
      toolName: "file_read",
      input: {},
      startedAtMs: 11000,
    });
    expect(traces).toHaveLength(0);
  });
});
