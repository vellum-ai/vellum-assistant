import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(
  join(tmpdir(), "guardian-action-followup-executor-test-"),
);

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
}));

// Track call starts for assertions
const startedCalls: Array<{
  phoneNumber: string;
  task: string;
  conversationId: string;
}> = [];
let mockStartCallResult:
  | {
      ok: true;
      session: { id: string };
      callSid: string;
      callerIdentityMode: string;
    }
  | { ok: false; error: string } = {
  ok: true,
  session: { id: "mock-call-session" },
  callSid: "CA-mock",
  callerIdentityMode: "assistant_number",
};

mock.module("../calls/call-domain.js", () => ({
  startCall: async (input: {
    phoneNumber: string;
    task: string;
    conversationId: string;
  }) => {
    startedCalls.push(input);
    return mockStartCallResult;
  },
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

// Mock conversation-key-store for call_back conversation creation
let conversationCounter = 0;
mock.module("../memory/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({
    conversationId: `mock-conv-${++conversationCounter}`,
    created: true,
  }),
}));

import {
  createCallSession,
  createPendingQuestion,
} from "../calls/call-store.js";
import { initializeDb, resetDb } from "../memory/db.js";
import { getDb } from "../memory/db.js";
import {
  createGuardianActionDelivery,
  createGuardianActionRequest,
  getGuardianActionRequest,
  markTimedOutWithReason,
  progressFollowupState,
  startFollowupFromExpiredRequest,
  updateDeliveryStatus,
} from "../memory/guardian-action-store.js";
import { conversations } from "../memory/schema.js";
import { executeFollowupAction } from "../runtime/guardian-action-followup-executor.js";
import { resolveCounterparty } from "../runtime/guardian-action-followup-executor.js";

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
  startedCalls.length = 0;
  conversationCounter = 0;
  mockStartCallResult = {
    ok: true,
    session: { id: "mock-call-session" },
    callSid: "CA-mock",
    callerIdentityMode: "assistant_number",
  };
}

/**
 * Create a request in `dispatching` state ready for the executor.
 * The call session has fromNumber='+15550001111' (the counterparty).
 */
function createDispatchingRequest(convId: string, action: "call_back") {
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
    expiresAt: Date.now() - 10_000,
  });

  const deliveryConvId = `delivery-conv-${request.id}`;
  ensureConversation(deliveryConvId);
  const delivery = createGuardianActionDelivery({
    requestId: request.id,
    destinationChannel: "telegram",
    destinationChatId: "chat-123",
    destinationExternalUserId: "user-456",
    destinationConversationId: deliveryConvId,
  });
  updateDeliveryStatus(delivery.id, "sent");

  // Expire the request
  markTimedOutWithReason(request.id, "call_timeout");

  // Start follow-up
  startFollowupFromExpiredRequest(request.id, "The gate code is 1234");

  // Progress to dispatching with the given action
  progressFollowupState(request.id, "dispatching", action);

  return {
    request: getGuardianActionRequest(request.id)!,
    delivery,
    callSession: session,
  };
}

