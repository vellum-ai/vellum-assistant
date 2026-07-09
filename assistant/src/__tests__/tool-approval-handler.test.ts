import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

// Mock verification control-plane policy -- not targeting control-plane by default
mock.module("../tools/verification-control-plane-policy.js", () => ({
  enforceVerificationControlPlanePolicy: () => ({ denied: false }),
}));

// Mock task run rules — no task run rules by default
mock.module("../tasks/ephemeral-permissions.js", () => ({
  getTaskRunRules: () => [],
}));

// Mock tool registry — return a fake tool for 'bash'
const fakeTool = {
  name: "bash",
  description: "Run a shell command",
  category: "shell",
  defaultRiskLevel: "high",
  input_schema: {},
  execute: async () => ({ content: "ok", isError: false }),
};

mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => (name === "bash" ? fakeTool : undefined),
  getAllTools: () => [fakeTool],
}));

// Capture tool-audit terminal calls so tests can assert on denied/error outcomes
// the way they previously asserted on emitted lifecycle events.
const auditCalls = {
  denied: [] as any[],
  error: [] as any[],
  executed: [] as any[],
  prompted: [] as string[],
};
mock.module("../telemetry/tool-audit.js", () => ({
  recordToolDenied: (e: any) => auditCalls.denied.push(e),
  recordToolError: (e: any) => auditCalls.error.push(e),
  recordToolExecuted: (e: any) => auditCalls.executed.push(e),
  recordToolPermissionPrompted: (n: string) => auditCalls.prompted.push(n),
}));

function resetAuditCalls(): void {
  auditCalls.denied.length = 0;
  auditCalls.error.length = 0;
  auditCalls.executed.length = 0;
  auditCalls.prompted.length = 0;
}

