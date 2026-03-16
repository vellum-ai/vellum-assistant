/**
 * Tests that the voice bridge consumes scoped approval grants via the
 * unified approval primitive before auto-denying non-guardian callers.
 *
 * Some confirmation_request events originate from proxy/network paths
 * (e.g. PermissionPrompter in createProxyApprovalCallback) that bypass
 * the pre-exec gate. The bridge must check for a matching scoped grant
 * and allow the confirmation if one exists.
 *
 * Verifies:
 *   1. Non-guardian confirmation requests are auto-allowed when a
 *      matching grant exists (bridge consumes it via the primitive).
 *   2. Non-guardian confirmation requests are auto-denied when no
 *      matching grant exists.
 *   3. Guardian auto-allow path remains unchanged.
 *   4. Grants are revoked on call end (controller.destroy).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(
  join(tmpdir(), "voice-scoped-grant-consumer-test-"),
);

// ── Platform + logger mocks (must come before any source imports) ────

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
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

// ── Config mock ─────────────────────────────────────────────────────

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    provider: "anthropic",
    providerOrder: ["anthropic"],
    calls: {
      enabled: true,
      provider: "twilio",
      maxDurationSeconds: 12 * 60,
      userConsultTimeoutSeconds: 90,
      userConsultationTimeoutSeconds: 90,
      silenceTimeoutSeconds: 30,
      disclosure: { enabled: false, text: "" },
      safety: { denyCategories: [] },
      model: undefined,
    },
    memory: { enabled: false },
  }),
}));

// ── Secret ingress mock ────────────────────────────────────────────

mock.module("../security/secret-ingress.js", () => ({
  checkIngressForSecrets: () => ({ blocked: false }),
}));

// ── Assistant event hub mock ───────────────────────────────────────

mock.module("../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
  },
}));

mock.module("../runtime/assistant-event.js", () => ({
  buildAssistantEvent: () => ({}),
}));

// ── Session runtime assembly mock ──────────────────────────────────

mock.module("../daemon/conversation-runtime-assembly.js", () => ({
  resolveChannelCapabilities: () => ({
    supportsRichText: false,
    supportsDynamicUi: false,
    supportsVoiceInput: true,
  }),
}));

// ── Import source modules after all mocks are registered ────────────

import { and, eq } from "drizzle-orm";

import {
  setVoiceBridgeDeps,
  startVoiceTurn,
} from "../calls/voice-session-bridge.js";
import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { scopedApprovalGrants } from "../memory/schema.js";
import {
  _internal,
  type CreateScopedApprovalGrantParams,
  revokeScopedApprovalGrantsForContext,
} from "../memory/scoped-approval-grants.js";

const { createScopedApprovalGrant } = _internal;
import { computeToolApprovalDigest } from "../security/tool-approval-digest.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Mock session that triggers a confirmation_request on processMessage
// ---------------------------------------------------------------------------

const TOOL_NAME = "execute_shell";
const TOOL_INPUT = { command: "rm -rf /tmp/test" };
const ASSISTANT_ID = "self";
const CONVERSATION_ID = "conv-voice-grant-test";
const CALL_SESSION_ID = "call-session-voice-grant-test";

/**
 * Create a mock session that, when runAgentLoop is called, emits a
 * confirmation_request through the updateClient callback before completing.
 */
function createMockSession(opts?: {
  confirmationRequestId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}) {
  const requestId = opts?.confirmationRequestId ?? `req-${crypto.randomUUID()}`;
  const toolName = opts?.toolName ?? TOOL_NAME;
  const toolInput = opts?.toolInput ?? TOOL_INPUT;

  let clientCallback: ((msg: ServerMessage) => void) | null = null;
  let confirmationDecision: {
    requestId: string;
    decision: string;
    reason?: string;
  } | null = null;

  const session = {
    isProcessing: () => false,
    memoryPolicy: {},
    setAssistantId: () => {},
    setTrustContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setChannelCapabilities: () => {},
    setVoiceCallControlPrompt: () => {},
    currentRequestId: requestId,
    abort: () => {},
    persistUserMessage: async () => "msg-1",
    updateClient: (cb: (msg: ServerMessage) => void, _reset?: boolean) => {
      clientCallback = cb;
    },
    handleConfirmationResponse: (
      reqId: string,
      decision: string,
      _pattern?: string,
      _scope?: string,
      reason?: string,
    ) => {
      confirmationDecision = { requestId: reqId, decision, reason };
    },
    handleSecretResponse: () => {},
    runAgentLoop: async (
      _content: string,
      _messageId: string,
      broadcastFn: (msg: ServerMessage) => void,
    ) => {
      // Emit a confirmation_request through the client callback
      if (clientCallback) {
        clientCallback({
          type: "confirmation_request",
          requestId,
          toolName,
          input: toolInput,
          riskLevel: "medium",
          allowlistOptions: [],
          scopeOptions: [],
        } as ServerMessage);
      }
      // Then complete the turn
      broadcastFn({ type: "message_complete" } as ServerMessage);
    },
  };

  return {
    session,
    requestId,
    getConfirmationDecision: () => confirmationDecision,
  };
}

