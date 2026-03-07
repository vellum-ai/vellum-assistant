import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "approval-primitive-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  isDebug: () => false,
  truncateForLog: (value: string) => value,
}));

import {
  consumeGrantForInvocation,
  mintGrantFromDecision,
  type MintGrantParams,
} from "../approvals/approval-primitive.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { scopedApprovalGrants } from "../memory/schema.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";

initializeDb();

function clearTables(): void {
  const db = getDb();
  db.delete(scopedApprovalGrants).run();
}

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Helper to build mint params with sensible defaults
// ---------------------------------------------------------------------------

function mintParams(overrides: Partial<MintGrantParams> = {}): MintGrantParams {
  const futureExpiry = new Date(Date.now() + 60_000).toISOString();
  return {
    scopeMode: "request_id",
    requestChannel: "telegram",
    decisionChannel: "telegram",
    expiresAt: futureExpiry,
    ...overrides,
  };
}

// ===========================================================================
// MINT TESTS
// ===========================================================================

describe("approval-primitive / mintGrantFromDecision", () => {
  beforeEach(() => clearTables());

  test("mints a request_id scoped grant successfully", () => {
    const result = mintGrantFromDecision(
      mintParams({ scopeMode: "request_id", requestId: "req-1" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.status).toBe("active");
    expect(result.grant.requestId).toBe("req-1");
    expect(result.grant.scopeMode).toBe("request_id");
  });

  test("mints a tool_signature scoped grant successfully", () => {
    const digest = computeToolApprovalDigest("shell", { command: "ls" });
    const result = mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName: "shell",
        inputDigest: digest,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.toolName).toBe("shell");
    expect(result.grant.inputDigest).toBe(digest);
    expect(result.grant.scopeMode).toBe("tool_signature");
  });

  test("rejects request_id scope when requestId is missing", () => {
    const result = mintGrantFromDecision(
      mintParams({ scopeMode: "request_id", requestId: null }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_request_id");
  });

  test("rejects tool_signature scope when toolName is missing", () => {
    const result = mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName: null,
        inputDigest: "abc123",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_tool_fields");
  });

  test("rejects tool_signature scope when inputDigest is missing", () => {
    const result = mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName: "shell",
        inputDigest: null,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_tool_fields");
  });

  test("mints grant with full scope context fields", () => {
    const result = mintGrantFromDecision(
      mintParams({
        scopeMode: "request_id",
        requestId: "req-full",
        conversationId: "conv-1",
        callSessionId: "call-1",
        requesterExternalUserId: "user-1",
        guardianExternalUserId: "guardian-1",
        executionChannel: "voice",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.conversationId).toBe("conv-1");
    expect(result.grant.callSessionId).toBe("call-1");
    expect(result.grant.requesterExternalUserId).toBe("user-1");
    expect(result.grant.guardianExternalUserId).toBe("guardian-1");
    expect(result.grant.executionChannel).toBe("voice");
  });
});

// ===========================================================================
// CONSUME TESTS
// ===========================================================================

describe("approval-primitive / consumeGrantForInvocation", () => {
  beforeEach(() => clearTables());

  test("consumes a request_id grant when requestId matches", async () => {
    mintGrantFromDecision(
      mintParams({ scopeMode: "request_id", requestId: "req-100" }),
    );

    const result = await consumeGrantForInvocation({
      requestId: "req-100",
      toolName: "shell",
      inputDigest: computeToolApprovalDigest("shell", { command: "ls" }),
      consumingRequestId: "consumer-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.status).toBe("consumed");
    expect(result.grant.consumedByRequestId).toBe("consumer-1");
  });

  test("consumes a tool_signature grant when tool+input matches", async () => {
    const digest = computeToolApprovalDigest("shell", { command: "ls" });
    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName: "shell",
        inputDigest: digest,
      }),
    );

    const result = await consumeGrantForInvocation({
      toolName: "shell",
      inputDigest: digest,
      consumingRequestId: "consumer-2",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.status).toBe("consumed");
  });

  test("falls back to tool_signature when request_id does not match", async () => {
    const digest = computeToolApprovalDigest("shell", { command: "ls" });
    // Mint a tool_signature grant (not request_id)
    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName: "shell",
        inputDigest: digest,
      }),
    );

    const result = await consumeGrantForInvocation({
      requestId: "nonexistent-req",
      toolName: "shell",
      inputDigest: digest,
      consumingRequestId: "consumer-3",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.scopeMode).toBe("tool_signature");
  });

  // ---------------------------------------------------------------------------
  // Consume miss scenarios
  // ---------------------------------------------------------------------------

  test("miss: no grants exist at all", async () => {
    const result = await consumeGrantForInvocation(
      {
        toolName: "shell",
        inputDigest: computeToolApprovalDigest("shell", { command: "ls" }),
        consumingRequestId: "consumer-miss",
      },
      { maxWaitMs: 0 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_match");
  });

  test("miss: tool name mismatch", async () => {
    const digest = computeToolApprovalDigest("shell", { command: "ls" });
    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName: "shell",
        inputDigest: digest,
      }),
    );

    const result = await consumeGrantForInvocation(
      {
        toolName: "file_write",
        inputDigest: digest,
        consumingRequestId: "consumer-mismatch-tool",
      },
      { maxWaitMs: 0 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_match");
  });

  test("miss: input digest mismatch", async () => {
    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName: "shell",
        inputDigest: computeToolApprovalDigest("shell", { command: "ls" }),
      }),
    );

    const result = await consumeGrantForInvocation(
      {
        toolName: "shell",
        inputDigest: computeToolApprovalDigest("shell", {
          command: "rm -rf /",
        }),
        consumingRequestId: "consumer-mismatch-input",
      },
      { maxWaitMs: 0 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_match");
  });

  test("miss: grant expired", async () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    mintGrantFromDecision(
      mintParams({
        scopeMode: "request_id",
        requestId: "req-expired",
        expiresAt: pastExpiry,
      }),
    );

    const result = await consumeGrantForInvocation(
      {
        requestId: "req-expired",
        toolName: "shell",
        inputDigest: computeToolApprovalDigest("shell", {}),
        consumingRequestId: "consumer-expired",
      },
      { maxWaitMs: 0 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_match");
  });

  // ---------------------------------------------------------------------------
  // One-time consume semantics
  // ---------------------------------------------------------------------------

  test("one-time consume: second consume of the same grant fails", async () => {
    mintGrantFromDecision(
      mintParams({ scopeMode: "request_id", requestId: "req-once" }),
    );

    const first = await consumeGrantForInvocation({
      requestId: "req-once",
      toolName: "shell",
      inputDigest: computeToolApprovalDigest("shell", {}),
      consumingRequestId: "consumer-first",
    });
    expect(first.ok).toBe(true);

    const second = await consumeGrantForInvocation(
      {
        requestId: "req-once",
        toolName: "shell",
        inputDigest: computeToolApprovalDigest("shell", {}),
        consumingRequestId: "consumer-second",
      },
      { maxWaitMs: 0 },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("no_match");
  });

  test("one-time consume: tool_signature grant is consumed only once", async () => {
    const digest = computeToolApprovalDigest("shell", { command: "deploy" });
    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName: "shell",
        inputDigest: digest,
      }),
    );

    const first = await consumeGrantForInvocation({
      toolName: "shell",
      inputDigest: digest,
      consumingRequestId: "consumer-sig-first",
    });
    expect(first.ok).toBe(true);

    const second = await consumeGrantForInvocation(
      {
        toolName: "shell",
        inputDigest: digest,
        consumingRequestId: "consumer-sig-second",
      },
      { maxWaitMs: 0 },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("no_match");
  });

  // ---------------------------------------------------------------------------
  // Context-scoped consume
  // ---------------------------------------------------------------------------

  test("consumes tool_signature grant with matching conversation context", async () => {
    const digest = computeToolApprovalDigest("shell", { command: "test" });
    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName: "shell",
        inputDigest: digest,
        conversationId: "conv-ctx",
        callSessionId: "call-ctx",
      }),
    );

    const result = await consumeGrantForInvocation({
      toolName: "shell",
      inputDigest: digest,
      consumingRequestId: "consumer-ctx",
      conversationId: "conv-ctx",
      callSessionId: "call-ctx",
    });

    expect(result.ok).toBe(true);
  });

  test("miss: conversation context mismatch on tool_signature grant", async () => {
    const digest = computeToolApprovalDigest("shell", { command: "test" });
    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName: "shell",
        inputDigest: digest,
        conversationId: "conv-A",
      }),
    );

    const result = await consumeGrantForInvocation(
      {
        toolName: "shell",
        inputDigest: digest,
        consumingRequestId: "consumer-ctx-mismatch",
        conversationId: "conv-B",
      },
      { maxWaitMs: 0 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_match");
  });
});