import {
  mintGrantFromDecision,
  type MintGrantParams,
} from "../approvals/approval-primitive.js";
import { getDb } from "../persistence/db-connection.js";
import { getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { scopedApprovalGrants } from "../persistence/schema/index.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";
import {
  type ApprovalCellThreshold,
  isSensitiveTool,
  resolveSensitiveToolDecision,
  ToolApprovalHandler,
} from "../tools/tool-approval-handler.js";
import type { ToolContext } from "../tools/types.js";

await initializeDb();

function clearTables(): void {
  const db = getDb();
  db.delete(scopedApprovalGrants).run();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  const now = Date.now();
  getSqlite().run(
    "INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)",
    ["conv-1", now, now],
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mintParams(overrides: Partial<MintGrantParams> = {}): MintGrantParams {
  const futureExpiry = Date.now() + 60_000;
  return {
    scopeMode: "tool_signature",
    requestChannel: "telegram",
    decisionChannel: "telegram",
    expiresAt: futureExpiry,
    ...overrides,
  };
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: testDir,
    conversationId: "conv-1",
    assistantId: "self",
    requestId: "req-1",
    trustClass: "trusted_contact",
    ...overrides,
  };
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("ToolApprovalHandler / pre-exec gate grant check", () => {
  const handler = new ToolApprovalHandler();

  beforeEach(() => {
    clearTables();
    resetAuditCalls();
  });

  test("untrusted actor + matching tool_signature grant -> allow", async () => {
    const toolName = "bash";
    const input = { command: "ls -la" };
    const digest = computeToolApprovalDigest(toolName, input);

    // Mint a grant that matches the invocation
    const mintResult = mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName,
        inputDigest: digest,
      }),
    );
    expect(mintResult.ok).toBe(true);

    const context = makeContext({ trustClass: "trusted_contact" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
    // No permission_denied should have been recorded
    expect(auditCalls.denied.length).toBe(0);
  });

  test("untrusted actor + no matching grant -> deny with guardian_approval_required", async () => {
    const toolName = "bash";
    const input = { command: "rm -rf /" };

    const context = makeContext({ trustClass: "unknown" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain("guardian approval");

    // A permission_denied should have been recorded
    expect(auditCalls.denied.length).toBe(1);
  });

  test("unverified_channel actor + matching grant -> allow", async () => {
    const toolName = "bash";
    const input = { command: "echo hello" };
    const digest = computeToolApprovalDigest(toolName, input);

    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName,
        inputDigest: digest,
      }),
    );

    const context = makeContext({ trustClass: "unknown" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
  });

  test("unverified_channel actor + no grant -> deny", async () => {
    const toolName = "bash";
    const input = { command: "deploy" };

    const context = makeContext({ trustClass: "unknown" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.result.content).toContain("verified channel identity");
  });

  test("grant is one-time: second invocation with same input denied", async () => {
    const toolName = "bash";
    const input = { command: "ls" };
    const digest = computeToolApprovalDigest(toolName, input);

    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName,
        inputDigest: digest,
      }),
    );

    const context = makeContext({ trustClass: "unknown" });

    // First invocation — should consume the grant and allow
    const first = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );
    expect(first.allowed).toBe(true);

    // Second invocation — grant already consumed, should deny
    const second = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );
    expect(second.allowed).toBe(false);
  });

  test("grant with mismatched input digest -> deny", async () => {
    const toolName = "bash";
    const grantInput = { command: "ls" };
    const invokeInput = { command: "rm -rf /" };
    const grantDigest = computeToolApprovalDigest(toolName, grantInput);

    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName,
        inputDigest: grantDigest,
      }),
    );

    const context = makeContext({ trustClass: "unknown" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      invokeInput,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
  });

  test("expired grant -> deny", async () => {
    const toolName = "bash";
    const input = { command: "ls" };
    const digest = computeToolApprovalDigest(toolName, input);
    const pastExpiry = Date.now() - 60_000;

    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName,
        inputDigest: digest,
        expiresAt: pastExpiry,
      }),
    );

    const context = makeContext({ trustClass: "unknown" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
  });

  test("guardian actor bypasses grant check entirely (no grant needed)", async () => {
    const toolName = "bash";
    const input = { command: "deploy" };

    // No grants minted at all
    const context = makeContext({ trustClass: "guardian" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    // Guardian should pass through — the untrusted gate is not triggered
    expect(result.allowed).toBe(true);
  });

  test("guardian actor role (desktop) bypasses grant check", async () => {
    const toolName = "bash";
    const input = { command: "deploy" };

    const context = makeContext({ trustClass: "guardian" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
  });

  test("grant with matching request_id scope -> allow", async () => {
    const toolName = "bash";
    const input = { command: "ls" };

    mintGrantFromDecision(
      mintParams({
        scopeMode: "request_id",
        requestId: "req-1",
      }),
    );

    const context = makeContext({
      trustClass: "trusted_contact",
      requestId: "req-1",
    });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
  });

  test("grant with context fields (conversationId) must match", async () => {
    const toolName = "bash";
    const input = { command: "ls" };
    const digest = computeToolApprovalDigest(toolName, input);

    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName,
        inputDigest: digest,
        conversationId: "conv-other",
      }),
    );

    // Context conversationId does not match the grant's conversationId
    const context = makeContext({
      trustClass: "unknown",
      conversationId: "conv-1",
    });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
  });

  test("non-voice channel denial is instant (no retry polling)", async () => {
    const toolName = "bash";
    const input = { command: "rm -rf /" };

    // executionChannel defaults to undefined (non-voice)
    const context = makeContext({
      trustClass: "unknown",
      executionChannel: "telegram",
    });

    const start = Date.now();
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );
    const elapsed = Date.now() - start;

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.result.content).toContain("guardian approval");
    // Non-voice denials should be nearly instant — no 10s retry polling
    expect(elapsed).toBeLessThan(500);
  });

  test("voice channel with delayed grant succeeds via retry polling", async () => {
    const toolName = "bash";
    const input = { command: "echo hello" };
    const digest = computeToolApprovalDigest(toolName, input);

    // Mint the grant after 300ms — the voice retry polling should find it
    setTimeout(() => {
      mintGrantFromDecision(
        mintParams({
          scopeMode: "tool_signature",
          toolName,
          inputDigest: digest,
        }),
      );
    }, 300);

    const context = makeContext({
      trustClass: "unknown",
      executionChannel: "phone",
    });

    const start = Date.now();
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );
    const elapsed = Date.now() - start;

    expect(result.allowed).toBe(true);
    // Should have taken at least ~300ms (the minting delay) but not the full 10s
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5_000);
  });

  test("voice channel abort returns Cancelled instead of guardian_approval_required", async () => {
    const toolName = "bash";
    const input = { command: "deploy --force" };

    const controller = new AbortController();
    // Abort after 200ms to simulate voice barge-in
    setTimeout(() => controller.abort(), 200);

    const context = makeContext({
      trustClass: "unknown",
      executionChannel: "phone",
      signal: controller.signal,
    });

    const start = Date.now();
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "high",
      Date.now(),
    );
    const elapsed = Date.now() - start;

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    // Should return 'Cancelled', not a guardian_approval_required message
    expect(result.result.content).toBe("Cancelled");
    expect(result.result.isError).toBe(true);
    // Should exit promptly after the abort signal, not wait full 10s
    expect(elapsed).toBeLessThan(2_000);

    // The recorded terminal should be an error with 'Cancelled', not a denial
    expect(auditCalls.error.length).toBeGreaterThanOrEqual(1);
    expect(auditCalls.denied.length).toBe(0);
    const lastError = auditCalls.error[auditCalls.error.length - 1];
    expect(lastError.errorMessage).toBe("Cancelled");
    expect(lastError.isExpected).toBe(true);
  });

  test("trusted contact requires grant for sandboxed side-effect tools", async () => {
    const result = await handler.checkPreExecutionGates(
      "bash",
      { command: "echo hello" },
      makeContext({ trustClass: "trusted_contact" }),
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    expect(auditCalls.denied).toHaveLength(1);
  });
});

