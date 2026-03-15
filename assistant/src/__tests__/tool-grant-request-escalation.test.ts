/**
 * Tests for the non-guardian tool grant escalation path:
 *
 * 1. ToolApprovalHandler grant-miss escalation behavior
 * 2. tool_grant_request resolver registration and behavior
 * 3. Canonical decision primitive grant minting for tool_grant_request kind
 * 4. End-to-end: deny -> approve -> consume grant flow
 * 5. Inline wait-and-resume for trusted-contact grant-gated tools
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "tool-grant-escalation-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
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
  truncateForLog: (value: string) => value,
}));

// Mock guardian control-plane policy — not targeting control-plane by default
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
  getDefinition: () => ({
    name: "bash",
    description: "Run a shell command",
    input_schema: {},
  }),
  execute: async () => ({ content: "ok", isError: false }),
};

mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => (name === "bash" ? fakeTool : undefined),
  getAllTools: () => [fakeTool],
}));

// Mock notification emission — capture calls without running the full pipeline
const emittedSignals: Array<Record<string, unknown>> = [];
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emittedSignals.push(params);
    return {
      signalId: "test-signal",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
    };
  },
  registerBroadcastFn: () => {},
}));

// Mock channel guardian service — provide a guardian binding for 'self' + 'telegram'
mock.module("../runtime/channel-verification-service.js", () => ({
  getGuardianBinding: (assistantId: string, channel: string) => {
    if (assistantId === "self" && channel === "telegram") {
      return {
        id: "binding-1",
        assistantId: "self",
        channel: "telegram",
        guardianExternalUserId: "guardian-1",
        guardianDeliveryChatId: "guardian-chat-1",
        guardianPrincipalId: "test-principal-id",
        status: "active",
      };
    }
    return null;
  },
  createOutboundSession: () => ({
    sessionId: "test-session",
    secret: "123456",
  }),
}));

// Mock gateway client — capture delivery calls
const deliveredReplies: Array<{ chatId: string; text: string }> = [];
mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (
    _url: string,
    payload: { chatId: string; text: string },
  ) => {
    deliveredReplies.push(payload);
  },
}));

import { applyCanonicalGuardianDecision } from "../approvals/guardian-decision-primitive.js";
import type { ActorContext } from "../approvals/guardian-request-resolvers.js";
import {
  getRegisteredKinds,
  getResolver,
} from "../approvals/guardian-request-resolvers.js";
import {
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
} from "../memory/canonical-guardian-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { scopedApprovalGrants } from "../memory/schema.js";
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";
import {
  ToolApprovalHandler,
  waitForInlineGrant,
} from "../tools/tool-approval-handler.js";
import type { ToolContext, ToolLifecycleEvent } from "../tools/types.js";

/** Short wait config for tests — avoids blocking test suite on the 60s default. */
const TEST_INLINE_WAIT_CONFIG = { maxWaitMs: 100, intervalMs: 20 };

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.delete(scopedApprovalGrants).run();
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM canonical_guardian_requests");
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
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: testDir,
    sessionId: "session-1",
    conversationId: "conv-1",
    assistantId: "self",
    requestId: "req-1",
    trustClass: "trusted_contact",
    executionChannel: "telegram",
    requesterExternalUserId: "requester-1",
    ...overrides,
  };
}

function guardianActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    actorPrincipalId: "test-principal-id",
    actorExternalUserId: "guardian-1",
    channel: "telegram",
    guardianPrincipalId: "test-principal-id",
    ...overrides,
  };
}

// ===========================================================================
// TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. tool_grant_request resolver registration
// ---------------------------------------------------------------------------

describe("tool_grant_request resolver registration", () => {
  test("tool_grant_request resolver is registered", () => {
    const kinds = getRegisteredKinds();
    expect(kinds).toContain("tool_grant_request");
  });

  test("getResolver returns resolver for tool_grant_request", () => {
    const resolver = getResolver("tool_grant_request");
    expect(resolver).toBeDefined();
    expect(resolver!.kind).toBe("tool_grant_request");
  });
});

// ---------------------------------------------------------------------------
// 2. Grant-miss escalation behavior in ToolApprovalHandler
// ---------------------------------------------------------------------------

