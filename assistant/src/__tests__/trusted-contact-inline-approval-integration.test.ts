/**
 * End-to-end integration tests for the trusted-contact inline guardian approval feature.
 *
 * Verifies the full integration of M1-M4 milestones:
 *   M1: RoutingState (trust-context-resolver.ts)
 *   M2: Confirmation request guardian bridge (confirmation-request-guardian-bridge.ts)
 *   M3: Pending approval notifier (inbound-message-handler.ts)
 *   M4: Inline grant wait-and-resume (tool-approval-handler.ts) +
 *       staleness guard (guardian-request-resolvers.ts)
 *
 * Covered UX flows:
 *   a. Target flow: trusted contact -> guardian-gated action -> pending msg -> guardian approves -> tool executes
 *   b. Prompt-path flow: confirmation_request bridges to guardian notification and resumes
 *   c. No-binding flow: trusted contact without guardian binding fails fast (no dead-end wait)
 *   d. Unknown actor flow: remains fail-closed (no interactive approval)
 *   e. Guardian-only prompt delivery invariant: non-guardian never receives approval prompt UI
 *   f. Timeout/stale flow: guardian decision after prompt timeout produces deterministic outcome
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "tc-inline-approval-integration-"));

// ---------------------------------------------------------------------------
// Mocks — must be set before any production imports
// ---------------------------------------------------------------------------

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  getRootDir: () => testDir,
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

// Mock notification emission — capture calls
const emittedSignals: Array<Record<string, unknown>> = [];
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emittedSignals.push(params);
    return {
      signalId: "test-signal",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [
        { channel: "telegram", destination: "guardian-chat-1", success: true },
      ],
    };
  },
  registerBroadcastFn: () => {},
}));

// Mock guardian control-plane policy — not targeting control-plane by default
mock.module("../tools/verification-control-plane-policy.js", () => ({
  enforceVerificationControlPlanePolicy: () => ({ denied: false }),
}));

// Mock task run rules
mock.module("../tasks/ephemeral-permissions.js", () => ({
  getTaskRunRules: () => [],
}));

// Mock tool registry — provide a fake 'bash' tool
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

// Mock channel guardian service — configurable per test
let mockGuardianBinding: Record<string, unknown> | null = {
  id: "binding-1",
  assistantId: "self",
  channel: "telegram",
  guardianExternalUserId: "guardian-1",
  guardianDeliveryChatId: "guardian-chat-1",
  guardianPrincipalId: "test-principal-id",
  status: "active",
};

mock.module("../runtime/channel-verification-service.js", () => ({
  getGuardianBinding: (assistantId: string, channel: string) => {
    if (
      assistantId === "self" &&
      channel === "telegram" &&
      mockGuardianBinding
    ) {
      return mockGuardianBinding;
    }
    return null;
  },
  createOutboundSession: () => ({
    conversationId: "test-session",
    secret: "123456",
  }),
  bindSessionIdentity: () => {},
  findActiveSession: () => null,
  getPendingSession: () => null,
  isGuardian: () => false,
  resolveBootstrapToken: () => null,
  updateSessionDelivery: () => {},
  updateSessionStatus: () => {},
  validateAndConsumeVerification: () => ({
    success: false,
    reason: "no_challenge",
  }),
}));

// Mock gateway client — capture delivery calls
const deliveredReplies: Array<{
  url: string;
  payload: Record<string, unknown>;
  bearerToken?: string;
}> = [];
mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (
    url: string,
    payload: Record<string, unknown>,
    bearerToken?: string,
  ) => {
    deliveredReplies.push({ url, payload, bearerToken });
    return { ok: true };
  },
}));

// Mock pending interactions (channel-approvals)
let mockPendingApprovals: Array<{
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: string;
}> = [];

mock.module("../runtime/channel-approvals.js", () => ({
  getApprovalInfoByConversation: () => mockPendingApprovals,
  getChannelApprovalPrompt: () => null,
  buildApprovalUIMetadata: () => ({}),
  handleChannelDecision: () => ({ applied: false }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://localhost:3000",
}));

// ---------------------------------------------------------------------------
// Production imports (AFTER mocks)
// ---------------------------------------------------------------------------

import { applyCanonicalGuardianDecision } from "../approvals/guardian-decision-primitive.js";
import type { ActorContext } from "../approvals/guardian-request-resolvers.js";
import { getResolver } from "../approvals/guardian-request-resolvers.js";
import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import {
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
  updateCanonicalGuardianRequest,
} from "../memory/canonical-guardian-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { scopedApprovalGrants } from "../memory/schema.js";
import { bridgeConfirmationRequestToGuardian } from "../runtime/confirmation-request-guardian-bridge.js";
import { resolveRoutingState } from "../runtime/trust-context-resolver.js";
import {
  TC_GRANT_WAIT_MAX_MS,
  ToolApprovalHandler,
} from "../tools/tool-approval-handler.js";
import type { ToolContext, ToolLifecycleEvent } from "../tools/types.js";

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

function makeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
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

function makeTrustedContactTrustContext(): TrustContext {
  return {
    sourceChannel: "telegram",
    trustClass: "trusted_contact",
    guardianExternalUserId: "guardian-1",
    guardianChatId: "guardian-chat-1",
    requesterExternalUserId: "requester-1",
    requesterChatId: "requester-chat-1",
    requesterIdentifier: "@requester",
  };
}

const events: ToolLifecycleEvent[] = [];
const emitLifecycleEvent = (event: ToolLifecycleEvent) => {
  events.push(event);
};

// ===========================================================================
// a. Target flow: trusted contact -> guardian-gated tool -> approve -> execute
// ===========================================================================

describe("(a) target flow: trusted-contact inline guardian approval end-to-end", () => {
  const handler = new ToolApprovalHandler({
    inlineGrantWait: { maxWaitMs: 2_000, intervalMs: 20 },
  });

  beforeEach(() => {
    resetTables();
    events.length = 0;
    emittedSignals.length = 0;
    deliveredReplies.length = 0;
    mockGuardianBinding = {
      id: "binding-1",
      assistantId: "self",
      channel: "telegram",
      guardianExternalUserId: "guardian-1",
      guardianDeliveryChatId: "guardian-chat-1",
      guardianPrincipalId: "test-principal-id",
      status: "active",
    };
  });

  test("trusted contact requests tool, guardian approves mid-wait, tool executes inline", async () => {
    const toolName = "bash";
    const input = { command: "echo hello" };
    const context = makeToolContext({ trustClass: "trusted_contact" });

    // Schedule guardian approval after 100ms during the inline wait
    const approvalPromise = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      const pending = listCanonicalGuardianRequests({
        kind: "tool_grant_request",
        status: "pending",
        toolName: "bash",
      });
      expect(pending.length).toBeGreaterThan(0);

      // Verify the request has an inline_wait_active stamp
      const freshReq = getCanonicalGuardianRequest(pending[0].id);
      expect(freshReq?.followupState).toMatch(/^inline_wait_active:\d+$/);

      await applyCanonicalGuardianDecision({
        requestId: pending[0].id,
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

    // Tool execution should proceed inline
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.grantConsumed).toBe(true);

    // followupState should be cleared after a successful inline grant
    const resolved = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
    });
    expect(resolved.length).toBe(1);
    const freshReq = getCanonicalGuardianRequest(resolved[0].id);
    expect(freshReq?.followupState).toBeNull();

    // A guardian.question notification should have been emitted
    const questionSignals = emittedSignals.filter(
      (s) => s.sourceEventName === "guardian.question",
    );
    expect(questionSignals.length).toBeGreaterThan(0);
  });

  test("complete flow: routing state allows interactive + bridge notifies guardian + tool resumes", async () => {
    // Step 1: Verify routing state allows interactive turns for trusted contacts
    const trustCtx: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "trusted_contact",
      guardianExternalUserId: "guardian-1",
      guardianChatId: "guardian-chat-1",
    };
    const routing = resolveRoutingState(trustCtx);
    expect(routing.promptWaitingAllowed).toBe(true);
    expect(routing.guardianRouteResolvable).toBe(true);

    // Step 2: Tool invocation creates escalation + waits inline + guardian approves
    const toolName = "bash";
    const input = { command: "deploy" };
    const context = makeToolContext({ trustClass: "trusted_contact" });

    const approvalPromise = (async () => {
      await new Promise((r) => setTimeout(r, 80));
      const pending = listCanonicalGuardianRequests({
        kind: "tool_grant_request",
        status: "pending",
      });
      if (pending.length > 0) {
        await applyCanonicalGuardianDecision({
          requestId: pending[0].id,
          action: "approve_once",
          actorContext: guardianActor(),
        });
      }
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

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.grantConsumed).toBe(true);
  });
});

// ===========================================================================
// b. Prompt-path flow: confirmation_request bridges to guardian notification
// ===========================================================================

describe("(b) prompt-path flow: confirmation_request bridges to guardian", () => {
  beforeEach(() => {
    resetTables();
    emittedSignals.length = 0;
    mockGuardianBinding = {
      id: "binding-1",
      assistantId: "self",
      channel: "telegram",
      guardianExternalUserId: "guardian-1",
      guardianDeliveryChatId: "guardian-chat-1",
      guardianPrincipalId: "test-principal-id",
      status: "active",
    };
  });

  test("trusted-contact confirmation_request emits guardian.question and creates delivery records", () => {
    const canonicalRequest = createCanonicalGuardianRequest({
      id: `req-bridge-${Date.now()}`,
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-bridge-1",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      status: "pending",
      expiresAt: Date.now() + 5 * 60_000,
    });

    const trustContext = makeTrustedContactTrustContext();

    const result = bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-bridge-1",
      toolName: "bash",
    });

    expect("bridged" in result && result.bridged).toBe(true);

    // guardian.question notification was emitted
    expect(emittedSignals.length).toBeGreaterThan(0);
    expect(emittedSignals[0].sourceEventName).toBe("guardian.question");

    const payload = emittedSignals[0].contextPayload as Record<string, unknown>;
    expect(payload.requestId).toBe(canonicalRequest.id);
    expect(payload.toolName).toBe("bash");
    expect(payload.requesterIdentifier).toBe("@requester");
  });

  test("bridge + tool_grant_request both use guardian.question for unified routing", () => {
    // The confirmation_request bridge and tool_grant_request helper both
    // use 'guardian.question' as the notification signal, ensuring consistent
    // guardian routing regardless of the approval path.
    const canonicalRequest = createCanonicalGuardianRequest({
      id: `req-unified-${Date.now()}`,
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-unified-1",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      status: "pending",
      expiresAt: Date.now() + 5 * 60_000,
    });

    const trustContext = makeTrustedContactTrustContext();

    bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-unified-1",
      toolName: "bash",
    });

    // All emitted signals should use guardian.question
    const eventNames = emittedSignals.map((s) => s.sourceEventName);
    for (const name of eventNames) {
      expect(name).toBe("guardian.question");
    }
  });
});

// ===========================================================================
// c. No-binding flow: trusted contact fails fast without guardian binding
// ===========================================================================

describe("(c) no-binding flow: trusted contact fails fast without guardian binding", () => {
  const shortHandler = new ToolApprovalHandler({
    inlineGrantWait: { maxWaitMs: 100, intervalMs: 20 },
  });

  beforeEach(() => {
    resetTables();
    events.length = 0;
    emittedSignals.length = 0;
    deliveredReplies.length = 0;
    mockGuardianBinding = null; // No guardian binding
  });

  test("routing state blocks prompt waiting when no guardian binding exists", () => {
    const ctx: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "trusted_contact",
      // No guardianExternalUserId — mirrors no binding
    };
    const state = resolveRoutingState(ctx);

    expect(state.canBeInteractive).toBe(true);
    expect(state.guardianRouteResolvable).toBe(false);
    expect(state.promptWaitingAllowed).toBe(false);
  });

  test("tool escalation returns generic denial (no dead-end wait) without binding", async () => {
    const toolName = "bash";
    const input = { command: "ls" };
    const context = makeToolContext({
      trustClass: "trusted_contact",
      executionChannel: "telegram",
    });

    const start = Date.now();
    const result = await shortHandler.checkPreExecutionGates(
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

    // Should return the generic guardian approval message, not enter inline wait
    expect(result.result.content).toContain("guardian approval");

    // No canonical tool_grant_request should have been created (no binding)
    const requests = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(requests.length).toBe(0);

    // Should complete nearly instantly, not block for the full wait budget
    expect(elapsed).toBeLessThan(500);
  });

  test("bridge skips when no guardian binding exists for channel", () => {
    const canonicalRequest = createCanonicalGuardianRequest({
      id: `req-nobinding-${Date.now()}`,
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-nobinding",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      status: "pending",
      expiresAt: Date.now() + 5 * 60_000,
    });

    const trustContext = makeTrustedContactTrustContext();

    const result = bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-nobinding",
      toolName: "bash",
    });

    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result) {
      expect(result.reason).toBe("no_guardian_binding");
    }
    expect(emittedSignals.length).toBe(0);
  });
});

// ===========================================================================
// d. Unknown actor flow: remains fail-closed
// ===========================================================================

describe("(d) unknown actor flow: fail-closed with no interactive approval", () => {
  const handler = new ToolApprovalHandler({
    inlineGrantWait: { maxWaitMs: 2_000, intervalMs: 20 },
  });

  beforeEach(() => {
    resetTables();
    events.length = 0;
    emittedSignals.length = 0;
    mockGuardianBinding = {
      id: "binding-1",
      assistantId: "self",
      channel: "telegram",
      guardianExternalUserId: "guardian-1",
      guardianDeliveryChatId: "guardian-chat-1",
      guardianPrincipalId: "test-principal-id",
      status: "active",
    };
  });

  test("unknown actors get immediate denial with no escalation or wait", async () => {
    const toolName = "bash";
    const input = { command: "ls" };
    const context = makeToolContext({
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

    // Unknown actors get the verified-identity message
    expect(result.result.content).toContain("verified channel identity");

    // No canonical request created — unknown actors don't escalate
    const requests = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(requests.length).toBe(0);

    // Near-instant: no inline wait for unknown actors
    expect(elapsed).toBeLessThan(200);
  });

  test("unknown actors have promptWaitingAllowed=false regardless of guardian route", () => {
    const withRoute: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "unknown",
      guardianExternalUserId: "guardian-1",
    };
    const withoutRoute: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "unknown",
    };

    expect(resolveRoutingState(withRoute).promptWaitingAllowed).toBe(false);
    expect(resolveRoutingState(withRoute).canBeInteractive).toBe(false);
    expect(resolveRoutingState(withoutRoute).promptWaitingAllowed).toBe(false);
    expect(resolveRoutingState(withoutRoute).canBeInteractive).toBe(false);
  });

  test("bridge skips unknown actor sessions entirely", () => {
    const canonicalRequest = createCanonicalGuardianRequest({
      id: `req-unknown-${Date.now()}`,
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-unknown",
      requesterExternalUserId: "unknown-user",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      status: "pending",
      expiresAt: Date.now() + 5 * 60_000,
    });

    const trustContext: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "unknown",
    };

    const result = bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-unknown",
      toolName: "bash",
    });

    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result) {
      expect(result.reason).toBe("not_trusted_contact");
    }
  });
});

// ===========================================================================
// e. Guardian-only prompt delivery invariant
// ===========================================================================

/**
 * Mirrors the `isBoundGuardianActor` guard from inbound-message-handler.ts.
 * Uses the same runtime-value shape so TypeScript treats the comparisons as
 * `string === string` rather than `'literal_a' === 'literal_b'` (which TS
 * flags as always-false under strict literal narrowing — TS2367/TS2872).
 */
