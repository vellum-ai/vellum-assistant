import { beforeEach, describe, expect, mock, test } from "bun:test";

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
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  cancelGuardianActionRequest,
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
  db.run("DELETE FROM conversations");
}

describe("guardian-action-store", () => {
  beforeEach(() => {
    resetTables();
  });

  test("cancelGuardianActionRequest cancels both pending and sent deliveries", () => {
    const conversationId = "conv-guardian-cancel";
    ensureConversation(conversationId);

    const session = createCallSession({
      conversationId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pendingQuestion = createPendingQuestion(
      session.id,
      "What is our gate code?",
    );

    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: conversationId,
      callSessionId: session.id,
      pendingQuestionId: pendingQuestion.id,
      questionText: pendingQuestion.questionText,
      expiresAt: Date.now() + 60_000,
    });

    const pendingDelivery = createGuardianActionDelivery({
      requestId: request.id,
      destinationChannel: "vellum",
      destinationConversationId: "conv-mac-guardian",
    });
    const sentDelivery = createGuardianActionDelivery({
      requestId: request.id,
      destinationChannel: "telegram",
      destinationChatId: "chat-guardian",
      destinationExternalUserId: "guardian-user",
    });
    updateDeliveryStatus(sentDelivery.id, "sent");

    cancelGuardianActionRequest(request.id);

    const updatedRequest = getGuardianActionRequest(request.id);
    expect(updatedRequest).not.toBeNull();
    expect(updatedRequest!.status).toBe("cancelled");

    const deliveries = getDeliveriesByRequestId(request.id);
    const pendingAfter = deliveries.find((d) => d.id === pendingDelivery.id);
    const sentAfter = deliveries.find((d) => d.id === sentDelivery.id);
    expect(pendingAfter?.status).toBe("cancelled");
    expect(sentAfter?.status).toBe("cancelled");
  });
});