describe("ToolApprovalHandler / grant-miss escalation", () => {
  const handler = new ToolApprovalHandler({
    inlineGrantWait: TEST_INLINE_WAIT_CONFIG,
  });
  const events: ToolLifecycleEvent[] = [];
  const emitLifecycleEvent = (event: ToolLifecycleEvent) => {
    events.push(event);
  };

  beforeEach(() => {
    resetTables();
    events.length = 0;
    emittedSignals.length = 0;
    deliveredReplies.length = 0;
  });

  test("non-guardian + grant miss + host tool creates canonical tool_grant_request", async () => {
    const toolName = "bash";
    const input = { command: "cat /etc/passwd" };

    const context = makeContext({ trustClass: "trusted_contact" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;

    // A canonical tool_grant_request should have been created
    const requests = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(requests.length).toBe(1);
    expect(requests[0].toolName).toBe("bash");
    expect(requests[0].requesterExternalUserId).toBe("requester-1");
    expect(requests[0].guardianExternalUserId).toBe("guardian-1");

    // Notification signal should have been emitted
    expect(emittedSignals.length).toBe(1);
    expect(emittedSignals[0].sourceEventName).toBe("guardian.question");
    const payload = emittedSignals[0].contextPayload as Record<string, unknown>;
    expect(payload.requestKind).toBe("tool_grant_request");
  });

  test("non-guardian grant-miss response includes request code after timeout", async () => {
    const toolName = "bash";
    const input = { command: "deploy" };

    const context = makeContext({ trustClass: "trusted_contact" });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    // After inline wait times out, the message should include the request code
    // and indicate the guardian did not approve in time.
    expect(result.result.content).toContain(
      "guardian approval was not received in time",
    );
    expect(result.result.content).toContain("request code:");
  });

  test("non-guardian duplicate grant-miss deduplicates the request", async () => {
    const toolName = "bash";
    const input = { command: "rm -rf /" };

    const context = makeContext({ trustClass: "trusted_contact" });

    // First invocation creates the request (and waits, then times out)
    await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );

    const firstRequests = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(firstRequests.length).toBe(1);

    // Reset notification tracking
    emittedSignals.length = 0;

    // Second invocation with same tool+input deduplicates (reuses the request, waits, times out)
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    // Both calls get the timeout message since inline wait now runs for deduped requests too
    expect(result.result.content).toContain(
      "guardian approval was not received in time",
    );

    // Still only one canonical request
    const requests = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(requests.length).toBe(1);

    // No duplicate notification
    expect(emittedSignals.length).toBe(0);
  });

  test("unverified_channel does NOT create escalation request", async () => {
    const toolName = "bash";
    const input = { command: "ls" };

    const context = makeContext({
      trustClass: "unknown",
      executionChannel: "telegram",
      requesterExternalUserId: "unknown-user",
    });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    // Should get the generic denial message, not escalation
    expect(result.result.content).toContain("verified channel identity");

    // No canonical request should have been created
    const requests = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(requests.length).toBe(0);
  });

  test("non-guardian without executionChannel falls back to generic denial", async () => {
    const toolName = "bash";
    const input = { command: "deploy" };

    const context = makeContext({
      trustClass: "trusted_contact",
      executionChannel: undefined, // no channel info
    });
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    // Generic denial, no escalation attempted
    expect(result.result.content).toContain("guardian approval");
    expect(result.result.content).not.toContain("request has been sent");

    const requests = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(requests.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Canonical decision and grant minting for tool_grant_request kind
// ---------------------------------------------------------------------------

describe("applyCanonicalGuardianDecision / tool_grant_request", () => {
  beforeEach(() => {
    resetTables();
    deliveredReplies.length = 0;
  });

  test("approving tool_grant_request with tool metadata mints a grant", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_grant_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      inputDigest: "sha256:testdigest",
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.grantMinted).toBe(true);

    // Verify canonical request is approved
    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("approved");
    expect(resolved!.decidedByExternalUserId).toBe("guardian-1");
  });

  test("rejecting tool_grant_request does NOT mint a grant", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_grant_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      inputDigest: "sha256:testdigest",
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "reject",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.grantMinted).toBe(false);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe("denied");
  });

  test("identity mismatch blocks tool_grant_request approval", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_grant_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      inputDigest: "sha256:testdigest",
      expiresAt: Date.now() + 60_000,
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor({
        guardianPrincipalId: "imposter-principal",
      }),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe("identity_mismatch");

    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end: deny -> approve -> consume grant flow
// ---------------------------------------------------------------------------

describe("end-to-end: tool grant escalation -> approval -> consume", () => {
  // Use a wider wait window so the delayed guardian approval arrives in time
  const handler = new ToolApprovalHandler({
    inlineGrantWait: { maxWaitMs: 2_000, intervalMs: 20 },
  });
  const events: ToolLifecycleEvent[] = [];
  const emitLifecycleEvent = (event: ToolLifecycleEvent) => {
    events.push(event);
  };

  beforeEach(() => {
    resetTables();
    events.length = 0;
    emittedSignals.length = 0;
  });

  test("inline wait: guardian approves during wait -> tool proceeds inline", async () => {
    const toolName = "bash";
    const input = { command: "echo secret" };
    const _inputDigest = computeToolApprovalDigest(toolName, input);

    const context = makeContext({ trustClass: "trusted_contact" });

    // Schedule guardian approval after 100ms — within the 2s wait window.
    // The approval happens asynchronously while checkPreExecutionGates is
    // polling for the grant.
    const approvalPromise = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      const pendingRequests = listCanonicalGuardianRequests({
        kind: "tool_grant_request",
        status: "pending",
        toolName: "bash",
      });
      if (pendingRequests.length === 0) return;
      await applyCanonicalGuardianDecision({
        requestId: pendingRequests[0].id,
        action: "approve_once",
        actorContext: guardianActor(),
      });
    })();

    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );

    await approvalPromise;

    // The tool invocation should have succeeded inline
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.grantConsumed).toBe(true);

    // Replay is denied (one-time grant semantics)
    const replayResult = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );
    expect(replayResult.allowed).toBe(false);
  });

  test("pre-existing grant from prior approval is consumed immediately (no wait)", async () => {
    const toolName = "bash";
    const input = { command: "echo secret" };
    const _inputDigest = computeToolApprovalDigest(toolName, input);

    const context = makeContext({ trustClass: "trusted_contact" });

    // Step 1: First invocation times out (short wait, no approval)
    const shortHandler = new ToolApprovalHandler({
      inlineGrantWait: TEST_INLINE_WAIT_CONFIG,
    });
    await shortHandler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );

    // Verify request was created
    const pendingRequests = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
      status: "pending",
      toolName: "bash",
    });
    expect(pendingRequests.length).toBe(1);

    // Step 2: Guardian approves the request (mints a grant)
    const approvalResult = await applyCanonicalGuardianDecision({
      requestId: pendingRequests[0].id,
      action: "approve_once",
      actorContext: guardianActor(),
    });
    expect(approvalResult.applied).toBe(true);

    // Step 3: Second invocation finds the pre-existing grant immediately
    const start = Date.now();
    const secondResult = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );
    const elapsed = Date.now() - start;

    expect(secondResult.allowed).toBe(true);
    if (!secondResult.allowed) return;
    expect(secondResult.grantConsumed).toBe(true);
    // Should be nearly instant since the grant already exists
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// 5. Inline wait-and-resume for trusted-contact grant-gated tools
// ---------------------------------------------------------------------------