// ===========================================================================
// RETRY POLLING TESTS
// ===========================================================================

describe("approval-primitive / consumeGrantForInvocation retry", () => {
  beforeEach(() => clearTables());

  test("succeeds immediately when grant already exists (no retry needed)", async () => {
    const digest = computeToolApprovalDigest("shell", { command: "ls" });
    mintGrantFromDecision(
      mintParams({
        scopeMode: "tool_signature",
        toolName: "shell",
        inputDigest: digest,
      }),
    );

    const start = Date.now();
    const result = await consumeGrantForInvocation({
      toolName: "shell",
      inputDigest: digest,
      consumingRequestId: "consumer-async-immediate",
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.status).toBe("consumed");
    // Should return nearly instantly — well under the retry interval
    expect(elapsed).toBeLessThan(200);
  });

  test("retries and succeeds when grant appears after a delay", async () => {
    const digest = computeToolApprovalDigest("shell", { command: "delayed" });

    // Mint the grant after 300ms — the async consumer should retry and find it
    setTimeout(() => {
      mintGrantFromDecision(
        mintParams({
          scopeMode: "tool_signature",
          toolName: "shell",
          inputDigest: digest,
        }),
      );
    }, 300);

    const start = Date.now();
    const result = await consumeGrantForInvocation(
      {
        toolName: "shell",
        inputDigest: digest,
        consumingRequestId: "consumer-async-delayed",
      },
      { maxWaitMs: 5_000, intervalMs: 100 },
    );
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.status).toBe("consumed");
    // Should have taken at least ~300ms (the delay) but less than the max wait
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5_000);
  });

  test("returns failure after timeout when no grant appears", async () => {
    const digest = computeToolApprovalDigest("shell", {
      command: "never-minted",
    });

    const start = Date.now();
    const result = await consumeGrantForInvocation(
      {
        toolName: "shell",
        inputDigest: digest,
        consumingRequestId: "consumer-async-timeout",
      },
      { maxWaitMs: 500, intervalMs: 100 },
    );
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_match");
    // Should have waited approximately the max wait time
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(1_500);
  });

  test("returns aborted when signal fires during retry polling", async () => {
    const digest = computeToolApprovalDigest("shell", { command: "aborted" });
    const controller = new AbortController();

    // Abort after 200ms — well before the 2s max wait
    setTimeout(() => controller.abort(), 200);

    const start = Date.now();
    const result = await consumeGrantForInvocation(
      {
        toolName: "shell",
        inputDigest: digest,
        consumingRequestId: "consumer-aborted",
      },
      { maxWaitMs: 2_000, intervalMs: 50, signal: controller.signal },
    );
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("aborted");
    // Should have exited shortly after the abort (200ms), not waited the full 2s
    expect(elapsed).toBeLessThan(1_000);
  });

  test("returns aborted immediately when signal is already aborted", async () => {
    const digest = computeToolApprovalDigest("shell", {
      command: "pre-aborted",
    });
    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    const result = await consumeGrantForInvocation(
      {
        toolName: "shell",
        inputDigest: digest,
        consumingRequestId: "consumer-pre-aborted",
      },
      { maxWaitMs: 2_000, intervalMs: 50, signal: controller.signal },
    );
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("aborted");
    // Should return nearly instantly since signal was already aborted
    expect(elapsed).toBeLessThan(200);
  });

  test("skips retry entirely when maxWaitMs is 0", async () => {
    const digest = computeToolApprovalDigest("shell", { command: "no-retry" });

    const start = Date.now();
    const result = await consumeGrantForInvocation(
      {
        toolName: "shell",
        inputDigest: digest,
        consumingRequestId: "consumer-no-retry",
      },
      { maxWaitMs: 0 },
    );
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_match");
    // Should return nearly instantly — no retry loop
    expect(elapsed).toBeLessThan(100);
  });
});
