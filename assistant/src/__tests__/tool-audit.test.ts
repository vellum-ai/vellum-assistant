import { beforeEach, describe, expect, mock, test } from "bun:test";

// Toggle for the share_analytics opt-out gate consulted when populating the
// telemetry columns.
let shareAnalytics = true;

mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

// Capture the audit rows the terminals would insert, and the lifecycle-event
// telemetry strings they would record, without touching the database.
const records: Array<Record<string, unknown>> = [];
const lifecycleEvents: string[] = [];

mock.module("../telemetry/tool-usage-store.js", () => ({
  recordToolInvocation: (record: Record<string, unknown>) =>
    records.push(record),
}));

mock.module("../persistence/lifecycle-events-store.js", () => ({
  recordLifecycleEvent: (eventName: string) => lifecycleEvents.push(eventName),
}));

import {
  recordToolDenied,
  recordToolError,
  recordToolExecuted,
  recordToolPermissionPrompted,
} from "../telemetry/tool-audit.js";
import {
  OPENAI_PROJECT_KEY_REDACTION_MARKER,
  SYNTHETIC_OPENAI_PROJECT_KEY,
} from "./secret-fixtures.js";

const ATTRIBUTION = {
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

describe("tool audit terminals", () => {
  beforeEach(() => {
    shareAnalytics = true;
    records.length = 0;
    lifecycleEvents.length = 0;
  });

  test("records executed rows with truncated output", () => {
    recordToolExecuted({
      conversationId: "conv-1",
      toolName: "file_read",
      input: { path: "/tmp/a" },
      resultContent: "x".repeat(1200),
      resultBytes: 1200,
      decision: "allow",
      riskLevel: "low",
      durationMs: 12,
      attribution: null,
      wasPrompted: false,
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

  test("records denied rows with expected normalized results", () => {
    recordToolDenied({
      conversationId: "conv-2",
      toolName: "bash",
      input: { command: "rm -rf /tmp" },
      reason: "Blocked by deny rule: rm *",
      riskLevel: "high",
      durationMs: 20,
      wasPrompted: false,
    });
    recordToolDenied({
      conversationId: "conv-2",
      toolName: "bash",
      input: { command: "sudo rm -rf /tmp" },
      reason: "Permission denied by user",
      riskLevel: "high",
      durationMs: 22,
      wasPrompted: false,
    });

    expect(records).toHaveLength(2);
    expect(records[0].result).toBe("denied: Blocked by deny rule: rm *");
    expect(records[0].decision).toBe("denied");
    expect(records[1].result).toBe("denied");
    expect(records[1].decision).toBe("denied");
  });

  test("redacts known-pattern secrets in tool result content before recording", () => {
    // Anthropic key pattern requires 80+ chars after "sk-ant-"
    const anthropicKey =
      "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" +
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    recordToolExecuted({
      conversationId: "conv-redact",
      toolName: "bash",
      input: { command: "echo $ANTHROPIC_API_KEY" },
      resultContent: `key=${anthropicKey}`,
      resultBytes: 100,
      decision: "allow",
      riskLevel: "low",
      durationMs: 5,
      attribution: null,
      wasPrompted: false,
    });

    expect(records).toHaveLength(1);
    expect(records[0].result).not.toContain("sk-ant-api03-");
    expect(records[0].result).toContain("<redacted");
  });

  test("redacts known-pattern secrets in tool inputs across executed/error/denied", () => {
    const input = {
      command: `export OPENAI_API_KEY="${SYNTHETIC_OPENAI_PROJECT_KEY}"`,
    };

    recordToolExecuted({
      conversationId: "conv-input-redact",
      toolName: "bash",
      input,
      resultContent: "ok",
      resultBytes: 2,
      decision: "allow",
      riskLevel: "low",
      durationMs: 5,
      attribution: null,
      wasPrompted: false,
    });
    recordToolError({
      conversationId: "conv-input-redact",
      toolName: "bash",
      input,
      errorMessage: "boom",
      isExpected: false,
      riskLevel: "low",
      durationMs: 5,
      attribution: null,
    });
    recordToolDenied({
      conversationId: "conv-input-redact",
      toolName: "bash",
      input,
      reason: "Permission denied by user",
      riskLevel: "high",
      durationMs: 5,
      wasPrompted: false,
    });

    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.input).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
      // The stored input must remain parseable JSON: string leaves are
      // redacted before stringification, so the marker lands inside a JSON
      // string value (its quotes escaped) instead of corrupting the
      // serialized form.
      const parsed = JSON.parse(record.input as string) as { command: string };
      expect(parsed.command).toContain(OPENAI_PROJECT_KEY_REDACTION_MARKER);
    }
  });

  test("benign inputs round-trip byte-identical (no false-positive mangling)", () => {
    const input = {
      command: "git log --oneline -5 && echo done",
      cwd: "/tmp/project",
      env: { LANG: "en_US.UTF-8" },
    };

    recordToolExecuted({
      conversationId: "conv-benign-input",
      toolName: "bash",
      input,
      resultContent: "ok",
      resultBytes: 2,
      decision: "allow",
      riskLevel: "low",
      durationMs: 2,
      attribution: null,
      wasPrompted: false,
    });

    expect(records).toHaveLength(1);
    expect(records[0].input).toBe(JSON.stringify(input));
  });

  test("redacts sensitive KEYS whose values are not secret-shaped", () => {
    // Field-key redaction: a value under a sensitive key (`password`, `token`,
    // …) must be redacted even when the value itself matches no secret pattern
    // — a pattern scan alone would persist `hunter2` / an opaque token verbatim.
    const input = { username: "alice", password: "hunter2", token: "abc123" };

    recordToolExecuted({
      conversationId: "conv-field-redact",
      toolName: "login",
      input,
      resultContent: "ok",
      resultBytes: 2,
      decision: "allow",
      riskLevel: "low",
      durationMs: 2,
      attribution: null,
      wasPrompted: false,
    });

    expect(records).toHaveLength(1);
    const stored = JSON.parse(records[0].input as string) as {
      username: string;
      password: string;
      token: string;
    };
    // Non-sensitive keys pass through; sensitive-key values are redacted.
    expect(stored.username).toBe("alice");
    expect(stored.password).not.toBe("hunter2");
    expect(stored.password).toContain("redacted");
    expect(stored.token).not.toBe("abc123");
    expect(stored.token).toContain("redacted");
  });

  test("does not redact non-secret content like UUIDs or hashes", () => {
    const safeContent =
      "file id: 550e8400-e29b-41d4-a716-446655440000, sha: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

    recordToolExecuted({
      conversationId: "conv-safe",
      toolName: "file_read",
      input: { path: "/tmp/data" },
      resultContent: safeContent,
      resultBytes: Buffer.byteLength(safeContent),
      decision: "allow",
      riskLevel: "low",
      durationMs: 3,
      attribution: null,
      wasPrompted: false,
    });

    expect(records).toHaveLength(1);
    expect(records[0].result).toBe(safeContent);
  });

  test("records error rows sized from the built error string", () => {
    recordToolError({
      conversationId: "conv-3",
      toolName: "file_read",
      input: { path: "/tmp/secret" },
      errorMessage: "boom",
      isExpected: false,
      riskLevel: "low",
      durationMs: 9,
      attribution: null,
    });

    expect(records).toHaveLength(1);
    expect(records[0].result).toBe("error: boom");
    expect(records[0].decision).toBe("error");
    expect(records[0].argBytes).toBe(
      Buffer.byteLength(JSON.stringify({ path: "/tmp/secret" }), "utf8"),
    );
    expect(records[0].resultBytes).toBe(Buffer.byteLength("error: boom"));
  });

  test("sizes bytes from the full payloads, before truncation and redaction", () => {
    // 1200-char result: the stored result is capped at 1000 but resultBytes
    // reflects the full raw payload the executor measured. "é" is 1 char /
    // 2 utf8 bytes, proving byte (not char) accounting.
    const rawResultBytes = Buffer.byteLength("é".repeat(1200), "utf8");
    recordToolExecuted({
      conversationId: "conv-bytes",
      toolName: "file_read",
      input: { path: "/tmp/a" },
      resultContent: "é".repeat(1200),
      resultBytes: rawResultBytes,
      decision: "allow",
      riskLevel: "low",
      durationMs: 12,
      attribution: null,
      wasPrompted: false,
    });

    expect(records).toHaveLength(1);
    expect(records[0].result).toHaveLength(1000);
    expect(records[0].argBytes).toBe(
      Buffer.byteLength(JSON.stringify({ path: "/tmp/a" }), "utf8"),
    );
    expect(records[0].resultBytes).toBe(2400);
  });

  test("reports the caller-supplied raw resultBytes, not the sanitized content size", () => {
    // For sensitive-output tools, the executor passes the RAW result size
    // separately from the placeholder-rewritten content stored for audit.
    const sanitizedContent = "code: VELLUM_ASSISTANT_INVITE_CODE_AB12CD34";
    const rawSize = 4096;

    recordToolExecuted({
      conversationId: "conv-raw-result-bytes",
      toolName: "create_invite",
      input: { count: 1 },
      resultContent: sanitizedContent,
      resultBytes: rawSize,
      decision: "allow",
      riskLevel: "low",
      durationMs: 4,
      attribution: null,
      wasPrompted: false,
    });

    expect(records).toHaveLength(1);
    expect(records[0].resultBytes).toBe(rawSize);
    expect(records[0].resultBytes).not.toBe(
      Buffer.byteLength(sanitizedContent, "utf8"),
    );
  });

  test("persists NULL telemetry columns when share_analytics is opted out", () => {
    shareAnalytics = false;

    recordToolExecuted({
      conversationId: "conv-opt-out",
      toolName: "file_read",
      input: { path: "/tmp/a" },
      resultContent: "ok",
      resultBytes: 99,
      decision: "allow",
      riskLevel: "low",
      durationMs: 12,
      attribution: ATTRIBUTION,
      wasPrompted: false,
    });
    recordToolError({
      conversationId: "conv-opt-out",
      toolName: "file_read",
      input: { path: "/tmp/b" },
      errorMessage: "boom",
      isExpected: false,
      riskLevel: "low",
      durationMs: 9,
      attribution: ATTRIBUTION,
    });

    // Telemetry columns are NULL — the tool_executed projection's
    // arg_bytes IS NOT NULL filter makes these rows permanently unreportable.
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

  test("maps attribution onto executed rows and leaves denied rows null", () => {
    recordToolExecuted({
      conversationId: "conv-attr",
      toolName: "file_read",
      input: { path: "/tmp/a" },
      resultContent: "ok",
      resultBytes: 2,
      decision: "allow",
      riskLevel: "low",
      durationMs: 12,
      attribution: ATTRIBUTION,
      wasPrompted: false,
    });
    recordToolExecuted({
      conversationId: "conv-attr",
      toolName: "file_read",
      input: { path: "/tmp/b" },
      resultContent: "ok",
      resultBytes: 2,
      decision: "allow",
      riskLevel: "low",
      durationMs: 3,
      attribution: null,
      wasPrompted: false,
    });
    recordToolDenied({
      conversationId: "conv-attr",
      toolName: "bash",
      input: { command: "rm -rf /tmp" },
      reason: "Permission denied by user",
      riskLevel: "high",
      durationMs: 1,
      wasPrompted: false,
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

  test("prompted decisions record permission lifecycle telemetry; unprompted do not", () => {
    recordToolPermissionPrompted("bash");
    // Prompted allow → executed records a decided event.
    recordToolExecuted({
      conversationId: "conv-prompt",
      toolName: "bash",
      input: { command: "ls" },
      resultContent: "ok",
      resultBytes: 2,
      decision: "allow",
      riskLevel: "high",
      durationMs: 3,
      attribution: null,
      wasPrompted: true,
    });
    // Prompted denial → denied records a decided event.
    recordToolDenied({
      conversationId: "conv-prompt",
      toolName: "bash",
      input: { command: "rm -rf /" },
      reason: "Permission denied by user",
      riskLevel: "high",
      durationMs: 1,
      wasPrompted: true,
    });
    // Unprompted (auto-approved) execution records nothing.
    recordToolExecuted({
      conversationId: "conv-prompt",
      toolName: "file_read",
      input: { path: "/tmp/a" },
      resultContent: "ok",
      resultBytes: 2,
      decision: "allow",
      riskLevel: "low",
      durationMs: 1,
      attribution: null,
      wasPrompted: false,
    });

    expect(lifecycleEvents).toEqual([
      "permission_prompt:bash",
      "permission_decided:bash:allow",
      "permission_decided:bash:deny",
    ]);
  });
});
