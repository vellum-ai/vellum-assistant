/**
 * DB-backed tests for guardian-context enrichment of notification conversation
 * candidates.
 *
 * `buildConversationCandidates` counts each candidate's pending guardian
 * requests through the gateway client's conversation-scope query, which
 * matches both a request's source conversation and any conversation its card
 * was delivered to. These tests lock that wiring — in particular that a
 * request delivered to a conversation different from its synthetic source is
 * still counted for the conversation that shows the card.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// The recorder and candidate builder go through the gateway client; serve
// that surface from the in-memory sim the tests seed.
import {
  bridgeState,
  gatewayGuardianRequestsStoreBridge,
} from "./helpers/gateway-guardian-requests-store-bridge.js";

mock.module(
  "../channels/gateway-guardian-requests.js",
  () => gatewayGuardianRequestsStoreBridge,
);

import { recordGuardianRequestDeliveries } from "../notifications/canonical-delivery-recorder.js";
import { buildConversationCandidates } from "../notifications/conversation-candidates.js";
import { createDecision } from "../notifications/decisions-store.js";
import { createDelivery } from "../notifications/deliveries-store.js";
import { createEvent } from "../notifications/events-store.js";
import type { NotificationChannel } from "../notifications/types.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations } from "../persistence/schema/index.js";

await initializeDb();

const TEST_PRINCIPAL = "test-principal-id";
const CHANNEL = "vellum" as NotificationChannel;

function resetTables(): void {
  const db = getDb();
  bridgeState.reset();
  db.run("DELETE FROM notification_deliveries");
  db.run("DELETE FROM notification_decisions");
  db.run("DELETE FROM notification_events");
  db.run("DELETE FROM conversations");
}

/**
 * Seed a conversation the candidate builder will surface: a "sent" notification
 * delivery wired event -> decision -> delivery -> conversation on `channel`.
 */
function seedCandidateConversation(
  conversationId: string,
  channel: NotificationChannel = CHANNEL,
): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id: conversationId,
      title: "Test thread",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const eventId = `evt-${conversationId}`;
  const decisionId = `dec-${conversationId}`;
  createEvent({
    id: eventId,
    sourceEventName: "schedule.notify",
    sourceChannel: channel,
    sourceContextId: conversationId,
    attentionHints: {
      requiresAction: false,
      urgency: "low",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    payload: {},
  });
  createDecision({
    id: decisionId,
    notificationEventId: eventId,
    shouldNotify: true,
    selectedChannels: [channel],
    reasoningSummary: "test",
    confidence: 1,
    fallbackUsed: false,
  });
  createDelivery({
    id: `del-${conversationId}`,
    notificationDecisionId: decisionId,
    channel,
    destination: "dest",
    status: "sent",
    attempt: 1,
    sentAt: now,
    conversationId,
  });
}

async function candidateFor(
  conversationId: string,
  channel: NotificationChannel = CHANNEL,
) {
  const set = await buildConversationCandidates([channel]);
  return set[channel]?.find((c) => c.conversationId === conversationId);
}

describe("buildConversationCandidates guardian enrichment", () => {
  beforeEach(() => {
    resetTables();
  });

  test("counts pending requests via both source and delivery conversation scope", async () => {
    const convId = "conv-guardian";
    seedCandidateConversation(convId);

    // (1) pending request whose SOURCE conversation is the candidate.
    bridgeState.seedRequest({
      kind: "tool_approval",
      sourceType: "channel",
      sourceConversationId: convId,
      guardianPrincipalId: TEST_PRINCIPAL,
    });

    // (2) pending request with a synthetic source id whose card was DELIVERED
    // to the candidate conversation (a different conversation than its source).
    const delivered = bridgeState.seedRequest({
      kind: "access_request",
      sourceType: "channel",
      sourceConversationId: "access-req-xyz",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    bridgeState.seedDelivery({
      requestId: delivered.id,
      destinationChannel: CHANNEL,
      destinationConversationId: convId,
    });

    expect(
      (await candidateFor(convId))?.guardianContext
        ?.pendingUnresolvedRequestCount,
    ).toBe(2);
  });

  test("omits guardian context when the conversation's only request is resolved", async () => {
    const convId = "conv-resolved";
    seedCandidateConversation(convId);

    const req = bridgeState.seedRequest({
      kind: "tool_approval",
      sourceType: "channel",
      sourceConversationId: convId,
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    await bridgeState.module.updateGuardianRequest(req.id, {
      status: "approved",
    });

    // The conversation still surfaces as a candidate (it had a delivery), but
    // with no guardian context since nothing is pending.
    const candidate = await candidateFor(convId);
    expect(candidate).toBeDefined();
    expect(candidate?.guardianContext).toBeUndefined();
  });

  test("counts a Slack channel card recorded through the real recorder", async () => {
    const SLACK = "slack" as NotificationChannel;
    const convId = "conv-slack-card";
    seedCandidateConversation(convId, SLACK);

    // Channel-only access request: a synthetic source conversation, card
    // delivered to a Slack chat. The recorder records the card's internal
    // conversation, so the Slack candidate counts it.
    const req = bridgeState.seedRequest({
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "slack",
      sourceConversationId: "access-req-synthetic",
      guardianPrincipalId: TEST_PRINCIPAL,
    });
    await recordGuardianRequestDeliveries({
      requestId: req.id,
      deliveryResults: [
        {
          channel: "slack",
          destination: "slack-chat-1",
          status: "sent",
          conversationId: convId,
          messageId: "ts-1",
        },
      ],
    });

    expect(
      (await candidateFor(convId, SLACK))?.guardianContext
        ?.pendingUnresolvedRequestCount,
    ).toBe(1);
  });
});
