import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const deliveredMessages: Array<{
  url: string;
  body: Record<string, unknown>;
}> = [];

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (url: string, body: Record<string, unknown>) => {
    deliveredMessages.push({ url, body });
  },
}));

import {
  createCallSession,
  createPendingQuestion,
  getPendingQuestion,
} from "../calls/call-store.js";
import {
  startGuardianActionSweep,
  stopGuardianActionSweep,
  sweepExpiredGuardianActions,
} from "../calls/guardian-action-sweep.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  createGuardianActionDelivery,
  createGuardianActionRequest,
  getDeliveriesByRequestId,
  getGuardianActionRequest,
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
  deliveredMessages.length = 0;
}

describe("guardian-action-sweep", () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    stopGuardianActionSweep();
    resetDb();
  });

  test("sweepExpiredGuardianActions expires requests past their expiresAt", async () => {
    const convId = "conv-sweep-1";
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "What is the code?");

    // Create request that has already expired
    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: convId,
      callSessionId: session.id,
      pendingQuestionId: pq.id,
      questionText: pq.questionText,
      expiresAt: Date.now() - 10_000, // expired 10s ago
    });

    ensureConversation("conv-mac-1");
    createGuardianActionDelivery({
      requestId: request.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-mac-1",
    });
    updateDeliveryStatus(
      getDeliveriesByRequestId(request.id).find(
        (d) => d.destinationChannel === "vellum",
      )!.id,
      "sent",
    );

    await sweepExpiredGuardianActions();

    const updatedRequest = getGuardianActionRequest(request.id);
    expect(updatedRequest).not.toBeNull();
    expect(updatedRequest!.status).toBe("expired");

    const deliveries = getDeliveriesByRequestId(request.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("expired");
  });

  test("sweepExpiredGuardianActions expires pending questions", async () => {
    const convId = "conv-sweep-2";
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "What is the gate code?");

    createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: convId,
      callSessionId: session.id,
      pendingQuestionId: pq.id,
      questionText: pq.questionText,
      expiresAt: Date.now() - 5_000,
    });

    // Verify the question is still pending before sweep
    expect(getPendingQuestion(session.id)).not.toBeNull();

    await sweepExpiredGuardianActions();

    // Pending question should be expired
    expect(getPendingQuestion(session.id)).toBeNull();
  });

  test("sweepExpiredGuardianActions does nothing when no expired requests exist", async () => {
    const convId = "conv-sweep-3";
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "Still valid?");

    // Request that expires in the future
    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: convId,
      callSessionId: session.id,
      pendingQuestionId: pq.id,
      questionText: pq.questionText,
      expiresAt: Date.now() + 60_000, // expires in 60s
    });

    await sweepExpiredGuardianActions();

    const updatedRequest = getGuardianActionRequest(request.id);
    expect(updatedRequest!.status).toBe("pending");
    expect(getPendingQuestion(session.id)).not.toBeNull();
  });

  test("sweepExpiredGuardianActions sends external channel expiry notices for sent deliveries", async () => {
    const convId = "conv-sweep-4";
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "External question?");

    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: convId,
      callSessionId: session.id,
      pendingQuestionId: pq.id,
      questionText: pq.questionText,
      expiresAt: Date.now() - 5_000,
    });

    const delivery = createGuardianActionDelivery({
      requestId: request.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-123",
    });
    updateDeliveryStatus(delivery.id, "sent");

    await sweepExpiredGuardianActions();

    // Wait for the fire-and-forget async delivery to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The external delivery should trigger an HTTP POST to the gateway
    expect(deliveredMessages.length).toBeGreaterThanOrEqual(1);
  });

  test("sweepExpiredGuardianActions skips failed deliveries", async () => {
    const convId = "conv-sweep-5";
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "Skip this?");

    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: convId,
      callSessionId: session.id,
      pendingQuestionId: pq.id,
      questionText: pq.questionText,
      expiresAt: Date.now() - 5_000,
    });

    const delivery = createGuardianActionDelivery({
      requestId: request.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-456",
    });
    updateDeliveryStatus(delivery.id, "failed", "Network error");

    deliveredMessages.length = 0;

    await sweepExpiredGuardianActions();

    // Should NOT have sent an expiry notice for a failed delivery
    expect(deliveredMessages).toHaveLength(0);
  });

  test("startGuardianActionSweep and stopGuardianActionSweep manage timer", () => {
    startGuardianActionSweep();
    // Calling start again should be a no-op (idempotent)
    startGuardianActionSweep();

    stopGuardianActionSweep();
    // Calling stop again should be safe
    stopGuardianActionSweep();
  });
});
