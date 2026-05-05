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
      decision: "deny",
      reason: "Permission denied by user",
      durationMs: 22,
    });

    expect(records).toHaveLength(2);
    expect(records[0].result).toBe("denied: Blocked by deny rule: rm *");
    expect(records[0].decision).toBe("denied");
    expect(records[1].result).toBe("denied");
    expect(records[1].decision).toBe("denied");
  });

  test("redacts known-pattern secrets in tool result content before recording", () => {
    const records: ToolInvocationRecord[] = [];
    const listener = createToolAuditListener((record) => records.push(record));

    // Anthropic key pattern requires 80+ chars after "sk-ant-"
    const anthropicKey =
      "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" +
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    listener({
      type: "executed",
      toolName: "bash",
      input: { command: "echo $ANTHROPIC_API_KEY" },
      workingDir: "/tmp",
      conversationId: "conv-redact",
      riskLevel: "low",
      decision: "allow",
      durationMs: 5,
      result: { content: `key=${anthropicKey}`, isError: false },
    });

    expect(records).toHaveLength(1);
    expect(records[0].result).not.toContain("sk-ant-api03-");
    expect(records[0].result).toContain("<redacted");
  });

  test("does not redact non-secret content like UUIDs or hashes", () => {
    const records: ToolInvocationRecord[] = [];
    const listener = createToolAuditListener((record) => records.push(record));

    const safeContent =
      "file id: 550e8400-e29b-41d4-a716-446655440000, sha: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

    listener({
      type: "executed",
      toolName: "file_read",
      input: { path: "/tmp/data" },
      workingDir: "/tmp",
      conversationId: "conv-safe",
      riskLevel: "low",
      decision: "allow",
      durationMs: 3,
      result: { content: safeContent, isError: false },
    });

    expect(records).toHaveLength(1);
    expect(records[0].result).toBe(safeContent);
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
