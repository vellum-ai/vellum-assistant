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
  input_schema: {},
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
}));

// Gateway session client — the resolver mints verification sessions here.
mock.module("../channels/gateway-verification-sessions.js", () => ({
  createOutboundSession: async () => ({
    sessionId: "test-session",
    secret: "123456",
    challengeHash: "hash",
    expiresAt: Date.now() + 600_000,
    ttlSeconds: 600,
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

// Grant escalation creates AND decides its guardian request through the
// gateway client; the sim serves that whole surface.
import { createGuardianGatewaySim } from "./guardian-gateway-sim.js";

const sim = createGuardianGatewaySim();
mock.module("../channels/gateway-guardian-requests.js", () => sim.module);

import { applyGuardianDecision } from "../approvals/guardian-decision-primitive.js";
import type { ActorContext } from "../approvals/guardian-request-resolvers.js";
import {
  getRegisteredKinds,
  getResolver,
} from "../approvals/guardian-request-resolvers.js";
import { getDb } from "../persistence/db-connection.js";
import { getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { scopedApprovalGrants } from "../persistence/schema/index.js";
import {
  ToolApprovalHandler,
  waitForInlineGrant,
} from "../tools/tool-approval-handler.js";
import type { ToolContext } from "../tools/types.js";

/** Short wait config for tests — avoids blocking test suite on the 60s default. */
const TEST_INLINE_WAIT_CONFIG = { maxWaitMs: 100, intervalMs: 20 };

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.delete(scopedApprovalGrants).run();
  db.run("DELETE FROM conversations");
  sim.reset();
  const now = Date.now();
  getSqlite().run(
    "INSERT INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)",
    ["conv-1", now, now],
  );
}

/** Seed a pending tool_grant_request in the gateway sim. */
function seedGrantRequest(inputDigest: string) {
  return sim.seedRequest({
    kind: "tool_grant_request",
    sourceChannel: "telegram",
    sourceConversationId: "conv-1",
    requesterExternalUserId: "requester-1",
    guardianExternalUserId: "guardian-1",
    guardianPrincipalId: "test-principal-id",
    toolName: "bash",
    inputDigest,
    expiresAt: Date.now() + 60_000,
  });
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

  beforeEach(() => {
    resetTables();
    emittedSignals.length = 0;
    deliveredReplies.length = 0;
  });

  test("escalation copy is tool-framed — identity appears only as context", async () => {
    const context = makeContext({
      trustClass: "trusted_contact",
      requesterDisplayName: "Bob",
    });
    const result = await handler.checkPreExecutionGates(
      "bash",
      { command: "ls -la" },
      context,
      "high",
      Date.now(),
    );

    // Trusted contact with a guardian binding: an escalation request is
    // created, the short inline wait times out, and the invocation is denied.
    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }

    // The guardian-facing question asks about the tool, never about the person.
    expect(emittedSignals.length).toBe(1);
    const payload = emittedSignals[0].contextPayload as Record<string, unknown>;
    const questionText = payload.questionText as string;
    expect(questionText.startsWith("Approve tool: bash")).toBe(true);
    // Requester identity is context, not the subject of the question.
    expect(questionText).toContain("(requested by Bob)");
    expect(questionText).not.toMatch(/wants to use/i);
    expect(questionText).not.toMatch(/is requesting/i);

    // Denial copy is about the tool, not about actor identity.
    expect(result.result.content).toContain(`Permission denied for "bash"`);
    expect(result.result.content).toContain("guardian approval");
    expect(result.result.content).not.toMatch(/actor/i);
    expect(result.result.content).not.toMatch(/not the guardian/i);
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
      "high",
      Date.now(),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    // Should get the generic denial message, not escalation
    expect(result.result.content).toContain("verified channel identity");

    // No guardian request should have been created
    const requests = await sim.module.listGuardianRequestsOrEmpty({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(requests.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Canonical decision and grant minting for tool_grant_request kind
// ---------------------------------------------------------------------------

describe("applyGuardianDecision / tool_grant_request", () => {
  beforeEach(() => {
    resetTables();
    deliveredReplies.length = 0;
  });

  test("approving tool_grant_request with tool metadata mints a grant", async () => {
    const req = seedGrantRequest("sha256:testdigest");

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) {
      return;
    }
    expect(result.grantMinted).toBe(true);

    // Verify guardian request is approved
    const resolved = sim.getRequest(req.id);
    expect(resolved!.status).toBe("approved");
    expect(resolved!.decidedByExternalUserId).toBe("guardian-1");
  });

  test("rejecting tool_grant_request does NOT mint a grant", async () => {
    const req = seedGrantRequest("sha256:testdigest");

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "reject",
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) {
      return;
    }
    expect(result.grantMinted).toBe(false);

    const resolved = sim.getRequest(req.id);
    expect(resolved!.status).toBe("denied");
  });

  test("identity mismatch blocks tool_grant_request approval", async () => {
    const req = seedGrantRequest("sha256:testdigest");

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor({
        guardianPrincipalId: "imposter-principal",
      }),
    });

    expect(result.applied).toBe(false);
    if (result.applied) {
      return;
    }
    expect(result.reason).toBe("identity_mismatch");

    const unchanged = sim.getRequest(req.id);
    expect(unchanged!.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end: deny -> approve -> consume grant flow
// ---------------------------------------------------------------------------

describe("end-to-end: tool grant escalation -> approval -> consume", () => {
  beforeEach(() => {
    resetTables();
    emittedSignals.length = 0;
  });

  test("waitForInlineGrant: approve-then-consume round-trip works correctly", async () => {
    // Test the grant lifecycle directly: create request, approve it, consume grant.
    const req = seedGrantRequest("sha256:roundtrip");

    // Schedule guardian approval after 50ms
    setTimeout(async () => {
      await applyGuardianDecision({
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
  beforeEach(() => {
    resetTables();
    emittedSignals.length = 0;
    deliveredReplies.length = 0;
  });

  test("waitForInlineGrant returns granted when grant appears during wait", async () => {
    // Create a guardian request manually
    const req = seedGrantRequest("sha256:waitgrant");

    // Schedule approval after 50ms
    setTimeout(async () => {
      await applyGuardianDecision({
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
    const req = seedGrantRequest("sha256:denywait");

    // Schedule rejection after 50ms
    setTimeout(async () => {
      await applyGuardianDecision({
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
    const req = seedGrantRequest("sha256:timeoutwait");

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
    const req = seedGrantRequest("sha256:abortwait");

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
    const req = seedGrantRequest("sha256:reject-e2e");

    // Schedule rejection after 100ms
    const rejectionPromise = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      await applyGuardianDecision({
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
    const req = seedGrantRequest("sha256:abort-e2e");

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
      "high",
      Date.now(),
    );
    const elapsed = Date.now() - start;

    expect(result.allowed).toBe(false);
    if (result.allowed) {
      return;
    }
    // Unknown actors get the generic fail-closed message, not the wait behavior
    expect(result.result.content).toContain("verified channel identity");
    // Should be near-instant, no waiting
    expect(elapsed).toBeLessThan(200);

    // No guardian request created
    const requests = await sim.module.listGuardianRequestsOrEmpty({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(requests.length).toBe(0);
  });
});