describe("isSensitiveTool", () => {
  test("sensitivity is a property of the tool and execution target only", () => {
    // Side-effect tools are sensitive wherever they run.
    expect(isSensitiveTool("bash", "sandbox")).toBe(true);
    expect(isSensitiveTool("file_write", "sandbox")).toBe(true);
    // Read-only tools are sensitive only when they execute on the host.
    expect(isSensitiveTool("web_search", "host")).toBe(true);
    expect(isSensitiveTool("web_search", "sandbox")).toBe(false);
    // UI surface tools are exempt even on the host target.
    expect(isSensitiveTool("ui_show", "host")).toBe(false);
    expect(isSensitiveTool("ui_update", "host")).toBe(false);
    expect(isSensitiveTool("ui_dismiss", "host")).toBe(false);
  });
});

describe("resolveSensitiveToolDecision / CapabilitySet floor invariant", () => {
  const cellThresholds: Array<ApprovalCellThreshold | undefined> = [
    undefined,
    "none",
    "low",
    "medium",
    "high",
  ];
  const riskLevels = ["low", "medium", "high"];

  test("no cell threshold or risk level lifts the floor for non-self actors", () => {
    for (const cellThreshold of cellThresholds) {
      for (const riskLevel of riskLevels) {
        expect(
          resolveSensitiveToolDecision({
            sensitive: true,
            cellThreshold,
            riskLevel,
            sensitiveToolApproval: "escalate-and-wait",
          }),
        ).toBe("escalate-and-wait");
        expect(
          resolveSensitiveToolDecision({
            sensitive: true,
            cellThreshold,
            riskLevel,
            sensitiveToolApproval: "deny",
          }),
        ).toBe("deny");
      }
    }
  });

  test("self capability proceeds for sensitive tools (lane-B policy governs downstream)", () => {
    for (const cellThreshold of cellThresholds) {
      for (const riskLevel of riskLevels) {
        expect(
          resolveSensitiveToolDecision({
            sensitive: true,
            cellThreshold,
            riskLevel,
            sensitiveToolApproval: "self",
          }),
        ).toBe("proceed");
      }
    }
  });

  test("non-sensitive tools proceed regardless of the capability floor", () => {
    for (const sensitiveToolApproval of [
      "self",
      "escalate-and-wait",
      "deny",
    ] as const) {
      expect(
        resolveSensitiveToolDecision({
          sensitive: false,
          cellThreshold: undefined,
          riskLevel: "high",
          sensitiveToolApproval,
        }),
      ).toBe("proceed");
    }
  });
});

describe("ToolApprovalHandler / unparseable tool args gate", () => {
  const handler = new ToolApprovalHandler();

  beforeEach(() => {
    clearTables();
    resetAuditCalls();
  });

  test("input wrapped as { _raw } is rejected without executing", async () => {
    const result = await handler.checkPreExecutionGates(
      "bash",
      { _raw: '{"command": "ls -' },
      makeContext({ trustClass: "guardian" }),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain("were not valid JSON");
    expect(result.result.content).toContain('{"command": "ls -');
    expect(result.result.content).toContain("Retry");

    expect(auditCalls.error).toHaveLength(1);
    expect(auditCalls.error[0].isExpected).toBe(true);
  });

  test("long raw args are truncated in the error message", async () => {
    const raw = `{"data": "${"x".repeat(500)}`;
    const result = await handler.checkPreExecutionGates(
      "bash",
      { _raw: raw },
      makeContext({ trustClass: "guardian" }),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    expect(result.result.content).not.toContain(raw);
    expect(result.result.content).toContain("…");
  });

  test("legitimate input containing a _raw field among others is not rejected", async () => {
    const result = await handler.checkPreExecutionGates(
      "bash",
      { _raw: "something", command: "ls" },
      makeContext({ trustClass: "guardian" }),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
  });

  test("non-string _raw value is not treated as the marker", async () => {
    const result = await handler.checkPreExecutionGates(
      "bash",
      { _raw: 42 },
      makeContext({ trustClass: "guardian" }),
      "low",
      Date.now(),
    );

    expect(result.allowed).toBe(true);
  });
});

afterAll(() => {
  mock.restore();
});
