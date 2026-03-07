import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "guardian-action-late-reply-test-"));

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
}));

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async () => {},
}));

import { isTerminalState } from "../calls/call-state-machine.js";
import {
  createCallSession,
  createPendingQuestion,
  getCallSession,
  updateCallSession,
} from "../calls/call-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  createGuardianActionDelivery,
  createGuardianActionRequest,
  expireGuardianActionRequest,
  getExpiredDeliveriesByConversation,
  getExpiredDeliveriesByDestination,
  getExpiredDeliveryByConversation,
  getFollowupDeliveriesByConversation,
  getGuardianActionRequest,
  getPendingDeliveriesByConversation,
  getPendingRequestByCallSessionId,
  resolveGuardianActionRequest,
  startFollowupFromExpiredRequest,
  supersedeGuardianActionRequest,
  updateDeliveryStatus,
} from "../memory/guardian-action-store.js";
import { conversations } from "../memory/schema.js";

initializeDb();

function ensureConversation(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: `Conversation ${id}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM guardian_action_deliveries");
  db.run("DELETE FROM guardian_action_requests");
  db.run("DELETE FROM call_pending_questions");
  db.run("DELETE FROM call_events");
  db.run("DELETE FROM call_sessions");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function createExpiredRequest(
  convId: string,
  opts?: { chatId?: string; externalUserId?: string; conversationId?: string },
) {
  ensureConversation(convId);
  const session = createCallSession({
    conversationId: convId,
    provider: "twilio",
    fromNumber: "+15550001111",
    toNumber: "+15550002222",
  });
  const pq = createPendingQuestion(session.id, "What is the gate code?");
  const request = createGuardianActionRequest({
    kind: "ask_guardian",
    sourceChannel: "phone",
    sourceConversationId: convId,
    callSessionId: session.id,
    pendingQuestionId: pq.id,
    questionText: pq.questionText,
    expiresAt: Date.now() - 10_000, // already expired
  });

  // Create delivery
  const deliveryConvId = opts?.conversationId ?? `delivery-conv-${request.id}`;
  if (opts?.conversationId) {
    ensureConversation(opts.conversationId);
  } else {
    ensureConversation(deliveryConvId);
  }
  const delivery = createGuardianActionDelivery({
    requestId: request.id,
    destinationChannel: "telegram",
    destinationChatId: opts?.chatId ?? "chat-123",
    destinationExternalUserId: opts?.externalUserId ?? "user-456",
    destinationConversationId: deliveryConvId,
  });
  updateDeliveryStatus(delivery.id, "sent");

  // Expire the request and delivery
  expireGuardianActionRequest(request.id, "sweep_timeout");

  return {
    request: getGuardianActionRequest(request.id)!,
    delivery,
    deliveryConvId,
  };
}

describe("guardian-action-late-reply", () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* best effort */
    }
  });

  // ── getExpiredDeliveriesByDestination ──────────────────────────────

  test("getExpiredDeliveriesByDestination returns expired deliveries for follow-up eligible requests", () => {
    const { request } = createExpiredRequest("conv-late-1", {
      chatId: "chat-abc",
      externalUserId: "user-xyz",
    });

    const deliveries = getExpiredDeliveriesByDestination(
      "telegram",
      "chat-abc",
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].requestId).toBe(request.id);
    expect(deliveries[0].status).toBe("expired");
  });

  test("getExpiredDeliveriesByDestination returns empty for non-matching channel", () => {
    createExpiredRequest("conv-late-2", { chatId: "chat-abc" });

    const deliveries = getExpiredDeliveriesByDestination("phone", "chat-abc");
    expect(deliveries).toHaveLength(0);
  });

  test("getExpiredDeliveriesByDestination returns empty when followup already started", () => {
    const { request } = createExpiredRequest("conv-late-3", {
      chatId: "chat-started",
    });

    // Start a follow-up, transitioning followup_state from 'none' to 'awaiting_guardian_choice'
    startFollowupFromExpiredRequest(request.id, "late answer text");

    const deliveries = getExpiredDeliveriesByDestination(
      "telegram",
      "chat-started",
    );
    expect(deliveries).toHaveLength(0);
  });

  // ── getExpiredDeliveryByConversation ───────────────────────────────

  test("getExpiredDeliveryByConversation returns expired delivery for mac channel", () => {
    const { delivery, deliveryConvId } = createExpiredRequest("conv-late-4", {
      conversationId: "mac-conv-1",
    });

    const found = getExpiredDeliveryByConversation(deliveryConvId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(delivery.id);
  });

  test("getExpiredDeliveryByConversation returns null for non-matching conversation", () => {
    createExpiredRequest("conv-late-5", { conversationId: "mac-conv-2" });

    const found = getExpiredDeliveryByConversation("nonexistent-conv");
    expect(found).toBeNull();
  });

  test("getExpiredDeliveryByConversation returns null when followup already started", () => {
    const { request, deliveryConvId } = createExpiredRequest("conv-late-6", {
      conversationId: "mac-conv-3",
    });

    startFollowupFromExpiredRequest(request.id, "already answered");

    const found = getExpiredDeliveryByConversation(deliveryConvId);
    expect(found).toBeNull();
  });

  // ── startFollowupFromExpiredRequest ───────────────────────────────

  test("startFollowupFromExpiredRequest transitions to awaiting_guardian_choice and records late answer", () => {
    const { request } = createExpiredRequest("conv-late-7");

    const updated = startFollowupFromExpiredRequest(
      request.id,
      "The gate code is 1234",
    );
    expect(updated).not.toBeNull();
    expect(updated!.followupState).toBe("awaiting_guardian_choice");
    expect(updated!.lateAnswerText).toBe("The gate code is 1234");
    expect(updated!.lateAnsweredAt).toBeGreaterThan(0);
  });

  test("startFollowupFromExpiredRequest returns null if followup already started", () => {
    const { request } = createExpiredRequest("conv-late-8");

    // First call succeeds
    const first = startFollowupFromExpiredRequest(request.id, "answer 1");
    expect(first).not.toBeNull();

    // Second call fails — already in awaiting_guardian_choice
    const second = startFollowupFromExpiredRequest(request.id, "answer 2");
    expect(second).toBeNull();
  });

  test("startFollowupFromExpiredRequest returns null for pending requests (not expired)", () => {
    const convId = "conv-late-9";
    ensureConversation(convId);
    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "Still pending question");
    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: convId,
      callSessionId: session.id,
      pendingQuestionId: pq.id,
      questionText: pq.questionText,
      expiresAt: Date.now() + 60_000, // not expired
    });

    const result = startFollowupFromExpiredRequest(request.id, "late answer");
    expect(result).toBeNull();
  });

  // ── Follow-up flow for already-answered requests ──────────────────

  test("already-answered requests do not appear in expired delivery queries", () => {
    const convId = "conv-late-10";
    ensureConversation(convId);
    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "Already answered question");
    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: convId,
      callSessionId: session.id,
      pendingQuestionId: pq.id,
      questionText: pq.questionText,
      expiresAt: Date.now() + 60_000,
    });

    const answeredConvId = "answered-conv-1";
    ensureConversation(answeredConvId);
    const delivery = createGuardianActionDelivery({
      requestId: request.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-answered",
      destinationExternalUserId: "user-answered",
      destinationConversationId: answeredConvId,
    });
    updateDeliveryStatus(delivery.id, "sent");

    // Answer the request (transitions to 'answered', not 'expired')
    resolveGuardianActionRequest(
      request.id,
      "the code is 5678",
      "telegram",
      "user-answered",
    );

    // Should not appear in expired queries
    const expiredByDest = getExpiredDeliveriesByDestination(
      "telegram",
      "chat-answered",
    );
    expect(expiredByDest).toHaveLength(0);

    const expiredByConv = getExpiredDeliveryByConversation(answeredConvId);
    expect(expiredByConv).toBeNull();
  });

  // ── Composed follow-up text verification ──────────────────────────

  test("composeGuardianActionMessageGenerative produces follow-up text for late answer scenario", async () => {
    // The composer is tested directly rather than through the handler
    const { composeGuardianActionMessageGenerative } =
      await import("../runtime/guardian-action-message-composer.js");

    const text = await composeGuardianActionMessageGenerative({
      scenario: "guardian_late_answer_followup",
      questionText: "What is the gate code?",
      lateAnswerText: "The gate code is 1234",
    });

    // In test mode, the deterministic fallback is used
    expect(text).toContain("called earlier");
    expect(text).toContain("call them back");
  });

  test("composeGuardianActionMessageGenerative produces stale text for expired scenario", async () => {
    const { composeGuardianActionMessageGenerative } =
      await import("../runtime/guardian-action-message-composer.js");

    const text = await composeGuardianActionMessageGenerative({
      scenario: "guardian_stale_expired",
    });

    expect(text).toContain("expired");
  });

  // ── Multiple deliveries in one conversation (disambiguation) ──────

  describe("multi-delivery disambiguation in reused conversations", () => {
    // Helper to create a pending request with delivery in a shared conversation
    function createPendingInSharedConv(
      sourceConvId: string,
      sharedDeliveryConvId: string,
    ) {
      ensureConversation(sourceConvId);
      const session = createCallSession({
        conversationId: sourceConvId,
        provider: "twilio",
        fromNumber: "+15550001111",
        toNumber: "+15550002222",
      });
      const pq = createPendingQuestion(
        session.id,
        `Question from ${sourceConvId}`,
      );
      const request = createGuardianActionRequest({
        kind: "ask_guardian",
        sourceChannel: "phone",
        sourceConversationId: sourceConvId,
        callSessionId: session.id,
        pendingQuestionId: pq.id,
        questionText: pq.questionText,
        expiresAt: Date.now() + 60_000,
      });
      const delivery = createGuardianActionDelivery({
        requestId: request.id,
        destinationChannel: "vellum",
        destinationConversationId: sharedDeliveryConvId,
      });
      updateDeliveryStatus(delivery.id, "sent");
      return { request, delivery };
    }

    test("multiple pending deliveries in same conversation are returned by getPendingDeliveriesByConversation", () => {
      const sharedConv = "shared-reused-conv-pending";
      ensureConversation(sharedConv);

      const { request: req1 } = createPendingInSharedConv("src-p1", sharedConv);
      const { request: req2 } = createPendingInSharedConv("src-p2", sharedConv);

      const deliveries = getPendingDeliveriesByConversation(sharedConv);
      expect(deliveries).toHaveLength(2);

      const requestIds = deliveries.map((d) => d.requestId);
      expect(requestIds).toContain(req1.id);
      expect(requestIds).toContain(req2.id);
    });

    test("request codes are unique across multiple requests in same conversation", () => {
      const sharedConv = "shared-reused-conv-codes";
      ensureConversation(sharedConv);

      const { request: req1 } = createPendingInSharedConv(
        "src-code1",
        sharedConv,
      );
      const { request: req2 } = createPendingInSharedConv(
        "src-code2",
        sharedConv,
      );

      expect(req1.requestCode).not.toBe(req2.requestCode);
      expect(req1.requestCode).toHaveLength(6);
      expect(req2.requestCode).toHaveLength(6);
    });

    test("multiple expired deliveries in same conversation are returned by getExpiredDeliveriesByConversation", () => {
      const sharedConv = "shared-reused-conv-expired";
      ensureConversation(sharedConv);

      const { request: req1 } = createPendingInSharedConv("src-e1", sharedConv);
      const { request: req2 } = createPendingInSharedConv("src-e2", sharedConv);

      expireGuardianActionRequest(req1.id, "sweep_timeout");
      expireGuardianActionRequest(req2.id, "sweep_timeout");

      const deliveries = getExpiredDeliveriesByConversation(sharedConv);
      expect(deliveries).toHaveLength(2);

      const requestIds = deliveries.map((d) => d.requestId);
      expect(requestIds).toContain(req1.id);
      expect(requestIds).toContain(req2.id);
    });

    test("multiple followup deliveries in same conversation are returned by getFollowupDeliveriesByConversation", () => {
      const sharedConv = "shared-reused-conv-followup";
      ensureConversation(sharedConv);

      const { request: req1 } = createPendingInSharedConv(
        "src-fu1",
        sharedConv,
      );
      const { request: req2 } = createPendingInSharedConv(
        "src-fu2",
        sharedConv,
      );

      expireGuardianActionRequest(req1.id, "sweep_timeout");
      expireGuardianActionRequest(req2.id, "sweep_timeout");
      startFollowupFromExpiredRequest(req1.id, "late answer 1");
      startFollowupFromExpiredRequest(req2.id, "late answer 2");

      const deliveries = getFollowupDeliveriesByConversation(sharedConv);
      expect(deliveries).toHaveLength(2);

      const requestIds = deliveries.map((d) => d.requestId);
      expect(requestIds).toContain(req1.id);
      expect(requestIds).toContain(req2.id);
    });

    test("resolving one pending request leaves the other still pending in shared conversation", () => {
      const sharedConv = "shared-reused-conv-resolve-one";
      ensureConversation(sharedConv);

      const { request: req1 } = createPendingInSharedConv("src-r1", sharedConv);
      const { request: req2 } = createPendingInSharedConv("src-r2", sharedConv);

      resolveGuardianActionRequest(req1.id, "answer to first", "vellum");

      const remaining = getPendingDeliveriesByConversation(sharedConv);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].requestId).toBe(req2.id);
    });

    test("request code prefix matching is case-insensitive", () => {
      const sharedConv = "shared-reused-conv-case";
      ensureConversation(sharedConv);

      const { request: req1 } = createPendingInSharedConv(
        "src-case1",
        sharedConv,
      );
      const code = req1.requestCode; // e.g. "A1B2C3"

      // Simulate case-insensitive prefix matching as done in session-process.ts
      const userInput = `${code.toLowerCase()} the answer is 42`;
      const matched = userInput.toUpperCase().startsWith(code);
      expect(matched).toBe(true);

      // After stripping the code prefix, the answer text is extracted
      const answerText = userInput.slice(code.length).trim();
      expect(answerText).toBe("the answer is 42");
    });
  });

  // ── Superseded late-approval remap semantics ──────────────────────

  describe("superseded late-approval remap", () => {
    /**
     * Helper: create two guardian action requests on the same call session.
     * The first is superseded by the second (which stays pending).
     * Returns the superseded request, the current pending request, and the call session.
     */
    function createSupersededScenario(
      convId: string,
      opts?: {
        chatId?: string;
        externalUserId?: string;
        conversationId?: string;
      },
    ) {
      ensureConversation(convId);
      const session = createCallSession({
        conversationId: convId,
        provider: "twilio",
        fromNumber: "+15550001111",
        toNumber: "+15550002222",
      });
      // Keep call in 'initiated' status (non-terminal) — simulates active call
      const pqOld = createPendingQuestion(
        session.id,
        "What is the old gate code?",
      );
      const oldRequest = createGuardianActionRequest({
        kind: "ask_guardian",
        sourceChannel: "phone",
        sourceConversationId: convId,
        callSessionId: session.id,
        pendingQuestionId: pqOld.id,
        questionText: pqOld.questionText,
        expiresAt: Date.now() + 60_000,
        toolName: "check_gate",
        inputDigest: "digest-old",
      });

      // Create delivery for the old request
      const deliveryConvId =
        opts?.conversationId ?? `delivery-conv-${oldRequest.id}`;
      if (opts?.conversationId) {
        ensureConversation(opts.conversationId);
      } else {
        ensureConversation(deliveryConvId);
      }
      const oldDelivery = createGuardianActionDelivery({
        requestId: oldRequest.id,
        destinationChannel: "telegram",
        destinationChatId: opts?.chatId ?? "chat-123",
        destinationExternalUserId: opts?.externalUserId ?? "user-456",
        destinationConversationId: deliveryConvId,
      });
      updateDeliveryStatus(oldDelivery.id, "sent");

      // Create the new (current) pending request
      const pqNew = createPendingQuestion(
        session.id,
        "What is the new gate code?",
      );
      const newRequest = createGuardianActionRequest({
        kind: "ask_guardian",
        sourceChannel: "phone",
        sourceConversationId: convId,
        callSessionId: session.id,
        pendingQuestionId: pqNew.id,
        questionText: pqNew.questionText,
        expiresAt: Date.now() + 60_000,
        toolName: "check_gate",
        inputDigest: "digest-new",
      });

      // Supersede the old request
      supersedeGuardianActionRequest(oldRequest.id, newRequest.id);

      return {
        session,
        supersededRequest: getGuardianActionRequest(oldRequest.id)!,
        currentRequest: getGuardianActionRequest(newRequest.id)!,
        oldDelivery,
        deliveryConvId,
      };
    }

    test("superseded request has expired_reason=superseded and links to replacement", () => {
      const { supersededRequest, currentRequest } =
        createSupersededScenario("conv-supersede-1");

      expect(supersededRequest.status).toBe("expired");
      expect(supersededRequest.expiredReason).toBe("superseded");
      expect(supersededRequest.supersededByRequestId).toBe(currentRequest.id);
      expect(currentRequest.status).toBe("pending");
    });

    test("superseded request with active call and pending request is remap-eligible", () => {
      const { session, supersededRequest, currentRequest } =
        createSupersededScenario("conv-supersede-2");

      // Call should still be active (non-terminal)
      const callSession = getCallSession(session.id);
      expect(callSession).not.toBeNull();
      expect(isTerminalState(callSession!.status)).toBe(false);

      // Should find current pending request for the same call session
      const pending = getPendingRequestByCallSessionId(
        supersededRequest.callSessionId,
      );
      expect(pending).not.toBeNull();
      expect(pending!.id).toBe(currentRequest.id);

      // The superseded request is expired with reason 'superseded' and followup_state 'none'
      expect(supersededRequest.expiredReason).toBe("superseded");
      expect(supersededRequest.followupState).toBe("none");
    });

    test("superseded request with completed call is NOT remap-eligible — falls through to follow-up", () => {
      const { session, supersededRequest } =
        createSupersededScenario("conv-supersede-3");

      // Transition the call to a terminal state
      updateCallSession(session.id, { status: "in_progress" });
      updateCallSession(session.id, {
        status: "completed",
        endedAt: Date.now(),
      });

      // Call is now terminal
      const callSession = getCallSession(session.id);
      expect(callSession).not.toBeNull();
      expect(isTerminalState(callSession!.status)).toBe(true);

      // Even though expired_reason is 'superseded', the remap should not apply
      // because the call has ended. The follow-up path should be used instead.
      expect(supersededRequest.expiredReason).toBe("superseded");
    });

    test("timeout-expired request is NOT remap-eligible even with active call", () => {
      const convId = "conv-timeout-no-remap";
      ensureConversation(convId);
      const session = createCallSession({
        conversationId: convId,
        provider: "twilio",
        fromNumber: "+15550001111",
        toNumber: "+15550002222",
      });

      const pq = createPendingQuestion(session.id, "What is the code?");
      const request = createGuardianActionRequest({
        kind: "ask_guardian",
        sourceChannel: "phone",
        sourceConversationId: convId,
        callSessionId: session.id,
        pendingQuestionId: pq.id,
        questionText: pq.questionText,
        expiresAt: Date.now() - 10_000,
      });

      const deliveryConvId = `delivery-conv-${request.id}`;
      ensureConversation(deliveryConvId);
      const delivery = createGuardianActionDelivery({
        requestId: request.id,
        destinationChannel: "telegram",
        destinationChatId: "chat-timeout",
        destinationExternalUserId: "user-timeout",
        destinationConversationId: deliveryConvId,
      });
      updateDeliveryStatus(delivery.id, "sent");

      // Expire with sweep_timeout (NOT superseded)
      expireGuardianActionRequest(request.id, "sweep_timeout");

      const expired = getGuardianActionRequest(request.id)!;
      expect(expired.expiredReason).toBe("sweep_timeout");

      // Even if the call is active, this should follow the callback/message path
      // because it's a real timeout, not a supersession
      const callSession = getCallSession(session.id);
      expect(callSession).not.toBeNull();
      expect(isTerminalState(callSession!.status)).toBe(false);

      // startFollowupFromExpiredRequest should work normally for timeouts
      const followup = startFollowupFromExpiredRequest(
        request.id,
        "late answer",
      );
      expect(followup).not.toBeNull();
      expect(followup!.followupState).toBe("awaiting_guardian_choice");
    });

    test("call_timeout-expired request is NOT remap-eligible", () => {
      const convId = "conv-call-timeout-no-remap";
      ensureConversation(convId);
      const session = createCallSession({
        conversationId: convId,
        provider: "twilio",
        fromNumber: "+15550001111",
        toNumber: "+15550002222",
      });

      const pq = createPendingQuestion(session.id, "What is the code?");
      const request = createGuardianActionRequest({
        kind: "ask_guardian",
        sourceChannel: "phone",
        sourceConversationId: convId,
        callSessionId: session.id,
        pendingQuestionId: pq.id,
        questionText: pq.questionText,
        expiresAt: Date.now() - 10_000,
      });

      const deliveryConvId = `delivery-conv-${request.id}`;
      ensureConversation(deliveryConvId);
      const delivery = createGuardianActionDelivery({
        requestId: request.id,
        destinationChannel: "telegram",
        destinationChatId: "chat-call-timeout",
        destinationExternalUserId: "user-call-timeout",
        destinationConversationId: deliveryConvId,
      });
      updateDeliveryStatus(delivery.id, "sent");

      // Expire with call_timeout (NOT superseded)
      expireGuardianActionRequest(request.id, "call_timeout");

      const expired = getGuardianActionRequest(request.id)!;
      expect(expired.expiredReason).toBe("call_timeout");

      // call_timeout should follow the callback/message path regardless
      const followup = startFollowupFromExpiredRequest(
        request.id,
        "late answer for timeout",
      );
      expect(followup).not.toBeNull();
      expect(followup!.followupState).toBe("awaiting_guardian_choice");
    });

    test("superseded request with no pending replacement falls through to follow-up", () => {
      const { supersededRequest, currentRequest } = createSupersededScenario(
        "conv-supersede-no-pending",
      );

      // Resolve the current pending request so there's no pending replacement
      resolveGuardianActionRequest(
        currentRequest.id,
        "answered already",
        "telegram",
      );

      // No pending request for this call session anymore
      const pending = getPendingRequestByCallSessionId(
        supersededRequest.callSessionId,
      );
      expect(pending).toBeNull();

      // The superseded request should fall through to follow-up since
      // there's no pending request to remap to
      const followup = startFollowupFromExpiredRequest(
        supersededRequest.id,
        "late answer",
      );
      expect(followup).not.toBeNull();
      expect(followup!.followupState).toBe("awaiting_guardian_choice");
    });

    test("composeGuardianActionMessageGenerative produces remap text for superseded scenario", async () => {
      const { composeGuardianActionMessageGenerative } =
        await import("../runtime/guardian-action-message-composer.js");

      const text = await composeGuardianActionMessageGenerative({
        scenario: "guardian_superseded_remap",
        questionText: "What is the new gate code?",
      });

      // In test mode, the deterministic fallback is used
      expect(text).toContain("current active request");
      expect(text).toContain("What is the new gate code?");
    });

    test("composeGuardianActionMessageGenerative produces remap text without question", async () => {
      const { composeGuardianActionMessageGenerative } =
        await import("../runtime/guardian-action-message-composer.js");

      const text = await composeGuardianActionMessageGenerative({
        scenario: "guardian_superseded_remap",
      });

      expect(text).toContain("current active request");
    });
  });

  // ── Disambiguation hardening across states ──────────────────────────

  describe("disambiguation hardening across states", () => {
    // Helper to create a pending request with delivery in a shared conversation
    function createPendingInSharedConv(
      sourceConvId: string,
      sharedDeliveryConvId: string,
      opts?: { chatId?: string; externalUserId?: string },
    ) {
      ensureConversation(sourceConvId);
      const session = createCallSession({
        conversationId: sourceConvId,
        provider: "twilio",
        fromNumber: "+15550001111",
        toNumber: "+15550002222",
      });
      const pq = createPendingQuestion(
        session.id,
        `Question from ${sourceConvId}`,
      );
      const request = createGuardianActionRequest({
        kind: "ask_guardian",
        sourceChannel: "phone",
        sourceConversationId: sourceConvId,
        callSessionId: session.id,
        pendingQuestionId: pq.id,
        questionText: pq.questionText,
        expiresAt: Date.now() + 60_000,
      });
      const delivery = createGuardianActionDelivery({
        requestId: request.id,
        destinationChannel: "telegram",
        destinationChatId: opts?.chatId ?? "chat-disambig",
        destinationExternalUserId: opts?.externalUserId ?? "user-disambig",
        destinationConversationId: sharedDeliveryConvId,
      });
      updateDeliveryStatus(delivery.id, "sent");
      return {
        request: getGuardianActionRequest(request.id)!,
        delivery,
        session,
      };
    }

    test("single pending request auto-matches without code prefix", () => {
      // When there is only ONE pending request and no expired/follow-up,
      // the guardian's message should auto-match without needing a code prefix.
      const sharedConv = "shared-auto-match-single";
      ensureConversation(sharedConv);
      const { request } = createPendingInSharedConv("src-auto-1", sharedConv);

      // There should be exactly one pending delivery
      const pending = getPendingDeliveriesByConversation(sharedConv);
      expect(pending).toHaveLength(1);

      // No expired or follow-up deliveries
      const expired = getExpiredDeliveriesByConversation(sharedConv);
      const followup = getFollowupDeliveriesByConversation(sharedConv);
      expect(expired).toHaveLength(0);
      expect(followup).toHaveLength(0);

      // Total actionable is 1, so auto-match should apply
      const totalActionable = pending.length + expired.length + followup.length;
      expect(totalActionable).toBe(1);

      // The request is pending and ready for direct answer
      expect(request.status).toBe("pending");
    });

    test("multiple pending requests requires disambiguation", () => {
      // When multiple pending requests exist, the guardian must prefix with a code.
      const sharedConv = "shared-multi-pending-disambig";
      ensureConversation(sharedConv);
      const { request: req1 } = createPendingInSharedConv(
        "src-mp1",
        sharedConv,
      );
      const { request: req2 } = createPendingInSharedConv(
        "src-mp2",
        sharedConv,
      );

      const pending = getPendingDeliveriesByConversation(sharedConv);
      expect(pending).toHaveLength(2);

      // Both have unique codes
      expect(req1.requestCode).not.toBe(req2.requestCode);

      // Content without a valid code prefix should require disambiguation
      const testContent = "just a plain answer";
      const upperContent = testContent.toUpperCase();
      const matchesPending = pending.some((d) => {
        const req = getGuardianActionRequest(d.requestId);
        return req && upperContent.startsWith(req.requestCode);
      });
      expect(matchesPending).toBe(false);

      // Content with a valid code prefix should match
      const prefixedContent = `${req1.requestCode} the answer is 42`;
      const upperPrefixed = prefixedContent.toUpperCase();
      const matchesPrefixed = pending.some((d) => {
        const req = getGuardianActionRequest(d.requestId);
        return req && upperPrefixed.startsWith(req.requestCode);
      });
      expect(matchesPrefixed).toBe(true);
    });

    test("explicit code to superseded request with active call remaps with explanation", async () => {
      // When a guardian uses a code for a superseded request and the call is
      // still active with a current pending request, the system should remap.
      const convId = "conv-remap-with-code";
      ensureConversation(convId);
      const session = createCallSession({
        conversationId: convId,
        provider: "twilio",
        fromNumber: "+15550001111",
        toNumber: "+15550002222",
      });
      const pqOld = createPendingQuestion(session.id, "Old question?");
      const oldRequest = createGuardianActionRequest({
        kind: "ask_guardian",
        sourceChannel: "phone",
        sourceConversationId: convId,
        callSessionId: session.id,
        pendingQuestionId: pqOld.id,
        questionText: pqOld.questionText,
        expiresAt: Date.now() + 60_000,
        toolName: "check_gate",
        inputDigest: "digest-old-code",
      });

      const deliveryConvId = "delivery-remap-code";
      ensureConversation(deliveryConvId);
      const oldDelivery = createGuardianActionDelivery({
        requestId: oldRequest.id,
        destinationChannel: "telegram",
        destinationChatId: "chat-remap-code",
        destinationExternalUserId: "user-remap-code",
        destinationConversationId: deliveryConvId,
      });
      updateDeliveryStatus(oldDelivery.id, "sent");

      // Create new pending request that supersedes the old one
      const pqNew = createPendingQuestion(session.id, "New question?");
      const newRequest = createGuardianActionRequest({
        kind: "ask_guardian",
        sourceChannel: "phone",
        sourceConversationId: convId,
        callSessionId: session.id,
        pendingQuestionId: pqNew.id,
        questionText: pqNew.questionText,
        expiresAt: Date.now() + 60_000,
        toolName: "check_gate",
        inputDigest: "digest-new-code",
      });
      supersedeGuardianActionRequest(oldRequest.id, newRequest.id);

      // Verify the old request is superseded and the call is active
      const superseded = getGuardianActionRequest(oldRequest.id)!;
      expect(superseded.status).toBe("expired");
      expect(superseded.expiredReason).toBe("superseded");

      const callSession = getCallSession(session.id);
      expect(isTerminalState(callSession!.status)).toBe(false);

      // There should be a pending request for this call session (the new one)
      const currentPending = getPendingRequestByCallSessionId(session.id);
      expect(currentPending).not.toBeNull();
      expect(currentPending!.id).toBe(newRequest.id);

      // Compose the remap message
      const { composeGuardianActionMessageGenerative } =
        await import("../runtime/guardian-action-message-composer.js");
      const remapText = await composeGuardianActionMessageGenerative({
        scenario: "guardian_superseded_remap",
        questionText: currentPending!.questionText,
      });
      expect(remapText).toContain("current active request");
      expect(remapText).toContain("New question?");
    });

    test("explicit code to expired/timeout request returns terminal notice", async () => {
      // When a guardian uses a code for a timed-out expired request,
      // the system should follow the normal expired path (follow-up or stale).
      const { request } = createExpiredRequest("conv-expired-terminal", {
        chatId: "chat-expired-term",
        externalUserId: "user-expired-term",
      });

      expect(request.status).toBe("expired");
      expect(request.expiredReason).toBe("sweep_timeout");

      // When a follow-up can't be started (e.g. already handled), a stale notice is returned
      startFollowupFromExpiredRequest(request.id, "first answer");
      const secondAttempt = startFollowupFromExpiredRequest(
        request.id,
        "second answer",
      );
      expect(secondAttempt).toBeNull();

      // The stale message should be a terminal notice
      const { composeGuardianActionMessageGenerative } =
        await import("../runtime/guardian-action-message-composer.js");
      const staleText = await composeGuardianActionMessageGenerative({
        scenario: "guardian_stale_expired",
      });
      expect(staleText).toContain("expired");
      expect(staleText).toContain("No further action");
    });

    test("unknown code returns clear error message instead of loop", async () => {
      // When a guardian provides a code that doesn't match any known request,
      // the system should return a clear "unknown code" message.
      const { composeGuardianActionMessageGenerative } =
        await import("../runtime/guardian-action-message-composer.js");

      const unknownText = await composeGuardianActionMessageGenerative({
        scenario: "guardian_unknown_code",
        unknownCode: "XYZ999",
      });

      expect(unknownText).toContain("XYZ999");
      expect(unknownText).toContain("don't recognize");
      // Should NOT ask to prefix with code — that would create a loop
      expect(unknownText).not.toContain("prefix your reply");
    });

    test("priority order: pending is matched before follow-up before expired", () => {
      // Create deliveries in all three states in a shared conversation
      const sharedConv = "shared-priority-order";
      ensureConversation(sharedConv);

      // Create a pending request
      const { request: pendingReq } = createPendingInSharedConv(
        "src-prio-pending",
        sharedConv,
      );

      // Create an expired request
      const { request: expReq } = createPendingInSharedConv(
        "src-prio-expired",
        sharedConv,
      );
      expireGuardianActionRequest(expReq.id, "sweep_timeout");

      // Create a follow-up request (expired then started follow-up)
      const { request: fuReq } = createPendingInSharedConv(
        "src-prio-followup",
        sharedConv,
      );
      expireGuardianActionRequest(fuReq.id, "sweep_timeout");
      startFollowupFromExpiredRequest(fuReq.id, "late answer");

      // Gather all deliveries
      const pending = getPendingDeliveriesByConversation(sharedConv);
      const followup = getFollowupDeliveriesByConversation(sharedConv);
      const expired = getExpiredDeliveriesByConversation(sharedConv);

      expect(pending.length).toBeGreaterThan(0);
      expect(followup.length).toBeGreaterThan(0);
      expect(expired.length).toBeGreaterThan(0);

      // Simulate the priority matching order from the unified handler:
      // pending → follow-up → expired
      const orderedSets = [
        { deliveries: pending, state: "pending" },
        { deliveries: followup, state: "followup" },
        { deliveries: expired, state: "expired" },
      ];

      // When prefixed with the pending request's code, it should match pending first
      const pendingCode = pendingReq.requestCode;
      const pendingMessage = `${pendingCode} approve`;
      let matchedState: string | null = null;
      for (const { deliveries, state } of orderedSets) {
        for (const d of deliveries) {
          const req = getGuardianActionRequest(d.requestId);
          if (req && pendingMessage.toUpperCase().startsWith(req.requestCode)) {
            matchedState = state;
            break;
          }
        }
        if (matchedState) break;
      }
      expect(matchedState).toBe("pending");

      // When prefixed with the follow-up request's code, it should match follow-up
      // (because the pending check won't match that code)
      const fuRequest = getGuardianActionRequest(fuReq.id)!;
      const fuCode = fuRequest.requestCode;
      const fuMessage = `${fuCode} call back`;
      matchedState = null;
      for (const { deliveries, state } of orderedSets) {
        for (const d of deliveries) {
          const req = getGuardianActionRequest(d.requestId);
          if (req && fuMessage.toUpperCase().startsWith(req.requestCode)) {
            matchedState = state;
            break;
          }
        }
        if (matchedState) break;
      }
      expect(matchedState).toBe("followup");

      // When prefixed with the expired request's code, it should match expired
      const expRequest = getGuardianActionRequest(expReq.id)!;
      const expCode = expRequest.requestCode;
      const expMessage = `${expCode} yes`;
      matchedState = null;
      for (const { deliveries, state } of orderedSets) {
        for (const d of deliveries) {
          const req = getGuardianActionRequest(d.requestId);
          if (req && expMessage.toUpperCase().startsWith(req.requestCode)) {
            matchedState = state;
            break;
          }
        }
        if (matchedState) break;
      }
      expect(matchedState).toBe("expired");
    });
  });
});