describe("guardian-action-followup-executor", () => {
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

  // ── Counterparty resolution ─────────────────────────────────────────

  describe("resolveCounterparty", () => {
    test("resolves fromNumber as counterparty for inbound call", () => {
      ensureConversation("cp-test-1");
      const session = createCallSession({
        conversationId: "cp-test-1",
        provider: "twilio",
        fromNumber: "+15550001111",
        toNumber: "+15550002222",
      });

      const result = resolveCounterparty(session.id);
      expect(result).not.toBeNull();
      expect(result!.phoneNumber).toBe("+15550001111");
      expect(result!.displayIdentifier).toBe("+15550001111");
    });

    test("resolves toNumber as counterparty for outbound call", () => {
      ensureConversation("cp-test-outbound");
      const session = createCallSession({
        conversationId: "cp-test-outbound",
        provider: "twilio",
        fromNumber: "+15550002222", // assistant's number
        toNumber: "+15550001111", // callee (the counterparty)
        initiatedFromConversationId: "cp-test-outbound", // signals outbound
      });

      const result = resolveCounterparty(session.id);
      expect(result).not.toBeNull();
      expect(result!.phoneNumber).toBe("+15550001111");
      expect(result!.displayIdentifier).toBe("+15550001111");
    });

    test("returns null for nonexistent call session", () => {
      const result = resolveCounterparty("nonexistent-session-id");
      expect(result).toBeNull();
    });
  });

  // ── call_back execution ─────────────────────────────────────────────

  describe("call_back", () => {
    test("starts outbound call to counterparty and finalizes as completed", async () => {
      const { request } = createDispatchingRequest("exec-call-1", "call_back");

      const result = await executeFollowupAction(request.id, "call_back");

      expect(result.ok).toBe(true);
      expect(result.action).toBe("call_back");
      expect(result.guardianReplyText.length).toBeGreaterThan(0);

      // Verify call was started to the counterparty
      expect(startedCalls.length).toBe(1);
      expect(startedCalls[0].phoneNumber).toBe("+15550001111");
      expect(startedCalls[0].task).toContain("gate code");

      // Verify follow-up state is completed
      const updated = getGuardianActionRequest(request.id);
      expect(updated!.followupState).toBe("completed");
      expect(updated!.followupCompletedAt).toBeGreaterThan(0);
    });

    test("confirmation text mentions calling back", async () => {
      const { request } = createDispatchingRequest("exec-call-2", "call_back");

      const result = await executeFollowupAction(request.id, "call_back");

      expect(result.ok).toBe(true);
      expect(result.guardianReplyText).toContain("calling");
    });

    test("failed call start finalizes as failed with error message", async () => {
      mockStartCallResult = { ok: false, error: "Twilio account suspended" };
      const { request } = createDispatchingRequest(
        "exec-call-fail-1",
        "call_back",
      );

      const result = await executeFollowupAction(request.id, "call_back");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Twilio account suspended");
      }
      expect(result.guardianReplyText.length).toBeGreaterThan(0);

      // Verify follow-up state is failed
      const updated = getGuardianActionRequest(request.id);
      expect(updated!.followupState).toBe("failed");
      expect(updated!.followupCompletedAt).toBeGreaterThan(0);
    });
  });

  // ── Error handling ──────────────────────────────────────────────────

  describe("error handling", () => {
    test("nonexistent request returns failure with error message", async () => {
      const result = await executeFollowupAction("nonexistent-id", "call_back");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("not found");
      }
      expect(result.guardianReplyText.length).toBeGreaterThan(0);
    });

    test("request not in dispatching state returns failure", async () => {
      // Create a request in awaiting_guardian_choice (not dispatching)
      ensureConversation("exec-wrong-state");
      const session = createCallSession({
        conversationId: "exec-wrong-state",
        provider: "twilio",
        fromNumber: "+15550001111",
        toNumber: "+15550002222",
      });
      const pq = createPendingQuestion(session.id, "Question?");
      const request = createGuardianActionRequest({
        kind: "ask_guardian",
        sourceChannel: "phone",
        sourceConversationId: "exec-wrong-state",
        callSessionId: session.id,
        pendingQuestionId: pq.id,
        questionText: pq.questionText,
        expiresAt: Date.now() - 10_000,
      });
      markTimedOutWithReason(request.id, "call_timeout");
      startFollowupFromExpiredRequest(request.id, "Answer");
      // Still in awaiting_guardian_choice — do NOT progress to dispatching

      const result = await executeFollowupAction(request.id, "call_back");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Invalid followup state");
      }
    });

    test("follow-up states terminate correctly on success", async () => {
      const { request } = createDispatchingRequest("exec-state-1", "call_back");

      await executeFollowupAction(request.id, "call_back");

      const updated = getGuardianActionRequest(request.id);
      expect(updated!.followupState).toBe("completed");
      expect(updated!.followupCompletedAt).not.toBeNull();
    });

    test("follow-up states terminate correctly on failure", async () => {
      mockStartCallResult = { ok: false, error: "Provider error" };
      const { request } = createDispatchingRequest("exec-state-2", "call_back");

      await executeFollowupAction(request.id, "call_back");

      const updated = getGuardianActionRequest(request.id);
      expect(updated!.followupState).toBe("failed");
      expect(updated!.followupCompletedAt).not.toBeNull();
    });
  });
});