// ---------------------------------------------------------------------------
// Setup: inject mock deps into voice-session-bridge
// ---------------------------------------------------------------------------

function setupBridgeDeps(
  sessionFactory: () => ReturnType<typeof createMockSession>["session"],
) {
  let currentSession: ReturnType<typeof createMockSession>["session"] | null =
    null;
  setVoiceBridgeDeps({
    getOrCreateSession: async () => {
      currentSession = sessionFactory();
      return currentSession as any;
    },
    resolveAttachments: () => [],
    deriveDefaultStrictSideEffects: () => true,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearTables(): void {
  const db = getDb();
  try {
    db.run("DELETE FROM scoped_approval_grants");
  } catch {
    /* table may not exist */
  }
}

function grantParams(
  overrides: Partial<CreateScopedApprovalGrantParams> = {},
): CreateScopedApprovalGrantParams {
  const futureExpiry = Date.now() + 60_000;
  return {
    scopeMode: "tool_signature",
    toolName: TOOL_NAME,
    inputDigest: computeToolApprovalDigest(TOOL_NAME, TOOL_INPUT),
    requestChannel: "phone",
    decisionChannel: "telegram",
    executionChannel: "phone",
    conversationId: CONVERSATION_ID,
    callSessionId: CALL_SESSION_ID,
    expiresAt: futureExpiry,
    ...overrides,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("voice bridge confirmation handling (grant consumption via primitive)", () => {
  beforeEach(() => {
    clearTables();
  });

  test("non-guardian with matching grant: auto-allowed (bridge consumes grant via primitive)", async () => {
    // A matching grant should be consumed and the confirmation allowed.
    // This covers proxy/network confirmation requests that bypass the pre-exec gate.
    createScopedApprovalGrant(grantParams());

    const mockData = createMockSession();
    setupBridgeDeps(() => mockData.session);

    const trustContext: TrustContext = {
      sourceChannel: "phone",
      trustClass: "trusted_contact",
      requesterExternalUserId: "caller-123",
    };

    await startVoiceTurn({
      conversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      content: "test utterance",
      assistantId: ASSISTANT_ID,
      trustContext,
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    // Wait for the async agent loop to finish
    await new Promise((resolve) => setTimeout(resolve, 100));

    const decision = mockData.getConfirmationDecision();
    expect(decision).not.toBeNull();
    expect(decision!.decision).toBe("allow");
    expect(decision!.reason).toContain(
      "guardian pre-approved via scoped grant",
    );

    // The grant should be consumed (no longer active)
    const db = getDb();
    const activeGrants = db
      .select()
      .from(scopedApprovalGrants)
      .where(eq(scopedApprovalGrants.status, "active"))
      .all();
    expect(activeGrants.length).toBe(0);
  });

  test("non-guardian without grant: auto-denied", async () => {
    // No grant created

    const mockData = createMockSession();
    setupBridgeDeps(() => mockData.session);

    const trustContext: TrustContext = {
      sourceChannel: "phone",
      trustClass: "trusted_contact",
      requesterExternalUserId: "caller-123",
    };

    await startVoiceTurn({
      conversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      content: "test utterance",
      assistantId: ASSISTANT_ID,
      trustContext,
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const decision = mockData.getConfirmationDecision();
    expect(decision).not.toBeNull();
    expect(decision!.decision).toBe("deny");
    expect(decision!.reason).toContain("Permission denied");
  });

  test("non-guardian with mismatched tool name: auto-denied", async () => {
    // Create a grant for a different tool
    createScopedApprovalGrant(
      grantParams({
        toolName: "read_file",
        inputDigest: computeToolApprovalDigest("read_file", TOOL_INPUT),
      }),
    );

    const mockData = createMockSession();
    setupBridgeDeps(() => mockData.session);

    const trustContext: TrustContext = {
      sourceChannel: "phone",
      trustClass: "trusted_contact",
    };

    await startVoiceTurn({
      conversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      content: "test utterance",
      assistantId: ASSISTANT_ID,
      trustContext,
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const decision = mockData.getConfirmationDecision();
    expect(decision).not.toBeNull();
    expect(decision!.decision).toBe("deny");
  });

  test("guardian caller: auto-allowed regardless of grants", async () => {
    // No grant needed — guardian should auto-allow

    const mockData = createMockSession();
    setupBridgeDeps(() => mockData.session);

    const trustContext: TrustContext = {
      sourceChannel: "phone",
      trustClass: "guardian",
    };

    await startVoiceTurn({
      conversationId: CONVERSATION_ID,
      callSessionId: CALL_SESSION_ID,
      content: "test utterance",
      assistantId: ASSISTANT_ID,
      trustContext,
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const decision = mockData.getConfirmationDecision();
    expect(decision).not.toBeNull();
    expect(decision!.decision).toBe("allow");
    expect(decision!.reason).toContain("guardian voice call");
  });

  test("grants revoked when revokeScopedApprovalGrantsForContext is called with callSessionId", () => {
    const db = getDb();
    const testCallSessionId = "call-session-revoke-test";

    // Create two grants: one for our call session, one for another
    createScopedApprovalGrant(
      grantParams({ callSessionId: testCallSessionId }),
    );
    createScopedApprovalGrant(
      grantParams({ callSessionId: "other-call-session" }),
    );

    // Verify both grants are active
    const allActive = db
      .select()
      .from(scopedApprovalGrants)
      .where(eq(scopedApprovalGrants.status, "active"))
      .all();
    expect(allActive.length).toBe(2);

    // Revoke grants for the specific call session (simulates call end)
    const revokedCount = revokeScopedApprovalGrantsForContext({
      callSessionId: testCallSessionId,
    });
    expect(revokedCount).toBe(1);

    // Only the target call session's grant should be revoked
    const activeAfter = db
      .select()
      .from(scopedApprovalGrants)
      .where(
        and(
          eq(scopedApprovalGrants.callSessionId, testCallSessionId),
          eq(scopedApprovalGrants.status, "active"),
        ),
      )
      .all();
    expect(activeAfter.length).toBe(0);

    const revokedAfter = db
      .select()
      .from(scopedApprovalGrants)
      .where(
        and(
          eq(scopedApprovalGrants.callSessionId, testCallSessionId),
          eq(scopedApprovalGrants.status, "revoked"),
        ),
      )
      .all();
    expect(revokedAfter.length).toBe(1);

    // The other call session's grant should still be active
    const otherActive = db
      .select()
      .from(scopedApprovalGrants)
      .where(
        and(
          eq(scopedApprovalGrants.callSessionId, "other-call-session"),
          eq(scopedApprovalGrants.status, "active"),
        ),
      )
      .all();
    expect(otherActive.length).toBe(1);
  });

  test("grants with null callSessionId are revoked by conversationId", () => {
    const db = getDb();
    const testConversationId = "conv-revoke-by-conversation";

    // Simulate the guardian-approval-interception minting path which sets
    // callSessionId: null but always sets conversationId
    createScopedApprovalGrant(
      grantParams({
        callSessionId: null,
        conversationId: testConversationId,
      }),
    );
    createScopedApprovalGrant(
      grantParams({
        callSessionId: null,
        conversationId: "other-conversation",
      }),
    );

    // Verify both grants are active
    const allActive = db
      .select()
      .from(scopedApprovalGrants)
      .where(eq(scopedApprovalGrants.status, "active"))
      .all();
    expect(allActive.length).toBe(2);

    // callSessionId-based revocation should miss grants with null callSessionId
    // because the filter matches on the column value, not NULL
    const revokedByCallSession = revokeScopedApprovalGrantsForContext({
      callSessionId: CALL_SESSION_ID,
    });
    expect(revokedByCallSession).toBe(0);

    // conversationId-based revocation catches the grant
    const revokedByConversation = revokeScopedApprovalGrantsForContext({
      conversationId: testConversationId,
    });
    expect(revokedByConversation).toBe(1);

    // The target conversation's grant should be revoked
    const revokedAfter = db
      .select()
      .from(scopedApprovalGrants)
      .where(
        and(
          eq(scopedApprovalGrants.conversationId, testConversationId),
          eq(scopedApprovalGrants.status, "revoked"),
        ),
      )
      .all();
    expect(revokedAfter.length).toBe(1);

    // The other conversation's grant should still be active
    const otherActive = db
      .select()
      .from(scopedApprovalGrants)
      .where(
        and(
          eq(scopedApprovalGrants.conversationId, "other-conversation"),
          eq(scopedApprovalGrants.status, "active"),
        ),
      )
      .all();
    expect(otherActive.length).toBe(1);
  });
});
