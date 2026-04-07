import { describe, expect, test } from "bun:test";

import { type AnyEventEnvelope, EventBus } from "../events/bus.js";
import type { AssistantDomainEvents } from "../events/domain-events.js";
import { createToolDomainEventPublisher } from "../events/tool-domain-event-publisher.js";

function makeEventsCollector() {
  const bus = new EventBus<AssistantDomainEvents>();
  const events: AnyEventEnvelope<AssistantDomainEvents>[] = [];
  bus.onAny((event) => {
    events.push(event);
  });
  return { bus, events };
}

describe("createToolDomainEventPublisher", () => {
  test("maps start and permission lifecycle events into domain events", async () => {
    const { bus, events } = makeEventsCollector();
    const publish = createToolDomainEventPublisher(bus);

    await publish({
      type: "start",
      toolName: "bash",
      input: { command: "ls" },
      workingDir: "/tmp/project",
      conversationId: "conversation-1",
      startedAtMs: 100,
    });

    await publish({
      type: "permission_prompt",
      toolName: "bash",
      input: { command: "ls" },
      workingDir: "/tmp/project",
      conversationId: "conversation-1",
      riskLevel: "medium",
      reason: "needs approval",
      allowlistOptions: [],
      scopeOptions: [],
    });

    await publish({
      type: "permission_denied",
      toolName: "bash",
      input: { command: "rm -rf /tmp" },
      workingDir: "/tmp/project",
      conversationId: "conversation-1",
      riskLevel: "high",
      decision: "deny",
      reason: "Permission denied by user",
      durationMs: 20,
    });

    expect(events.map((event) => event.type)).toEqual([
      "tool.execution.started",
      "tool.permission.requested",
      "tool.permission.decided",
    ]);
    expect(events[0].payload).toMatchObject({
      toolName: "bash",
      conversationId: "conversation-1",
      startedAtMs: 100,
    });
    expect(events[1].payload).toMatchObject({
      toolName: "bash",
      riskLevel: "medium",
    });
    expect(events[2].payload).toMatchObject({
      toolName: "bash",
      decision: "deny",
      riskLevel: "high",
    });
  });

  test("maps executed lifecycle event to permission.decided + execution.finished", async () => {
    const { bus, events } = makeEventsCollector();
    const publish = createToolDomainEventPublisher(bus);

    await publish({
      type: "executed",
      toolName: "file_read",
      input: { path: "README.md" },
      workingDir: "/tmp/project",
      conversationId: "conversation-1",
      riskLevel: "low",
      decision: "allow",
      durationMs: 15,
      result: { content: "ok", isError: false },
    });

    expect(events.map((event) => event.type)).toEqual([
      "tool.permission.decided",
      "tool.execution.finished",
    ]);
    expect(events[0].payload).toMatchObject({
      decision: "allow",
      riskLevel: "low",
    });
    expect(events[1].payload).toMatchObject({
      toolName: "file_read",
      isError: false,
      durationMs: 15,
      decision: "allow",
    });
  });

  test("maps timeout-like executed lifecycle event to permission.decided + execution.finished", async () => {
    const { bus, events } = makeEventsCollector();
    const publish = createToolDomainEventPublisher(bus);

    await publish({
      type: "executed",
      toolName: "bash",
      input: { command: "sleep 30" },
      workingDir: "/tmp/project",
      conversationId: "conversation-1",
      riskLevel: "high",
      decision: "always_allow",
      durationMs: 5000,
      result: {
        content: "[Command timed out after 5s]",
        isError: true,
        status: "timeout",
      },
    });

    expect(events.map((event) => event.type)).toEqual([
      "tool.permission.decided",
      "tool.execution.finished",
    ]);
    expect(events[0].payload).toMatchObject({
      decision: "always_allow",
      riskLevel: "high",
    });
    expect(events[1].payload).toMatchObject({
      toolName: "bash",
      decision: "always_allow",
      isError: true,
      durationMs: 5000,
    });
  });

  test("maps secret_detected lifecycle event to tool.secret.detected domain event", async () => {
    const { bus, events } = makeEventsCollector();
    const publish = createToolDomainEventPublisher(bus);

    await publish({
      type: "secret_detected",
      toolName: "file_read",
      input: { path: "secrets.txt" },
      workingDir: "/tmp/project",
      conversationId: "conversation-1",
      action: "redact",
      matches: [
        {
          type: "AWS Access Key",
          redactedValue: '<redacted type="AWS Access Key" />',
        },
      ],
      detectedAtMs: 55,
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.secret.detected");
    expect(events[0].payload).toEqual({
      conversationId: "conversation-1",
      toolName: "file_read",
      action: "redact",
      matches: [
        {
          type: "AWS Access Key",
          redactedValue: '<redacted type="AWS Access Key" />',
        },
      ],
      detectedAtMs: 55,
    });
  });

  test("maps allow-decision error lifecycle event to permission.decided + execution.failed", async () => {
    const { bus, events } = makeEventsCollector();
    const publish = createToolDomainEventPublisher(bus);

    await publish({
      type: "error",
      toolName: "bash",
      input: { command: "cat /missing" },
      workingDir: "/tmp/project",
      conversationId: "conversation-1",
      riskLevel: "high",
      decision: "allow",
      durationMs: 12,
      errorMessage: "cat: /missing: No such file or directory",
      isExpected: false,
      errorCategory: "tool_failure",
      errorName: "Error",
      errorStack: "Error: cat: /missing: No such file or directory",
    });

    expect(events.map((event) => event.type)).toEqual([
      "tool.permission.decided",
      "tool.execution.failed",
    ]);
    expect(events[0].payload).toMatchObject({
      decision: "allow",
      riskLevel: "high",
    });
    expect(events[1].payload).toMatchObject({
      toolName: "bash",
      decision: "allow",
      durationMs: 12,
      error: "cat: /missing: No such file or directory",
      isExpected: false,
      errorName: "Error",
      errorStack: "Error: cat: /missing: No such file or directory",
    });
  });

  test("maps error lifecycle event to execution.failed with diagnostics", async () => {
    const { bus, events } = makeEventsCollector();
    const publish = createToolDomainEventPublisher(bus);

    await publish({
      type: "error",
      toolName: "bash",
      input: { command: "cat /missing" },
      workingDir: "/tmp/project",
      conversationId: "conversation-1",
      riskLevel: "medium",
      decision: "error",
      durationMs: 9,
      errorMessage: "ENOENT",
      isExpected: false,
      errorCategory: "tool_failure",
      errorName: "Error",
      errorStack: "Error: ENOENT\n    at test",
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.execution.failed");
    expect(events[0].payload).toMatchObject({
      conversationId: "conversation-1",
      toolName: "bash",
      riskLevel: "medium",
      decision: "error",
      durationMs: 9,
      error: "ENOENT",
      isExpected: false,
      errorName: "Error",
      errorStack: "Error: ENOENT\n    at test",
    });
  });
});
