import { beforeEach, describe, expect, mock, test } from "bun:test";

// Toggle for the share_analytics opt-out gate the listener consults when
// populating the telemetry columns.
let shareAnalytics = true;

mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import { createToolAuditListener } from "../events/tool-audit-listener.js";
import type { ToolInvocationRecord } from "../telemetry/tool-usage-store.js";
import {
  OPENAI_PROJECT_KEY_REDACTION_MARKER,
  SYNTHETIC_OPENAI_PROJECT_KEY,
} from "./secret-fixtures.js";

describe("tool audit listener", () => {
  beforeEach(() => {
    shareAnalytics = true;
  });

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

  test("redacts known-pattern secrets in tool inputs before recording", () => {
    const records: ToolInvocationRecord[] = [];
    const listener = createToolAuditListener((record) => records.push(record));

    const input = {
      command: `export OPENAI_API_KEY="${SYNTHETIC_OPENAI_PROJECT_KEY}"`,
    };

    listener({
      type: "executed",
      toolName: "bash",
      input,
      workingDir: "/tmp",
      conversationId: "conv-input-redact",
      riskLevel: "low",
      decision: "allow",
      durationMs: 5,
      result: { content: "ok", isError: false },
    });
    listener({
      type: "error",
      toolName: "bash",
      input,
      workingDir: "/tmp",
      conversationId: "conv-input-redact",
      riskLevel: "low",
      decision: "error",
      durationMs: 5,
      errorMessage: "boom",
      isExpected: false,
      errorCategory: "tool_failure",
    });
    listener({
      type: "permission_denied",
      toolName: "bash",
      input,
      workingDir: "/tmp",
      conversationId: "conv-input-redact",
      riskLevel: "high",
      decision: "deny",
      reason: "Permission denied by user",
      durationMs: 5,
    });

    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.input).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
      // The stored input must remain parseable JSON: string leaves are
      // redacted before stringification, so the marker lands inside a JSON
      // string value (its quotes escaped) instead of corrupting the
      // serialized form.
      const parsed = JSON.parse(record.input) as { command: string };
      expect(parsed.command).toContain(OPENAI_PROJECT_KEY_REDACTION_MARKER);
    }
  });

  test("benign inputs round-trip byte-identical (no false-positive mangling)", () => {
    const records: ToolInvocationRecord[] = [];
    const listener = createToolAuditListener((record) => records.push(record));

    const input = {
      command: "git log --oneline -5 && echo done",
      cwd: "/tmp/project",
      env: { LANG: "en_US.UTF-8" },
    };

    listener({
      type: "executed",
      toolName: "bash",
      input,
      workingDir: "/tmp",
      conversationId: "conv-benign-input",
      riskLevel: "low",
      decision: "allow",
      durationMs: 2,
      result: { content: "ok", isError: false },
    });

    expect(records).toHaveLength(1);
    expect(records[0].input).toBe(JSON.stringify(input));
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
    expect(records[0].argBytes).toBe(
      Buffer.byteLength(JSON.stringify({ path: "/tmp/secret" }), "utf8"),
    );
    expect(records[0].resultBytes).toBe(Buffer.byteLength("error: boom"));
  });

  test("records byte sizes from the full payloads, before truncation and redaction", () => {
    const records: ToolInvocationRecord[] = [];
    const listener = createToolAuditListener((record) => records.push(record));

    listener({
      type: "executed",
      toolName: "file_read",
      input: { path: "/tmp/a" },
      workingDir: "/tmp",
      conversationId: "conv-bytes",
      riskLevel: "low",
      decision: "allow",
      durationMs: 12,
      // 1200 chars: the stored result is capped at 1000 but the size must
      // reflect the full payload. "é" is 1 char / 2 utf8 bytes, proving
      // byte (not char) accounting.
      result: { content: "é".repeat(1200), isError: false },
    });

    expect(records).toHaveLength(1);
    expect(records[0].result).toHaveLength(1000);
    expect(records[0].argBytes).toBe(
      Buffer.byteLength(JSON.stringify({ path: "/tmp/a" }), "utf8"),
    );
    expect(records[0].resultBytes).toBe(2400);
  });

  test("prefers the executor-stamped raw inputBytes over sizing the (sanitized) event input", () => {
    const records: ToolInvocationRecord[] = [];
    const listener = createToolAuditListener((record) => records.push(record));

    // The executor sanitizes event.input before listeners run and stamps
    // inputBytes from the RAW input — the listener must report that size,
    // not the redacted payload's.
    const rawInput = { path: "/tmp/a", token: "t-1" };
    const rawSize = Buffer.byteLength(JSON.stringify(rawInput), "utf8");
    const sanitizedInput = { path: "/tmp/a", token: "<redacted />" };

    listener({
      type: "executed",
      toolName: "file_read",
      input: sanitizedInput,
      inputBytes: rawSize,
      workingDir: "/tmp",
      conversationId: "conv-raw-bytes",
      riskLevel: "low",
      decision: "allow",
      durationMs: 4,
      result: { content: "ok", isError: false },
    });
    listener({
      type: "error",
      toolName: "file_read",
      input: sanitizedInput,
      inputBytes: rawSize,
      workingDir: "/tmp",
      conversationId: "conv-raw-bytes",
      riskLevel: "low",
      decision: "error",
      durationMs: 4,
      errorMessage: "boom",
      isExpected: false,
      errorCategory: "tool_failure",
    });

    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.argBytes).toBe(rawSize);
      expect(record.argBytes).not.toBe(
        Buffer.byteLength(JSON.stringify(sanitizedInput), "utf8"),
      );
    }
  });

  test("prefers the executor-stamped raw resultBytes over sizing the (sanitized) event result", () => {
    const records: ToolInvocationRecord[] = [];
    const listener = createToolAuditListener((record) => records.push(record));

    // For sensitive-output tools, the executor sanitizes result.content
    // before listeners run and stamps resultBytes from the RAW content —
    // the listener must report that size, not the placeholder-rewritten
    // payload's.
    const sanitizedContent = "code: VELLUM_ASSISTANT_INVITE_CODE_AB12CD34";
    const rawSize = 4096;

    listener({
      type: "executed",
      toolName: "create_invite",
      input: { count: 1 },
      workingDir: "/tmp",
      conversationId: "conv-raw-result-bytes",
      riskLevel: "low",
      decision: "allow",
      durationMs: 4,
      result: { content: sanitizedContent, isError: false },
      resultBytes: rawSize,
    });

    expect(records).toHaveLength(1);
    expect(records[0].resultBytes).toBe(rawSize);
    expect(records[0].resultBytes).not.toBe(
      Buffer.byteLength(sanitizedContent, "utf8"),
    );
  });

  test("persists NULL telemetry columns when share_analytics is opted out", () => {
    shareAnalytics = false;
    const records: ToolInvocationRecord[] = [];
    const listener = createToolAuditListener((record) => records.push(record));

    const attribution = {
      callSite: "mainAgent" as const,
      activeProfile: "balanced",
      overrideProfile: null,
      callSiteProfile: null,
      appliedProfile: "balanced",
      profileSource: "active" as const,
      resolvedProvider: "anthropic",
      resolvedModel: "model-a",
      resolvedMixArm: null,
    };
    listener({
      type: "executed",
      toolName: "file_read",
      input: { path: "/tmp/a" },
      inputBytes: 42,
      resultBytes: 99,
      workingDir: "/tmp",
      conversationId: "conv-opt-out",
      riskLevel: "low",
      decision: "allow",
      durationMs: 12,
      result: { content: "ok", isError: false },
      attribution,
    });
    listener({
      type: "error",
      toolName: "file_read",
      input: { path: "/tmp/b" },
      inputBytes: 42,
      workingDir: "/tmp",
      conversationId: "conv-opt-out",
      riskLevel: "low",
      decision: "error",
      durationMs: 9,
      errorMessage: "boom",
      isExpected: false,
      errorCategory: "tool_failure",
      attribution,
    });

    // Telemetry columns are NULL — the tool_executed projection's
    // arg_bytes IS NOT NULL filter makes these rows permanently
    // unreportable, even from a zero watermark.
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.argBytes).toBeNull();
      expect(record.resultBytes).toBeNull();
      expect(record.provider).toBeNull();
      expect(record.model).toBeNull();
      expect(record.inferenceProfile).toBeNull();
      expect(record.inferenceProfileSource).toBeNull();
    }
    // The audit row itself is unaffected by the opt-out.
    expect(records[0]).toMatchObject({
      conversationId: "conv-opt-out",
      toolName: "file_read",
      input: JSON.stringify({ path: "/tmp/a" }),
      result: "ok",
      decision: "allow",
      durationMs: 12,
    });
    expect(records[1]).toMatchObject({
      result: "error: boom",
      decision: "error",
      durationMs: 9,
    });
  });

  test("maps attribution onto executed records and leaves denied records null", () => {
    const records: ToolInvocationRecord[] = [];
    const listener = createToolAuditListener((record) => records.push(record));

    listener({
      type: "executed",
      toolName: "file_read",
      input: { path: "/tmp/a" },
      workingDir: "/tmp",
      conversationId: "conv-attr",
      riskLevel: "low",
      decision: "allow",
      durationMs: 12,
      result: { content: "ok", isError: false },
      attribution: {
        callSite: "mainAgent",
        activeProfile: "balanced",
        overrideProfile: null,
        callSiteProfile: null,
        appliedProfile: "balanced",
        profileSource: "active",
        resolvedProvider: "anthropic",
        resolvedModel: "model-a",
        resolvedMixArm: null,
      },
    });
    listener({
      type: "executed",
      toolName: "file_read",
      input: { path: "/tmp/b" },
      workingDir: "/tmp",
      conversationId: "conv-attr",
      riskLevel: "low",
      decision: "allow",
      durationMs: 3,
      result: { content: "ok", isError: false },
      attribution: null,
    });
    listener({
      type: "permission_denied",
      toolName: "bash",
      input: { command: "rm -rf /tmp" },
      workingDir: "/tmp",
      conversationId: "conv-attr",
      riskLevel: "high",
      decision: "deny",
      reason: "Permission denied by user",
      durationMs: 1,
    });

    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      provider: "anthropic",
      model: "model-a",
      inferenceProfile: "balanced",
      inferenceProfileSource: "active",
    });
    expect(records[1]).toMatchObject({
      provider: null,
      model: null,
      inferenceProfile: null,
      inferenceProfileSource: null,
    });
    expect(records[2].provider).toBeUndefined();
    expect(records[2].argBytes).toBeUndefined();
    expect(records[2].resultBytes).toBeUndefined();
  });
});
