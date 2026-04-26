/**
 * Tests for the non-guardian tool grant escalation path:
 *
 * 1. ToolApprovalHandler grant-miss escalation behavior
 * 2. tool_grant_request resolver registration and behavior
 * 3. Canonical decision primitive grant minting for tool_grant_request kind
 * 4. End-to-end: deny -> approve -> consume grant flow
 * 5. Inline wait-and-resume for trusted-contact grant-gated tools
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
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
    conversationId: "test-session",
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
import { getDb, initializeDb } from "../memory/db.js";
import { getSqlite } from "../memory/db-connection.js";
import { scopedApprovalGrants } from "../memory/schema.js";
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
  db.run("DELETE FROM conversations");
  // Insert conv-1 with host_access=0 (disabled) so trusted_contact host tools
  // hit the "computer access not enabled" gate.
  const now = Date.now();
  getSqlite().run(
    "INSERT INTO conversations (id, created_at, updated_at, host_access) VALUES (?, ?, ?, 0)",
    ["conv-1", now, now],
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: testDir,
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

  test("trusted_contact + host tool + no host_access is denied immediately (no escalation)", async () => {
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

    // Message should mention computer access, not a grant escalation
    expect(result.result.content).toContain("computer access is not enabled");

    // No canonical tool_grant_request should have been created — the
    // conversation-level host_access gate blocks before grant escalation.
    const requests = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(requests.length).toBe(0);

    // No notification signal emitted (no escalation created)
    expect(emittedSignals.length).toBe(0);
  });

  test("trusted_contact + host tool + no host_access: denial is immediate (no inline wait)", async () => {
    const toolName = "bash";
    const input = { command: "deploy" };

    const context = makeContext({ trustClass: "trusted_contact" });
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
    // Should be denied immediately — no inline wait is performed because the
    // host_access gate fires before any grant consumption attempt.
    expect(result.result.content).toContain("computer access is not enabled");
    expect(elapsed).toBeLessThan(500);
  });

  test("trusted_contact + host tool + no host_access: repeated calls all get immediate denial", async () => {
    const toolName = "bash";
    const input = { command: "rm -rf /" };

    const context = makeContext({ trustClass: "trusted_contact" });

    // First invocation
    const result1 = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );
    expect(result1.allowed).toBe(false);
    if (result1.allowed) return;
    expect(result1.result.content).toContain("computer access is not enabled");

    // Second invocation — same immediate denial, no canonical requests
    const result2 = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );

    expect(result2.allowed).toBe(false);
    if (result2.allowed) return;
    expect(result2.result.content).toContain("computer access is not enabled");

    // No canonical requests created at any point
    const requests = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(requests.length).toBe(0);
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

  test("trusted_contact without executionChannel gets computer-access denial for host tools", async () => {
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
    // Denied by conversation host_access gate — channel presence is irrelevant
    expect(result.result.content).toContain("computer access is not enabled");

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

  test("trusted_contact + host tool + host_access enabled -> allowed immediately", async () => {
    const toolName = "bash";
    const input = { command: "echo secret" };

    // Enable host_access for conv-1
    getSqlite().run(
      "UPDATE conversations SET host_access = 1 WHERE id = ?",
      ["conv-1"],
    );

    const context = makeContext({ trustClass: "trusted_contact" });
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

    // When host_access is enabled, trusted_contact is allowed immediately —
    // no grant consumption, no inline wait.
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    // No grant was consumed (trusted_contact bypasses per-invocation grant check)
    expect(result.grantConsumed).toBeUndefined();
    // Should be nearly instant
    expect(elapsed).toBeLessThan(500);

    // No notification signal emitted (no escalation)
    expect(emittedSignals.length).toBe(0);
  });

  test("waitForInlineGrant: approve-then-consume round-trip works correctly", async () => {
    // Test the grant lifecycle directly: create request, approve it, consume grant.
    const req = createCanonicalGuardianRequest({
      kind: "tool_grant_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      inputDigest: "sha256:roundtrip",
      expiresAt: Date.now() + 60_000,
    });

    // Schedule guardian approval after 50ms
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
        inputDigest: "sha256:roundtrip",
        consumingRequestId: "consume-roundtrip",
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

  test("waitForInlineGrant: guardian rejects -> outcome is denied", async () => {
    // Test rejection via the waitForInlineGrant primitive directly.
    const req = createCanonicalGuardianRequest({
      kind: "tool_grant_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      inputDigest: "sha256:reject-e2e",
      expiresAt: Date.now() + 60_000,
    });

    // Schedule rejection after 100ms
    const rejectionPromise = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      await applyCanonicalGuardianDecision({
        requestId: req.id,
        action: "reject",
        actorContext: guardianActor(),
      });
    })();

    const start = Date.now();
    const result = await waitForInlineGrant(
      req.id,
      {
        toolName: "bash",
        inputDigest: "sha256:reject-e2e",
        consumingRequestId: "consume-reject-e2e",
        conversationId: "conv-1",
        requesterExternalUserId: "requester-1",
        executionChannel: "telegram",
      },
      { maxWaitMs: 2_000, intervalMs: 20 },
    );
    const elapsed = Date.now() - start;

    await rejectionPromise;

    expect(result.outcome).toBe("denied");
    // Should exit well before the 2s timeout
    expect(elapsed).toBeLessThan(1_000);
  });

  test("waitForInlineGrant: abort signal cancels cleanly during wait", async () => {
    // Test abort via the waitForInlineGrant primitive directly.
    const req = createCanonicalGuardianRequest({
      kind: "tool_grant_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-1",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      inputDigest: "sha256:abort-e2e",
      expiresAt: Date.now() + 60_000,
    });

    const controller = new AbortController();
    // Abort after 100ms
    setTimeout(() => controller.abort(), 100);

    const start = Date.now();
    const result = await waitForInlineGrant(
      req.id,
      {
        toolName: "bash",
        inputDigest: "sha256:abort-e2e",
        consumingRequestId: "consume-abort-e2e",
      },
      { maxWaitMs: 5_000, intervalMs: 20, signal: controller.signal },
    );
    const elapsed = Date.now() - start;

    expect(result.outcome).toBe("aborted");
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
