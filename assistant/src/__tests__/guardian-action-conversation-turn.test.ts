import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(
  join(tmpdir(), "guardian-action-conversation-turn-test-"),
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

import {
  createCallSession,
  createPendingQuestion,
} from "../calls/call-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  createGuardianActionDelivery,
  createGuardianActionRequest,
  finalizeFollowup,
  getFollowupDeliveriesByDestination,
  getFollowupDeliveryByConversation,
  getGuardianActionRequest,
  markTimedOutWithReason,
  progressFollowupState,
  startFollowupFromExpiredRequest,
  updateDeliveryStatus,
} from "../memory/guardian-action-store.js";
import { conversations } from "../memory/schema.js";
import { processGuardianFollowUpTurn } from "../runtime/guardian-action-conversation-turn.js";
import type {
  GuardianFollowUpConversationContext,
  GuardianFollowUpConversationGenerator,
  GuardianFollowUpTurnResult,
} from "../runtime/http-types.js";

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

function createAwaitingChoiceRequest(
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

  // Expire the request
  markTimedOutWithReason(request.id, "call_timeout");

  // Start follow-up (transitions to awaiting_guardian_choice)
  startFollowupFromExpiredRequest(request.id, "The gate code is 1234");

  return {
    request: getGuardianActionRequest(request.id)!,
    delivery,
    deliveryConvId,
  };
}

// ---------------------------------------------------------------------------
// Helpers for creating mock generators
// ---------------------------------------------------------------------------

function createMockGenerator(
  result: GuardianFollowUpTurnResult,
): GuardianFollowUpConversationGenerator {
  return async (_context: GuardianFollowUpConversationContext) => result;
}

function createFailingGenerator(): GuardianFollowUpConversationGenerator {
  return async () => {
    throw new Error("LLM provider unavailable");
  };
}