function checkIsBoundGuardianActor(params: {
  trustClass: string;
  guardianExternalUserId: string | undefined;
  requesterExternalUserId: string;
}): boolean {
  return (
    params.trustClass === "guardian" &&
    !!params.guardianExternalUserId &&
    params.requesterExternalUserId === params.guardianExternalUserId
  );
}

describe("(e) guardian-only prompt delivery invariant", () => {
  beforeEach(() => {
    deliveredReplies.length = 0;
    mockPendingApprovals = [
      {
        requestId: "req-prompt-test",
        toolName: "bash",
        input: { command: "ls" },
        riskLevel: "high",
      },
    ];
  });

  test("trusted_contact does NOT receive approval prompt UI (notifier only sends waiting message)", async () => {
    // The startPendingApprovalPromptWatcher in inbound-message-handler.ts
    // has a guard: isBoundGuardianActor check. Non-guardian actors (including
    // trusted contacts) get () => {} (noop) for the watcher. Only guardian
    // actors matching the binding receive the prompt.

    const result = checkIsBoundGuardianActor({
      trustClass: "trusted_contact",
      guardianExternalUserId: "guardian-1",
      requesterExternalUserId: "requester-1",
    });

    expect(result).toBe(false);
    // The prompt watcher would return a noop for trusted contacts
  });

  test("unknown actors do NOT receive approval prompt UI", () => {
    const result = checkIsBoundGuardianActor({
      trustClass: "unknown",
      guardianExternalUserId: "guardian-1",
      requesterExternalUserId: "unknown-user",
    });

    expect(result).toBe(false);
  });

  test("guardian actor that matches binding DOES receive approval prompt UI", () => {
    const result = checkIsBoundGuardianActor({
      trustClass: "guardian",
      guardianExternalUserId: "guardian-1",
      requesterExternalUserId: "guardian-1",
    });

    expect(result).toBe(true);
  });

  test("guardian actor with identity mismatch does NOT receive approval prompt UI", () => {
    // After guardian rotation, old guardian identity should not receive prompts
    const result = checkIsBoundGuardianActor({
      trustClass: "guardian",
      guardianExternalUserId: "new-guardian-2",
      requesterExternalUserId: "old-guardian-1",
    });

    expect(result).toBe(false);
  });
});

