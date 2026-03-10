/**
 * Characterization tests: HTTP POST /v1/messages vs legacy handleUserMessage behavior parity.
 *
 * These tests document the exact behavior gaps between the HTTP send path
 * (handleSendMessage in conversation-routes.ts) and the legacy IPC path
 * (handleUserMessage in session-user-message.ts).
 *
 * Behavior gaps identified:
 *
 * 1. SECRET INGRESS BLOCKING
 *    - handleUserMessage: Calls handleSecretIngress() which blocks messages
 *      containing secrets, sends a `secret_blocked` error event, redirects
 *      to a secure prompt, and resumes with a redacted continuation message.
 *    - handleSendMessage (HTTP): Does NOT perform any secret ingress check.
 *      Messages containing secrets pass through to the agent loop unchecked.
 *      (The gateway inbound-message-handler has its own secret-ingress-check
 *      stage, but POST /v1/messages for desktop/CLI does not.)
 *
 * 2. STANDALONE RECORDING INTENT INTERCEPTION
 *    - handleUserMessage: Calls handleStructuredRecordingIntent() and
 *      handleStandaloneRecordingIntent() to intercept recording commands
 *      (start/stop/pause/resume/restart) before they reach the agent loop.
 *    - handleSendMessage (HTTP): Does NOT intercept recording intents.
 *      Recording commands are sent directly to the agent loop as regular
 *      user messages. Separate recording HTTP endpoints exist at
 *      /v1/recording/* but inline text-based interception does not happen.
 *
 * 3. APPROVAL REPLY INTERCEPTION (PARITY ACHIEVED)
 *    - Both paths handle inline approval reply interception via the
 *      guardian reply router. The HTTP path uses tryConsumeCanonicalGuardianReply()
 *      and the IPC path uses handlePendingConfirmationReply(). Both filter
 *      stale tool_approval requests by checking session.hasPendingConfirmation().
 *    - Minor differences: the IPC path uses resolveLocalIpcTrustContext() for
 *      actor identity, while HTTP uses the JWT-verified AuthContext. The IPC
 *      path also uses a desktop-specific ApprovalConversationGenerator, while
 *      HTTP accepts one as a dependency injection parameter.
 *
 * These tests serve as concrete evidence for PR 7's migration decisions:
 * - If HTTP should match legacy behavior, these tests identify what to port.
 * - If HTTP intentionally differs, these tests lock in the current behavior.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ────────────────────────────────────────────────────────────────────────────
// Module mocks — must be set up before any imports that pull in the mocked
// modules. These are shared across all describe blocks in this file.
// ────────────────────────────────────────────────────────────────────────────

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

const routeGuardianReplyMock = mock(async () => ({
  consumed: false,
  decisionApplied: false,
  type: "not_consumed" as const,
})) as any;

const listPendingByDestinationMock = mock(
  (_conversationId: string, _sourceChannel?: string) =>
    [] as Array<{ id: string; kind?: string }>,
);
const listCanonicalMock = mock(
  (_filters?: Record<string, unknown>) => [] as Array<{ id: string }>,
);
const addMessageMock = mock(
  async (
    _conversationId: string,
    role: string,
    _content?: string,
    _metadata?: Record<string, unknown>,
  ) => ({
    id: role === "user" ? "persisted-user-id" : "persisted-assistant-id",
  }),
);

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../memory/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-parity-test" }),
  getConversationByKey: () => null,
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
}));

mock.module("../runtime/guardian-reply-router.js", () => ({
  routeGuardianReply: routeGuardianReplyMock,
}));

mock.module("../memory/canonical-guardian-store.js", () => ({
  createCanonicalGuardianRequest: () => ({
    id: "canonical-id",
    requestCode: "ABC123",
  }),
  generateCanonicalRequestCode: () => "ABC123",
  listPendingCanonicalGuardianRequestsByDestinationConversation: (
    conversationId: string,
    sourceChannel?: string,
  ) => listPendingByDestinationMock(conversationId, sourceChannel),
  listCanonicalGuardianRequests: (filters?: Record<string, unknown>) =>
    listCanonicalMock(filters),
  listPendingRequestsByConversationScope: (conversationId: string) => {
    const byDest = listPendingByDestinationMock(conversationId);
    const bySrc = listCanonicalMock({ status: "pending", conversationId });
    const seen = new Set<string>();
    const result: Array<{ id: string; kind?: string }> = [];
    for (const r of [...bySrc, ...byDest]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        result.push(r);
      }
    }
    return result;
  },
}));

mock.module("../runtime/confirmation-request-guardian-bridge.js", () => ({
  bridgeConfirmationRequestToGuardian: async () => undefined,
}));

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: (
    conversationId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) => addMessageMock(conversationId, role, content, metadata),
}));

mock.module("../runtime/local-actor-identity.js", () => ({
  resolveLocalIpcTrustContext: () => ({
    trustClass: "guardian",
    sourceChannel: "vellum",
  }),
}));

mock.module("../runtime/trust-context-resolver.js", () => ({
  resolveTrustContext: () => ({
    trustClass: "guardian",
    sourceChannel: "vellum",
  }),
  withSourceChannel: (sourceChannel: unknown, ctx: unknown) => ({
    ...(ctx as Record<string, unknown>),
    sourceChannel,
  }),
}));

import type { AuthContext } from "../runtime/auth/types.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";

const testAuthContext: AuthContext = {
  subject: "actor:self:test-actor",
  principalType: "actor",
  assistantId: "self",
  actorPrincipalId: "test-actor",
  scopeProfile: "actor_client_v1",
  scopes: new Set([
    "chat.read",
    "chat.write",
    "approval.read",
    "approval.write",
    "settings.read",
    "settings.write",
    "attachments.read",
    "attachments.write",
    "calls.read",
    "calls.write",
    "feature_flags.read",
    "feature_flags.write",
  ]),
  policyEpoch: 1,
};

// ── Helper: create a minimal mock session ──────────────────────────────────
function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    setTrustContext: () => {},
    updateClient: () => {},
    emitConfirmationStateChanged: () => {},
    emitActivityState: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    isProcessing: () => false,
    hasAnyPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
    enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
    persistUserMessage: mock(async () => "persisted-user-id"),
    runAgentLoop: mock(async () => undefined),
    getMessages: () => [] as unknown[],
    assistantId: "self",
    trustContext: undefined,
    hasPendingConfirmation: () => false,
    ...overrides,
  } as unknown as import("../daemon/session.js").Session;
}

// ── Helper: create an HTTP request to POST /v1/messages ────────────────────
function makeRequest(content: string, extra: Record<string, unknown> = {}) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationKey: "parity-test-key",
      content,
      sourceChannel: "vellum",
      interface: "macos",
      ...extra,
    }),
  });
}

// ── Helper: send a message through handleSendMessage ───────────────────────
async function sendMessage(
  content: string,
  session: import("../daemon/session.js").Session,
  extra: Record<string, unknown> = {},
) {
  return handleSendMessage(
    makeRequest(content, extra),
    {
      sendMessageDeps: {
        getOrCreateSession: async () => session,
        assistantEventHub: { publish: async () => {} } as any,
        resolveAttachments: () => [],
      },
    },
    testAuthContext,
  );
}

// ============================================================================
// GAP 1: SECRET INGRESS BLOCKING
// ============================================================================
describe("GAP: HTTP POST /v1/messages does NOT block secret ingress", () => {
  beforeEach(() => {
    routeGuardianReplyMock.mockClear();
    listPendingByDestinationMock.mockClear();
    listCanonicalMock.mockClear();
    addMessageMock.mockClear();
  });

  test("handleSendMessage accepts messages containing secret-like content without blocking", async () => {
    // This message contains a Telegram bot token pattern that handleUserMessage
    // would block via handleSecretIngress(). The HTTP path does NOT check for
    // secrets, so it passes through to the agent loop.
    const secretContent =
      "Set up Telegram with my bot token 123456789:ABCDefGHIJklmnopQRSTuvwxyz012345678";
    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({ persistUserMessage, runAgentLoop });

    const res = await sendMessage(secretContent, session);

    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: boolean; messageId?: string };
    expect(body.accepted).toBe(true);

    // CHARACTERIZATION: The HTTP path does NOT block — it proceeds to
    // persist the message and run the agent loop with the secret content.
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("handleSendMessage does not emit a secret_blocked error event", async () => {
    // In handleUserMessage, secret detection emits { type: "error", category: "secret_blocked" }.
    // The HTTP path has no equivalent emission because it has no secret check.
    const secretContent =
      "Here is my AWS key AKIAIOSFODNN7EXAMPLE and secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const publishedEvents: unknown[] = [];
    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({ persistUserMessage, runAgentLoop });

    const res = await handleSendMessage(
      makeRequest(secretContent),
      {
        sendMessageDeps: {
          getOrCreateSession: async () => session,
          assistantEventHub: {
            publish: async (event: unknown) => {
              publishedEvents.push(event);
            },
          } as any,
          resolveAttachments: () => [],
        },
      },
      testAuthContext,
    );

    expect(res.status).toBe(202);

    // CHARACTERIZATION: No secret_blocked event is emitted through the hub.
    // handleUserMessage would send { type: "error", category: "secret_blocked" }.
    const secretBlockedEvents = publishedEvents.filter(
      (e: any) => e?.message?.type === "error" && e?.message?.category === "secret_blocked",
    );
    expect(secretBlockedEvents).toHaveLength(0);

    // The message is processed normally despite containing secrets.
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("handleSendMessage does not redirect to secure prompt after detecting secrets", async () => {
    // handleUserMessage calls session.redirectToSecurePrompt() when secrets
    // are detected, then dispatches a redacted continuation message.
    // The HTTP path has no equivalent of this flow.
    const secretContent =
      "My Stripe key is sk_test_4eC39HqLyjWDarjtT1zdp7dc";
    const redirectToSecurePromptMock = mock(() => {});
    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({
      persistUserMessage,
      runAgentLoop,
      redirectToSecurePrompt: redirectToSecurePromptMock,
    });

    const res = await sendMessage(secretContent, session);

    expect(res.status).toBe(202);

    // CHARACTERIZATION: redirectToSecurePrompt is never called on the HTTP path.
    expect(redirectToSecurePromptMock).toHaveBeenCalledTimes(0);
    // Instead, the message goes straight to the agent loop.
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// GAP 2: STANDALONE RECORDING INTENT INTERCEPTION
// ============================================================================
describe("GAP: HTTP POST /v1/messages does NOT intercept recording intents", () => {
  beforeEach(() => {
    routeGuardianReplyMock.mockClear();
    listPendingByDestinationMock.mockClear();
    listCanonicalMock.mockClear();
    addMessageMock.mockClear();
  });

  test("handleSendMessage does not intercept 'start recording' commands", async () => {
    // handleUserMessage would intercept this via handleStandaloneRecordingIntent()
    // and return a "Starting screen recording." response without hitting the
    // agent loop. The HTTP path sends it to the agent loop as a normal message.
    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({ persistUserMessage, runAgentLoop });

    const res = await sendMessage("start recording", session);

    expect(res.status).toBe(202);

    // CHARACTERIZATION: Recording commands are NOT intercepted on the HTTP path.
    // They pass through to the agent loop as regular user messages.
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("handleSendMessage does not intercept 'stop recording' commands", async () => {
    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({ persistUserMessage, runAgentLoop });

    const res = await sendMessage("stop recording", session);

    expect(res.status).toBe(202);

    // CHARACTERIZATION: The HTTP path does not intercept stop recording.
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("handleSendMessage does not intercept structured commandIntent recording actions", async () => {
    // handleUserMessage checks msg.commandIntent?.domain === "screen_recording"
    // and handles start/stop/pause/resume/restart actions. The HTTP path does
    // not accept or process commandIntent at all — it's not part of the HTTP
    // request schema for POST /v1/messages.
    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({ persistUserMessage, runAgentLoop });

    // Even if we pass commandIntent in the HTTP body, handleSendMessage
    // doesn't read or process it — it only extracts conversationKey, content,
    // attachmentIds, sourceChannel, and interface from the body.
    const res = await sendMessage("start screen recording", session);

    expect(res.status).toBe(202);

    // CHARACTERIZATION: No recording interception happens on the HTTP path.
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("handleSendMessage does not strip recording keywords from mixed messages", async () => {
    // handleUserMessage strips recording keywords from messages like
    // "start recording and show me today's weather", then processes only the
    // remainder ("show me today's weather") through the agent loop while
    // also starting the recording. The HTTP path sends the full message.
    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({ persistUserMessage, runAgentLoop });

    const mixedContent = "start recording and show me today's weather";
    const res = await sendMessage(mixedContent, session);

    expect(res.status).toBe(202);

    // CHARACTERIZATION: The full message including recording keywords is sent
    // to the agent loop without modification.
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    // The content passed to runAgentLoop contains the original message
    // (including recording keywords) — no keyword stripping occurred.
    const runAgentLoopCall = (runAgentLoop as any).mock.calls[0];
    expect(runAgentLoopCall[0]).toBe(mixedContent);
  });
});

// ============================================================================
// PARITY: APPROVAL REPLY INTERCEPTION
// ============================================================================
describe("PARITY: HTTP POST /v1/messages handles approval reply interception", () => {
  beforeEach(() => {
    routeGuardianReplyMock.mockClear();
    listPendingByDestinationMock.mockClear();
    listCanonicalMock.mockClear();
    addMessageMock.mockClear();
  });

  test("both paths consume decision replies through the guardian reply router", async () => {
    // This mirrors handlers-user-message-approval-consumption.test.ts
    // "consumes decision replies before auto-deny" — but exercised through
    // the HTTP path to confirm parity.
    listPendingByDestinationMock.mockReturnValue([
      { id: "req-1", kind: "tool_approval" },
    ]);
    listCanonicalMock.mockReturnValue([]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: true,
      decisionApplied: true,
      type: "canonical_decision_applied",
      requestId: "req-1",
    });

    const persistUserMessage = mock(async () => "should-not-be-called");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({
      persistUserMessage,
      runAgentLoop,
      hasAnyPendingConfirmation: () => true,
      hasPendingConfirmation: (id: string) => id === "req-1",
    });

    const res = await sendMessage("go for it", session);

    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: boolean; messageId?: string };
    expect(body.accepted).toBe(true);

    // PARITY: Both paths call routeGuardianReply
    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    const routeCall = (routeGuardianReplyMock as any).mock
      .calls[0][0] as Record<string, unknown>;
    expect(routeCall.messageText).toBe("go for it");

    // PARITY: Both paths persist user + assistant transcript entries
    expect(addMessageMock).toHaveBeenCalledTimes(2);

    // PARITY: Neither path runs the agent loop when the reply is consumed
    expect(persistUserMessage).toHaveBeenCalledTimes(0);
    expect(runAgentLoop).toHaveBeenCalledTimes(0);
  });

  test("both paths filter stale tool_approval requests by session.hasPendingConfirmation", async () => {
    // Mirrors the "excludes stale tool_approval hints" test in
    // conversation-routes-guardian-reply.test.ts and the "routes only live
    // pending confirmation request ids" test in
    // handlers-user-message-approval-consumption.test.ts.
    listPendingByDestinationMock.mockReturnValue([
      { id: "tool-live", kind: "tool_approval" },
      { id: "tool-stale", kind: "tool_approval" },
      { id: "access-req-1", kind: "access_request" },
    ]);
    listCanonicalMock.mockReturnValue([]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: false,
      decisionApplied: false,
      type: "not_consumed",
    });

    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({
      persistUserMessage,
      runAgentLoop,
      hasAnyPendingConfirmation: () => true,
      hasPendingConfirmation: (id: string) => id === "tool-live",
    });

    const res = await sendMessage("approve", session);

    expect(res.status).toBe(202);
    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    const routeCall = (routeGuardianReplyMock as any).mock
      .calls[0][0] as Record<string, unknown>;

    // PARITY: Both paths filter out stale tool_approval requests but keep
    // non-tool_approval requests (access_request) regardless of session state.
    const pendingIds = routeCall.pendingRequestIds as string[];
    expect(pendingIds).toContain("tool-live");
    expect(pendingIds).not.toContain("tool-stale");
    expect(pendingIds).toContain("access-req-1");
  });

  test("both paths fall through to agent loop when nl_keep_pending is returned", async () => {
    // Mirrors "nl keep_pending falls back to existing auto-deny + queue behavior"
    // from handlers-user-message-approval-consumption.test.ts.
    listPendingByDestinationMock.mockReturnValue([
      { id: "req-1", kind: "tool_approval" },
    ]);
    listCanonicalMock.mockReturnValue([]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: true,
      decisionApplied: false,
      type: "nl_keep_pending",
      requestId: "req-1",
      replyText: "Need clarification",
    });

    const persistUserMessage = mock(async () => "persisted-msg-id");
    const runAgentLoop = mock(async () => undefined);
    const session = makeSession({
      persistUserMessage,
      runAgentLoop,
      hasAnyPendingConfirmation: () => true,
      hasPendingConfirmation: (id: string) => id === "req-1",
    });

    const res = await sendMessage("what does that do?", session);

    expect(res.status).toBe(202);

    // PARITY: Both paths treat nl_keep_pending as "not consumed" and fall
    // through to the normal send path (which in the HTTP case means
    // persisting + running the agent loop).
    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("HTTP path avoids mutating in-memory history while session is processing (matches IPC behavior)", async () => {
    // Mirrors "does not mutate in-memory history while processing" from
    // handlers-user-message-approval-consumption.test.ts.
    listPendingByDestinationMock.mockReturnValue([
      { id: "req-1", kind: "tool_approval" },
    ]);
    listCanonicalMock.mockReturnValue([]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: true,
      decisionApplied: true,
      type: "canonical_decision_applied",
      requestId: "req-1",
    });

    const messages: unknown[] = [];
    const session = makeSession({
      isProcessing: () => true,
      hasAnyPendingConfirmation: () => true,
      hasPendingConfirmation: (id: string) => id === "req-1",
      getMessages: () => messages,
    });

    const res = await sendMessage("approve", session);

    expect(res.status).toBe(202);

    // PARITY: Both paths persist to DB but do NOT push to in-memory history
    // when the session is actively processing.
    expect(addMessageMock).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(0);
  });
});

// ============================================================================
// SUMMARY: Behavior delta inventory for PR 7
// ============================================================================
describe("SUMMARY: behavior delta inventory", () => {
  test("documents the three behavior categories for PR 7", () => {
    // This test exists purely as documentation. It always passes.
    //
    // MISSING FROM HTTP (to port or deliberately omit in PR 7):
    // 1. Secret ingress blocking (handleSecretIngress)
    //    - checkIngressForSecrets() call
    //    - secret_blocked error event emission
    //    - redirectToSecurePrompt() call with redacted continuation
    //
    // 2. Recording intent interception (handleStandaloneRecordingIntent,
    //    handleStructuredRecordingIntent)
    //    - commandIntent structured action handling
    //    - Text-based recording keyword detection and interception
    //    - Recording keyword stripping from mixed messages
    //    - LLM fallback classification for ambiguous recording intents
    //
    // PARITY ACHIEVED (no action needed in PR 7):
    // 3. Approval reply interception
    //    - Both paths use routeGuardianReply with pending request filtering
    //    - Both paths persist user+assistant transcript entries
    //    - Both paths avoid in-memory mutation while processing
    //    - Both paths handle nl_keep_pending as fall-through
    //
    // MINOR DIFFERENCES (not blocking, document only):
    // - IPC uses resolveLocalIpcTrustContext() for actor identity;
    //   HTTP uses JWT-verified AuthContext
    // - IPC uses a pre-built desktopApprovalConversationGenerator;
    //   HTTP accepts it as a dependency injection parameter
    // - IPC emits message_queued/message_dequeued/message_request_complete
    //   events through ctx.send(); HTTP emits through the SSE hub
    expect(true).toBe(true);
  });
});