describe("guardian-action-conversation-turn", () => {
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

  // ── processGuardianFollowUpTurn: classification ─────────────────────

  test('classifies "call them back" as call_back', async () => {
    const generator = createMockGenerator({
      disposition: "call_back",
      replyText: "Sure, I'll call them back right away.",
    });

    const result = await processGuardianFollowUpTurn(
      {
        questionText: "What is the gate code?",
        lateAnswerText: "The gate code is 1234",
        guardianReply: "Yes, call them back",
      },
      generator,
    );

    expect(result.disposition).toBe("call_back");
    expect(result.replyText).toBe("Sure, I'll call them back right away.");
  });

  test('classifies "never mind" as decline', async () => {
    const generator = createMockGenerator({
      disposition: "decline",
      replyText: "No problem. Let me know if you change your mind.",
    });

    const result = await processGuardianFollowUpTurn(
      {
        questionText: "What is the gate code?",
        lateAnswerText: "The gate code is 1234",
        guardianReply: "Never mind, forget it",
      },
      generator,
    );

    expect(result.disposition).toBe("decline");
    expect(result.replyText).toBe(
      "No problem. Let me know if you change your mind.",
    );
  });

  test("classifies ambiguous input as keep_pending with clarification", async () => {
    const generator = createMockGenerator({
      disposition: "keep_pending",
      replyText: "Would you like to call them back or send a text message?",
    });

    const result = await processGuardianFollowUpTurn(
      {
        questionText: "What is the gate code?",
        lateAnswerText: "The gate code is 1234",
        guardianReply: "hmm I dunno",
      },
      generator,
    );

    expect(result.disposition).toBe("keep_pending");
    expect(result.replyText).toContain("call them back");
  });

  // ── Failure modes ───────────────────────────────────────────────────

  test("generator failure returns keep_pending with safe fallback", async () => {
    const generator = createFailingGenerator();

    const result = await processGuardianFollowUpTurn(
      {
        questionText: "What is the gate code?",
        lateAnswerText: "The gate code is 1234",
        guardianReply: "Call them back please",
      },
      generator,
    );

    expect(result.disposition).toBe("keep_pending");
    expect(result.replyText.length).toBeGreaterThan(0);
  });

  test("no generator returns keep_pending with safe fallback", async () => {
    const result = await processGuardianFollowUpTurn(
      {
        questionText: "What is the gate code?",
        lateAnswerText: "The gate code is 1234",
        guardianReply: "Call them back",
      },
      undefined,
    );

    expect(result.disposition).toBe("keep_pending");
    expect(result.replyText.length).toBeGreaterThan(0);
  });

  test("generator returning empty replyText falls back to keep_pending", async () => {
    const generator = createMockGenerator({
      disposition: "call_back",
      replyText: "",
    });

    const result = await processGuardianFollowUpTurn(
      {
        questionText: "What is the gate code?",
        lateAnswerText: "The gate code is 1234",
        guardianReply: "Call them back",
      },
      generator,
    );

    expect(result.disposition).toBe("keep_pending");
  });

  test("generator returning invalid disposition falls back to keep_pending", async () => {
    const generator: GuardianFollowUpConversationGenerator = async () => {
      return {
        disposition:
          "invalid_value" as GuardianFollowUpTurnResult["disposition"],
        replyText: "Some reply",
      };
    };

    const result = await processGuardianFollowUpTurn(
      {
        questionText: "What is the gate code?",
        lateAnswerText: "The gate code is 1234",
        guardianReply: "Call them back",
      },
      generator,
    );

    expect(result.disposition).toBe("keep_pending");
  });

  test("reply text is always present in the result", async () => {
    // With generator
    const generatorResult = await processGuardianFollowUpTurn(
      {
        questionText: "What is the gate code?",
        lateAnswerText: "The gate code is 1234",
        guardianReply: "Call them",
      },
      createMockGenerator({
        disposition: "call_back",
        replyText: "Calling now!",
      }),
    );
    expect(typeof generatorResult.replyText).toBe("string");
    expect(generatorResult.replyText.length).toBeGreaterThan(0);

    // Without generator
    const fallbackResult = await processGuardianFollowUpTurn({
      questionText: "What is the gate code?",
      lateAnswerText: "The gate code is 1234",
      guardianReply: "Call them",
    });
    expect(typeof fallbackResult.replyText).toBe("string");
    expect(fallbackResult.replyText.length).toBeGreaterThan(0);

    // With failing generator
    const failResult = await processGuardianFollowUpTurn(
      {
        questionText: "What is the gate code?",
        lateAnswerText: "The gate code is 1234",
        guardianReply: "Call them",
      },
      createFailingGenerator(),
    );
    expect(typeof failResult.replyText).toBe("string");
    expect(failResult.replyText.length).toBeGreaterThan(0);
  });

  // ── Store queries for awaiting_guardian_choice ───────────────────────

  test("getFollowupDeliveriesByDestination returns deliveries in awaiting_guardian_choice", () => {
    const { request } = createAwaitingChoiceRequest("conv-turn-1", {
      chatId: "chat-abc",
      externalUserId: "user-xyz",
    });

    const deliveries = getFollowupDeliveriesByDestination(
      "telegram",
      "chat-abc",
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].requestId).toBe(request.id);
  });

  test("getFollowupDeliveriesByDestination returns empty for non-matching channel", () => {
    createAwaitingChoiceRequest("conv-turn-2", { chatId: "chat-abc" });

    const deliveries = getFollowupDeliveriesByDestination("phone", "chat-abc");
    expect(deliveries).toHaveLength(0);
  });

  test("getFollowupDeliveriesByDestination returns empty for expired with followup_state=none", () => {
    // Create expired request WITHOUT starting follow-up
    ensureConversation("conv-turn-3");
    const session = createCallSession({
      conversationId: "conv-turn-3",
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "Question?");
    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: "conv-turn-3",
      callSessionId: session.id,
      pendingQuestionId: pq.id,
      questionText: pq.questionText,
      expiresAt: Date.now() - 10_000,
    });
    ensureConversation(`delivery-conv-${request.id}`);
    const delivery = createGuardianActionDelivery({
      requestId: request.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-none",
      destinationExternalUserId: "user-none",
      destinationConversationId: `delivery-conv-${request.id}`,
    });
    updateDeliveryStatus(delivery.id, "sent");
    markTimedOutWithReason(request.id, "call_timeout");

    // followup_state is 'none' — should not appear
    const deliveries = getFollowupDeliveriesByDestination(
      "telegram",
      "chat-none",
    );
    expect(deliveries).toHaveLength(0);
  });

  test("getFollowupDeliveryByConversation returns delivery in awaiting_guardian_choice", () => {
    const { delivery, deliveryConvId } = createAwaitingChoiceRequest(
      "conv-turn-4",
      {
        conversationId: "mac-conv-1",
      },
    );

    const found = getFollowupDeliveryByConversation(deliveryConvId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(delivery.id);
  });

  test("getFollowupDeliveryByConversation returns null for non-matching conversation", () => {
    createAwaitingChoiceRequest("conv-turn-5", {
      conversationId: "mac-conv-2",
    });

    const found = getFollowupDeliveryByConversation("nonexistent-conv");
    expect(found).toBeNull();
  });

  // ── State transitions from conversation engine results ──────────────

  test("call_back disposition transitions to dispatching with call_back action", () => {
    const { request } = createAwaitingChoiceRequest("conv-turn-6");

    // Simulate what the handler does with a call_back disposition
    const updated = progressFollowupState(
      request.id,
      "dispatching",
      "call_back",
    );
    expect(updated).not.toBeNull();
    expect(updated!.followupState).toBe("dispatching");
    expect(updated!.followupAction).toBe("call_back");
  });

  test("decline disposition finalizes to declined", () => {
    const { request } = createAwaitingChoiceRequest("conv-turn-8");

    const updated = finalizeFollowup(request.id, "declined");
    expect(updated).not.toBeNull();
    expect(updated!.followupState).toBe("declined");
    expect(updated!.followupCompletedAt).toBeGreaterThan(0);
  });

  test("keep_pending disposition does not change state", () => {
    const { request } = createAwaitingChoiceRequest("conv-turn-9");

    // No state change for keep_pending — just verify the state is still awaiting_guardian_choice
    const reloaded = getGuardianActionRequest(request.id);
    expect(reloaded!.followupState).toBe("awaiting_guardian_choice");
  });

  test("state transitions are atomic: second call_back after dispatching fails", () => {
    const { request } = createAwaitingChoiceRequest("conv-turn-10");

    const first = progressFollowupState(request.id, "dispatching", "call_back");
    expect(first).not.toBeNull();

    // Second attempt: already in dispatching, cannot re-enter dispatching
    const second = progressFollowupState(
      request.id,
      "dispatching",
      "call_back",
    );
    expect(second).toBeNull();

    // Original action preserved
    const reloaded = getGuardianActionRequest(request.id);
    expect(reloaded!.followupAction).toBe("call_back");
  });
});