describe("inline wait-and-resume", () => {
  const events: ToolLifecycleEvent[] = [];
  const emitLifecycleEvent = (event: ToolLifecycleEvent) => {
    events.push(event);
  };

  beforeEach(() => {
    resetTables();
    events.length = 0;
    emittedSignals.length = 0;
    deliveredReplies.length = 0;
  });

  test("waitForInlineGrant returns granted when grant appears during wait", async () => {
    // Create a canonical request manually
    const req = createCanonicalGuardianRequest({
      kind: "tool_grant_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      inputDigest: "sha256:waitgrant",
      expiresAt: Date.now() + 60_000,
    });

    // Schedule approval after 50ms
    setTimeout(async () => {
      await applyCanonicalGuardianDecision({
        requestId: req.id,
        action: "approve_once",
        actorContext: guardianActor(),
      });
    }, 50);

    const result = await waitForInlineGrant(
      req.id,
      {
        toolName: "bash",
        inputDigest: "sha256:waitgrant",
        consumingRequestId: "consume-1",
        conversationId: "conv-1",
        requesterExternalUserId: "requester-1",
        executionChannel: "telegram",
      },
      { maxWaitMs: 2_000, intervalMs: 20 },
    );

    expect(result.outcome).toBe("granted");
    if (result.outcome === "granted") {
      expect(result.grant.id).toBeDefined();
    }
  });

  test("waitForInlineGrant returns denied when guardian rejects during wait", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_grant_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      inputDigest: "sha256:denywait",
      expiresAt: Date.now() + 60_000,
    });

    // Schedule rejection after 50ms
    setTimeout(async () => {
      await applyCanonicalGuardianDecision({
        requestId: req.id,
        action: "reject",
        actorContext: guardianActor(),
      });
    }, 50);

    const result = await waitForInlineGrant(
      req.id,
      {
        toolName: "bash",
        inputDigest: "sha256:denywait",
        consumingRequestId: "consume-1",
      },
      { maxWaitMs: 2_000, intervalMs: 20 },
    );

    expect(result.outcome).toBe("denied");
    if (result.outcome === "denied") {
      expect(result.requestId).toBe(req.id);
    }
  });

  test("waitForInlineGrant returns timeout when no decision arrives", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_grant_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      inputDigest: "sha256:timeoutwait",
      expiresAt: Date.now() + 60_000,
    });

    const start = Date.now();
    const result = await waitForInlineGrant(
      req.id,
      {
        toolName: "bash",
        inputDigest: "sha256:timeoutwait",
        consumingRequestId: "consume-1",
      },
      { maxWaitMs: 100, intervalMs: 20 },
    );
    const elapsed = Date.now() - start;

    expect(result.outcome).toBe("timeout");
    if (result.outcome === "timeout") {
      expect(result.requestId).toBe(req.id);
    }
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(500);
  });

  test("waitForInlineGrant returns aborted when signal fires during wait", async () => {
    const req = createCanonicalGuardianRequest({
      kind: "tool_grant_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      inputDigest: "sha256:abortwait",
      expiresAt: Date.now() + 60_000,
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const start = Date.now();
    const result = await waitForInlineGrant(
      req.id,
      {
        toolName: "bash",
        inputDigest: "sha256:abortwait",
        consumingRequestId: "consume-1",
      },
      { maxWaitMs: 5_000, intervalMs: 20, signal: controller.signal },
    );
    const elapsed = Date.now() - start;

    expect(result.outcome).toBe("aborted");
    expect(elapsed).toBeLessThan(500);
  });

  test("inline wait: guardian rejects -> handler returns explicit denial", async () => {
    const handler = new ToolApprovalHandler({
      inlineGrantWait: { maxWaitMs: 2_000, intervalMs: 20 },
    });

    const toolName = "bash";
    const input = { command: "rm -rf /" };
    const context = makeContext({ trustClass: "trusted_contact" });

    // Schedule rejection after 100ms
    const rejectionPromise = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      const pending = listCanonicalGuardianRequests({
        kind: "tool_grant_request",
        status: "pending",
        toolName: "bash",
      });
      if (pending.length === 0) return;
      await applyCanonicalGuardianDecision({
        requestId: pending[0].id,
        action: "reject",
        actorContext: guardianActor(),
      });
    })();

    const start = Date.now();
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );
    const elapsed = Date.now() - start;

    await rejectionPromise;

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.result.content).toContain("guardian rejected the request");
    // Should exit well before the 2s timeout
    expect(elapsed).toBeLessThan(1_000);
  });

  test("inline wait: abort signal cancels cleanly during wait", async () => {
    const handler = new ToolApprovalHandler({
      inlineGrantWait: { maxWaitMs: 5_000, intervalMs: 20 },
    });

    const toolName = "bash";
    const input = { command: "do something" };
    const controller = new AbortController();
    const context = makeContext({
      trustClass: "trusted_contact",
      signal: controller.signal,
    });

    // Abort after 100ms
    setTimeout(() => controller.abort(), 100);

    const start = Date.now();
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );
    const elapsed = Date.now() - start;

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.result.content).toBe("Cancelled");
    expect(result.result.isError).toBe(true);
    expect(elapsed).toBeLessThan(1_000);
  });

  test("unknown/unverified actors do NOT get inline wait behavior", async () => {
    const handler = new ToolApprovalHandler({
      inlineGrantWait: { maxWaitMs: 2_000, intervalMs: 20 },
    });

    const toolName = "bash";
    const input = { command: "ls" };
    const context = makeContext({
      trustClass: "unknown",
      executionChannel: "telegram",
      requesterExternalUserId: "unknown-user",
    });

    const start = Date.now();
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );
    const elapsed = Date.now() - start;

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    // Unknown actors get the generic fail-closed message, not the wait behavior
    expect(result.result.content).toContain("verified channel identity");
    // Should be near-instant, no waiting
    expect(elapsed).toBeLessThan(200);

    // No canonical request created
    const requests = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(requests.length).toBe(0);
  });
});
