import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "guardian-action-store-test-"));

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
  cancelGuardianActionRequest,
  createGuardianActionDelivery,
  createGuardianActionRequest,
  expireGuardianActionRequest,
  getDeliveriesByRequestId,
  getExpiredDeliveriesByConversation,
  getFollowupDeliveriesByConversation,
  getGuardianActionRequest,
  getPendingDeliveriesByConversation,
  startFollowupFromExpiredRequest,
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

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  });

  // ── Helper to create a pending request+delivery targeting a conversation ──
  function createPendingRequestWithDelivery(
    convId: string,
    deliveryConvId: string,
  ) {
    ensureConversation(convId);
    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, `Question for ${convId}`);
    const request = createGuardianActionRequest({
      kind: "ask_guardian",
      sourceChannel: "phone",
      sourceConversationId: convId,
      callSessionId: session.id,
      pendingQuestionId: pq.id,
      questionText: pq.questionText,
      expiresAt: Date.now() + 60_000,
    });
    const delivery = createGuardianActionDelivery({
      requestId: request.id,
      destinationChannel: "vellum",
      destinationConversationId: deliveryConvId,
    });
    updateDeliveryStatus(delivery.id, "sent");
    return { request, delivery };
  }

  // ── getPendingDeliveriesByConversation ──────────────────────────────

  test("getPendingDeliveriesByConversation returns all pending deliveries for a conversation", () => {
    const sharedConvId = "shared-pending-conv";
    ensureConversation(sharedConvId);

    const { request: req1 } = createPendingRequestWithDelivery(
      "source-conv-p1",
      sharedConvId,
    );
    const { request: req2 } = createPendingRequestWithDelivery(
      "source-conv-p2",
      sharedConvId,
    );

    const deliveries = getPendingDeliveriesByConversation(sharedConvId);
    expect(deliveries).toHaveLength(2);

    const requestIds = deliveries.map((d) => d.requestId);
    expect(requestIds).toContain(req1.id);
    expect(requestIds).toContain(req2.id);
  });

  test("getPendingDeliveriesByConversation returns single delivery (fast path preserved)", () => {
    const convId = "single-pending-conv";
    ensureConversation(convId);

    const { request } = createPendingRequestWithDelivery(
      "source-conv-single-p",
      convId,
    );

    const deliveries = getPendingDeliveriesByConversation(convId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].requestId).toBe(request.id);
  });

  test("getPendingDeliveriesByConversation returns empty for non-matching conversation", () => {
    ensureConversation("other-conv");
    createPendingRequestWithDelivery("source-conv-no-match", "other-conv");

    const deliveries = getPendingDeliveriesByConversation("nonexistent-conv");
    expect(deliveries).toHaveLength(0);
  });

  // ── getExpiredDeliveriesByConversation ──────────────────────────────

  test("getExpiredDeliveriesByConversation returns all expired deliveries for a conversation", () => {
    const sharedConvId = "shared-expired-conv";
    ensureConversation(sharedConvId);

    const { request: req1 } = createPendingRequestWithDelivery(
      "source-conv-e1",
      sharedConvId,
    );
    const { request: req2 } = createPendingRequestWithDelivery(
      "source-conv-e2",
      sharedConvId,
    );

    expireGuardianActionRequest(req1.id, "sweep_timeout");
    expireGuardianActionRequest(req2.id, "sweep_timeout");

    const deliveries = getExpiredDeliveriesByConversation(sharedConvId);
    expect(deliveries).toHaveLength(2);

    const requestIds = deliveries.map((d) => d.requestId);
    expect(requestIds).toContain(req1.id);
    expect(requestIds).toContain(req2.id);
  });

  test("getExpiredDeliveriesByConversation excludes deliveries with followup already started", () => {
    const convId = "expired-with-followup-conv";
    ensureConversation(convId);

    const { request: req1 } = createPendingRequestWithDelivery(
      "source-conv-ef1",
      convId,
    );
    const { request: req2 } = createPendingRequestWithDelivery(
      "source-conv-ef2",
      convId,
    );

    expireGuardianActionRequest(req1.id, "sweep_timeout");
    expireGuardianActionRequest(req2.id, "sweep_timeout");

    // Start followup on req1 — only req2 should remain in the expired query
    startFollowupFromExpiredRequest(req1.id, "late answer");

    const deliveries = getExpiredDeliveriesByConversation(convId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].requestId).toBe(req2.id);
  });

  // ── getFollowupDeliveriesByConversation ─────────────────────────────

  test("getFollowupDeliveriesByConversation returns all awaiting_guardian_choice deliveries", () => {
    const convId = "shared-followup-conv";
    ensureConversation(convId);

    const { request: req1 } = createPendingRequestWithDelivery(
      "source-conv-f1",
      convId,
    );
    const { request: req2 } = createPendingRequestWithDelivery(
      "source-conv-f2",
      convId,
    );

    expireGuardianActionRequest(req1.id, "sweep_timeout");
    expireGuardianActionRequest(req2.id, "sweep_timeout");

    startFollowupFromExpiredRequest(req1.id, "late answer 1");
    startFollowupFromExpiredRequest(req2.id, "late answer 2");

    const deliveries = getFollowupDeliveriesByConversation(convId);
    expect(deliveries).toHaveLength(2);

    const requestIds = deliveries.map((d) => d.requestId);
    expect(requestIds).toContain(req1.id);
    expect(requestIds).toContain(req2.id);
  });

  test("getFollowupDeliveriesByConversation returns empty for non-matching conversation", () => {
    const deliveries = getFollowupDeliveriesByConversation("nonexistent-conv");
    expect(deliveries).toHaveLength(0);
  });

  // ── cancelGuardianActionRequest ─────────────────────────────────────

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