// ===========================================================================
// f. Timeout/stale flow: guardian decision after prompt timeout
// ===========================================================================

describe("(f) timeout/stale flow: stale guardian decision after inline wait timeout", () => {
  const handler = new ToolApprovalHandler({
    inlineGrantWait: { maxWaitMs: 100, intervalMs: 20 },
  });

  beforeEach(() => {
    resetTables();
    events.length = 0;
    emittedSignals.length = 0;
    deliveredReplies.length = 0;
    mockGuardianBinding = {
      id: "binding-1",
      assistantId: "self",
      channel: "telegram",
      guardianExternalUserId: "guardian-1",
      guardianDeliveryChatId: "guardian-chat-1",
      guardianPrincipalId: "test-principal-id",
      status: "active",
    };
  });

  test("inline wait timeout clears followupState so later approval sends retry notification", async () => {
    const toolName = "bash";
    const input = { command: "echo stale" };
    const context = makeToolContext({ trustClass: "trusted_contact" });

    // Let the tool invocation time out (no guardian approval within 100ms)
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
    expect(result.result.content).toContain(
      "guardian approval was not received in time",
    );

    // After timeout, the followupState should be cleared (null)
    const pending = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(pending.length).toBe(1);

    const freshReq = getCanonicalGuardianRequest(pending[0].id);
    // followupState should be null after timeout — the inline wait cleared it
    expect(freshReq?.followupState).toBeNull();

    // Now simulate guardian approving after the timeout
    const approvalResult = await applyCanonicalGuardianDecision({
      requestId: pending[0].id,
      action: "approve_once",
      actorContext: guardianActor(),
      channelDeliveryContext: {
        replyCallbackUrl: "http://localhost:3000/reply",
        guardianChatId: "guardian-chat-1",
        assistantId: "self",
        bearerToken: "test-token",
      },
    });
    expect(approvalResult.applied).toBe(true);

    // The resolver should have sent the retry notification because
    // followupState was cleared (not inline_wait_active)
    const retryNotifications = deliveredReplies.filter(
      (r) =>
        typeof r.payload.text === "string" &&
        (r.payload.text as string).includes("approved"),
    );
    expect(retryNotifications.length).toBeGreaterThan(0);
  });

  test("inline_wait_active staleness guard: expired marker allows retry notification", async () => {
    // Create a canonical request with a stale inline_wait_active marker
    // that simulates a daemon crash during the wait.
    const staleTimestamp = Date.now() - TC_GRANT_WAIT_MAX_MS - 60_000;
    const req = createCanonicalGuardianRequest({
      id: `req-stale-${Date.now()}`,
      kind: "tool_grant_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-stale-1",
      requesterExternalUserId: "requester-1",
      requesterChatId: "requester-chat-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      inputDigest: "sha256:stale",
      expiresAt: Date.now() + 60_000,
    });

    // Set a stale inline_wait_active marker
    updateCanonicalGuardianRequest(req.id, {
      followupState: `inline_wait_active:${staleTimestamp}`,
    });

    // Verify marker is stale
    const freshReq = getCanonicalGuardianRequest(req.id);
    expect(freshReq?.followupState).toContain("inline_wait_active:");

    // Guardian approves — the resolver should detect the stale marker
    // and send the retry notification instead of suppressing it.
    const approvalResult = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
      channelDeliveryContext: {
        replyCallbackUrl: "http://localhost:3000/reply",
        guardianChatId: "guardian-chat-1",
        assistantId: "self",
        bearerToken: "test-token",
      },
    });
    expect(approvalResult.applied).toBe(true);

    // The retry notification should have been sent (stale marker treated as cleared)
    const retryNotifications = deliveredReplies.filter(
      (r) =>
        typeof r.payload.text === "string" &&
        (r.payload.text as string).includes("approved"),
    );
    expect(retryNotifications.length).toBeGreaterThan(0);
  });

  test("fresh inline_wait_active marker suppresses retry notification", async () => {
    // Create a request with a FRESH inline_wait_active marker
    const freshTimestamp = Date.now();
    const req = createCanonicalGuardianRequest({
      id: `req-fresh-${Date.now()}`,
      kind: "tool_grant_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-fresh-1",
      requesterExternalUserId: "requester-1",
      requesterChatId: "requester-chat-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      inputDigest: "sha256:fresh",
      expiresAt: Date.now() + 60_000,
    });

    updateCanonicalGuardianRequest(req.id, {
      followupState: `inline_wait_active:${freshTimestamp}`,
    });

    // Guardian approves while an active inline waiter is running
    deliveredReplies.length = 0;
    const approvalResult = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: "approve_once",
      actorContext: guardianActor(),
      channelDeliveryContext: {
        replyCallbackUrl: "http://localhost:3000/reply",
        guardianChatId: "guardian-chat-1",
        assistantId: "self",
        bearerToken: "test-token",
      },
    });
    expect(approvalResult.applied).toBe(true);

    // The retry notification should NOT have been sent — the inline waiter
    // is still active and will consume the grant directly.
    const retryNotifications = deliveredReplies.filter(
      (r) =>
        typeof r.payload.text === "string" &&
        (r.payload.text as string).includes("Please retry"),
    );
    expect(retryNotifications.length).toBe(0);
  });

  test("denied inline wait produces explicit denial (no false success)", async () => {
    const toolName = "bash";
    const input = { command: "rm -rf /" };
    const context = makeToolContext({ trustClass: "trusted_contact" });

    // Schedule guardian rejection after 80ms
    const rejectionPromise = (async () => {
      await new Promise((r) => setTimeout(r, 80));
      const pending = listCanonicalGuardianRequests({
        kind: "tool_grant_request",
        status: "pending",
        toolName: "bash",
      });
      if (pending.length > 0) {
        await applyCanonicalGuardianDecision({
          requestId: pending[0].id,
          action: "reject",
          actorContext: guardianActor(),
        });
      }
    })();

    const wideHandler = new ToolApprovalHandler({
      inlineGrantWait: { maxWaitMs: 2_000, intervalMs: 20 },
    });
    const result = await wideHandler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );

    await rejectionPromise;

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.result.content).toContain("guardian rejected the request");
    expect(result.result.isError).toBe(true);
  });

  test("timeout produces explicit timeout message (no false success)", async () => {
    const toolName = "bash";
    const input = { command: "curl example.com" };
    const context = makeToolContext({ trustClass: "trusted_contact" });

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
    expect(result.result.content).toContain(
      "guardian approval was not received in time",
    );
    expect(result.result.content).toContain("request code:");
    expect(result.result.isError).toBe(true);
  });
});

