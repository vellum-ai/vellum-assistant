import { describe, expect, test } from "bun:test";

import { createToolAuditListener } from "../events/tool-audit-listener.js";
import type { ToolInvocationRecord } from "../memory/tool-usage-store.js";

describe("tool audit listener", () => {
  test("records executed events with truncated output", () => {
    const records: ToolInvocationRecord[] = [];
    const listener = createToolAuditListener((record) => records.push(record));

    listener({
      type: "executed",
      toolName: "file_read",
      input: { path: "/tmp/a" },
      workingDir: "/tmp",
      conversationId: "conv-1",
      riskLevel: "low",
      decision: "allow",
      durationMs: 12,
      result: { content: "x".repeat(1200), isError: false },
    });

    expect(records).toHaveLength(1);
    expect(records[0].conversationId).toBe("conv-1");
    expect(records[0].toolName).toBe("file_read");
    expect(records[0].input).toBe(JSON.stringify({ path: "/tmp/a" }));
    expect(records[0].result).toHaveLength(1000);
    expect(records[0].decision).toBe("allow");
    expect(records[0].riskLevel).toBe("low");
    expect(records[0].durationMs).toBe(12);
  });

  test("records deny events with expected normalized results", () => {
    const records: ToolInvocationRecord[] = [];
    const listener = createToolAuditListener((record) => records.push(record));

    listener({
      type: "permission_denied",
      toolName: "bash",
      input: { command: "rm -rf /tmp" },
      workingDir: "/tmp",
      conversationId: "conv-2",
      riskLevel: "high",
      decision: "deny",
      reason: "Blocked by deny rule: rm *",
      durationMs: 20,
    });
    listener({
      type: "permission_denied",
      toolName: "bash",
      input: { command: "sudo rm -rf /tmp" },
      workingDir: "/tmp",
      conversationId: "conv-2",
      riskLevel: "high",
      decision: "always_deny",
      reason: "Permission denied by user (rule saved)",
      durationMs: 22,
    });

    expect(records).toHaveLength(2);
    expect(records[0].result).toBe("denied: Blocked by deny rule: rm *");
    expect(records[0].decision).toBe("denied");
    expect(records[1].result).toBe("denied (permanent)");
    expect(records[1].decision).toBe("denied");
  });

  test("records error events and ignores non-terminal events", () => {
    const records: ToolInvocationRecord[] = [];
    const listener = createToolAuditListener((record) => records.push(record));

    listener({
      type: "start",
      toolName: "file_read",
      input: { path: "/tmp/a" },
      workingDir: "/tmp",
      conversationId: "conv-3",
      startedAtMs: Date.now(),
    });
    listener({
      type: "permission_prompt",
      toolName: "bash",
      input: { command: "rm -rf /tmp" },
      workingDir: "/tmp",
      conversationId: "conv-3",
      riskLevel: "high",
      reason: "High risk: always requires approval",
      allowlistOptions: [],
      scopeOptions: [],
    });
    listener({
      type: "error",
      toolName: "file_read",
      input: { path: "/tmp/secret" },
      workingDir: "/tmp",
      conversationId: "conv-3",
      riskLevel: "low",
      decision: "error",
      durationMs: 9,
      errorMessage: "boom",
      isExpected: false,
      errorCategory: "tool_failure",
    });

    expect(records).toHaveLength(1);
    expect(records[0].result).toBe("error: boom");
    expect(records[0].decision).toBe("error");
  });
});
