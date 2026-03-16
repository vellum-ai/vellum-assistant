import { beforeEach, describe, expect, test } from "bun:test";

import { EventBus } from "../events/bus.js";
import type { AssistantDomainEvents } from "../events/domain-events.js";
import { registerToolMetricsLoggingListener } from "../events/tool-metrics-listener.js";

let debugEnabled = false;
const debugCalls: unknown[][] = [];
const infoCalls: unknown[][] = [];
const warnCalls: unknown[][] = [];
const errorCalls: unknown[][] = [];

const testLogger = {
  debug: (...args: unknown[]) => debugCalls.push(args),
  info: (...args: unknown[]) => infoCalls.push(args),
  warn: (...args: unknown[]) => warnCalls.push(args),
  error: (...args: unknown[]) => errorCalls.push(args),
};

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return (
    value.slice(0, maxLen) + `... (${value.length - maxLen} chars truncated)`
  );
}

function clearCalls(): void {
  debugCalls.length = 0;
  infoCalls.length = 0;
  warnCalls.length = 0;
  errorCalls.length = 0;
}

describe("registerToolMetricsLoggingListener", () => {
  beforeEach(() => {
    debugEnabled = false;
    clearCalls();
  });

  test("logs execution start and finish diagnostics in debug mode", async () => {
    debugEnabled = true;
    const bus = new EventBus<AssistantDomainEvents>();
    registerToolMetricsLoggingListener(bus, {
      logger: testLogger,
      debugEnabled: () => debugEnabled,
      truncate,
    });

    await bus.emit("tool.execution.started", {
      conversationId: "conversation-1",
      toolName: "file_read",
      input: { path: "README.md" },
      startedAtMs: 100,
    });

    await bus.emit("tool.execution.finished", {
      conversationId: "conversation-1",
      toolName: "file_read",
      decision: "allow",
      riskLevel: "low",
      isError: false,
      durationMs: 12,
      finishedAtMs: 112,
    });

    expect(debugCalls).toHaveLength(2);
    expect(debugCalls[0][1]).toBe("Tool execute start");
    expect(debugCalls[1][1]).toBe("Tool execute result");

    const startPayload = debugCalls[0][0] as Record<string, unknown>;
    expect(startPayload.tool).toBe("file_read");
    expect(startPayload.input as string).toContain('"path":"README.md"');

    const finishPayload = debugCalls[1][0] as Record<string, unknown>;
    expect(finishPayload.execDurationMs).toBe(12);
    expect(finishPayload.decision).toBe("allow");
  });

  test("does not emit debug execution logs when debug mode is disabled", async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    registerToolMetricsLoggingListener(bus, {
      logger: testLogger,
      debugEnabled: () => debugEnabled,
      truncate,
    });

    await bus.emit("tool.execution.started", {
      conversationId: "conversation-1",
      toolName: "file_read",
      input: { path: "README.md" },
      startedAtMs: 100,
    });
    await bus.emit("tool.execution.finished", {
      conversationId: "conversation-1",
      toolName: "file_read",
      decision: "allow",
      riskLevel: "low",
      isError: false,
      durationMs: 12,
      finishedAtMs: 112,
    });

    expect(debugCalls).toHaveLength(0);
  });

  test("logs permission request and deny decisions as info", async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    registerToolMetricsLoggingListener(bus, {
      logger: testLogger,
      debugEnabled: () => debugEnabled,
      truncate,
    });

    await bus.emit("tool.permission.requested", {
      conversationId: "conversation-1",
      toolName: "bash",
      riskLevel: "high",
      requestedAtMs: 120,
    });
    await bus.emit("tool.permission.decided", {
      conversationId: "conversation-1",
      toolName: "bash",
      decision: "deny",
      riskLevel: "high",
      decidedAtMs: 125,
    });

    expect(infoCalls).toHaveLength(2);
    expect(infoCalls[0][1]).toBe("Tool permission requested");
    expect(infoCalls[1][1]).toBe("Tool permission denied");
  });

  test("logs secret detection warnings with aggregate details", async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    registerToolMetricsLoggingListener(bus, {
      logger: testLogger,
      debugEnabled: () => debugEnabled,
      truncate,
    });

    await bus.emit("tool.secret.detected", {
      conversationId: "conversation-1",
      toolName: "file_read",
      action: "warn",
      matches: [
        {
          type: "AWS Access Key",
          redactedValue: '<redacted type="AWS Access Key" />',
        },
        {
          type: "GitHub Token",
          redactedValue: '<redacted type="GitHub Token" />',
        },
      ],
      detectedAtMs: 130,
    });

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0][1]).toBe("Secrets detected in tool output");
    const payload = warnCalls[0][0] as Record<string, unknown>;
    expect(payload.matchCount).toBe(2);
    expect(payload.types as string[]).toEqual([
      "AWS Access Key",
      "GitHub Token",
    ]);
  });

  test("logs execution failures as errors", async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    registerToolMetricsLoggingListener(bus, {
      logger: testLogger,
      debugEnabled: () => debugEnabled,
      truncate,
    });

    await bus.emit("tool.execution.failed", {
      conversationId: "conversation-1",
      toolName: "bash",
      decision: "error",
      riskLevel: "high",
      durationMs: 42,
      error: "boom",
      isExpected: false,
      errorName: "Error",
      errorStack: "Error: boom\n    at test",
      failedAtMs: 142,
    });

    expect(errorCalls).toHaveLength(1);
    expect(warnCalls).toHaveLength(0);
    expect(errorCalls[0][1]).toBe("Tool execution error");
    const payload = errorCalls[0][0] as Record<string, unknown>;
    expect(payload.tool).toBe("bash");
    expect(payload.error).toBe("boom");
    expect(payload.errorStack).toBe("Error: boom\n    at test");
    expect(payload.execDurationMs).toBe(42);
  });

  test("logs expected execution failures as warnings", async () => {
    const bus = new EventBus<AssistantDomainEvents>();
    registerToolMetricsLoggingListener(bus, {
      logger: testLogger,
      debugEnabled: () => debugEnabled,
      truncate,
    });

    await bus.emit("tool.execution.failed", {
      conversationId: "conversation-1",
      toolName: "bash",
      decision: "error",
      riskLevel: "medium",
      durationMs: 14,
      error: "Permission denied by user",
      isExpected: true,
      errorName: "PermissionDeniedError",
      errorStack:
        "PermissionDeniedError: Permission denied by user\n    at test",
      failedAtMs: 201,
    });

    expect(warnCalls).toHaveLength(1);
    expect(errorCalls).toHaveLength(0);
    expect(warnCalls[0][1]).toBe("Tool execution failed (expected)");
    const payload = warnCalls[0][0] as Record<string, unknown>;
    expect(payload.tool).toBe("bash");
    expect(payload.isExpected).toBe(true);
    expect(payload.errorName).toBe("PermissionDeniedError");
  });
});