// ===========================================================================
// Cross-milestone integration checks
// ===========================================================================

describe("cross-milestone integration checks", () => {
  beforeEach(() => {
    resetTables();
    events.length = 0;
    emittedSignals.length = 0;
    deliveredReplies.length = 0;
    mockGuardianBinding = {
      id: "binding-1",
      assistantId: "self",
      channel: "telegram",
      guardianExternalUserId: "guardian-1",
      guardianDeliveryChatId: "guardian-chat-1",
      guardianPrincipalId: "test-principal-id",
      status: "active",
    };
  });

  test("M1+M4: routing state interactivity drives inline wait eligibility", async () => {
    // With guardian binding: interactive + inline wait allowed
    const withBinding: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "trusted_contact",
      guardianExternalUserId: "guardian-1",
    };
    expect(resolveRoutingState(withBinding).promptWaitingAllowed).toBe(true);

    // Without guardian binding: not interactive + inline wait should not enter dead-end
    const withoutBinding: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "trusted_contact",
    };
    expect(resolveRoutingState(withoutBinding).promptWaitingAllowed).toBe(
      false,
    );
  });

  test("M2+M4: bridge and tool_grant_request target the same guardian identity", () => {
    // Both the confirmation_request bridge (M2) and tool grant request escalation (M4)
    // use the guardian binding's guardianExternalUserId to route notifications.
    // Verify this consistency:

    const canonicalRequest = createCanonicalGuardianRequest({
      id: `req-consistency-${Date.now()}`,
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "conv-consistency",
      requesterExternalUserId: "requester-1",
      guardianExternalUserId: "guardian-1",
      guardianPrincipalId: "test-principal-id",
      toolName: "bash",
      status: "pending",
      expiresAt: Date.now() + 5 * 60_000,
    });

    const trustContext = makeTrustedContactTrustContext();

    const bridgeResult = bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-consistency",
      toolName: "bash",
    });

    expect("bridged" in bridgeResult && bridgeResult.bridged).toBe(true);

    // Both the bridge signal and the tool_grant_request signal would target
    // the same guardian binding (guardian-1)
    if (emittedSignals.length > 0) {
      const payload = emittedSignals[0].contextPayload as Record<
        string,
        unknown
      >;
      expect(payload.requesterExternalUserId).toBe("requester-1");
    }
  });

  test("M4: tool_grant_request resolver is correctly registered", () => {
    const resolver = getResolver("tool_grant_request");
    expect(resolver).toBeDefined();
    expect(resolver!.kind).toBe("tool_grant_request");
  });

  test("M1: guardian actors bypass inline wait entirely (self-approve path)", async () => {
    const handler = new ToolApprovalHandler({
      inlineGrantWait: { maxWaitMs: 100, intervalMs: 20 },
    });
    const toolName = "bash";
    const input = { command: "ls" };
    const context = makeToolContext({
      trustClass: "guardian",
      executionChannel: "telegram",
      requesterExternalUserId: "guardian-1",
    });

    // Guardian actors resolve through the standard permission prompt path,
    // not the grant escalation path. The tool should be allowed without
    // going through grant consumption.
    const result = await handler.checkPreExecutionGates(
      toolName,
      input,
      context,
      "host",
      "high",
      Date.now(),
      emitLifecycleEvent,
    );

    // Guardian + no grant check = allowed without grantConsumed
    // (guardians use the interactive prompt, not the grant system)
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.grantConsumed).toBeUndefined();
  });

  test("M4: abort signal during inline wait clears followupState for later retries", async () => {
    const handler = new ToolApprovalHandler({
      inlineGrantWait: { maxWaitMs: 5_000, intervalMs: 20 },
    });
    const toolName = "bash";
    const input = { command: "aborted-command" };
    const controller = new AbortController();
    const context = makeToolContext({
      trustClass: "trusted_contact",
      signal: controller.signal,
    });

    // Abort after 100ms
    setTimeout(() => controller.abort(), 100);

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
    expect(result.result.content).toBe("Cancelled");

    // The canonical request should exist but followupState should be cleared
    const pending = listCanonicalGuardianRequests({
      kind: "tool_grant_request",
      status: "pending",
    });
    expect(pending.length).toBe(1);

    const freshReq = getCanonicalGuardianRequest(pending[0].id);
    // After abort, followupState should be cleared so a later guardian
    // approval sends the retry notification
    expect(freshReq?.followupState).toBeNull();
  });
});
