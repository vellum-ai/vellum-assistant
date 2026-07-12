/**
 * Regression tests for the ASK_GUARDIAN notification path.
 *
 * Validates that guardian dispatch relies on the generic notification
 * pipeline (including conversation-created callbacks) without a custom dispatch path.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ConversationCreatedInfo } from "../notifications/broadcaster.js";
import type { NotificationDeliveryResult } from "../notifications/types.js";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    calls: {
      userConsultTimeoutSeconds: 120,
    },
  }),
}));

const emitCalls: unknown[] = [];
let mockConversationCreated: ConversationCreatedInfo | null = null;
let mockEmitResult: {
  signalId: string;
  deduplicated: boolean;
  dispatched: boolean;
  reason: string;
  deliveryResults: NotificationDeliveryResult[];
} = {
  signalId: "sig-1",
  deduplicated: false,
  dispatched: true,
  reason: "ok",
  deliveryResults: [
    {
      channel: "vellum",
      destination: "vellum",
      status: "sent",
      conversationId: "conv-guardian-1",
    },
  ],
};

mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitCalls.push(params);
    const onConversationCreated = params.onConversationCreated;
    if (
      typeof onConversationCreated === "function" &&
      mockConversationCreated
    ) {
      onConversationCreated(mockConversationCreated);
    }
    return mockEmitResult;
  },
}));

// Guardian principalId is resolved from the gateway binding reader. Mirror the
// seeded vellum binding so dispatch can resolve the principal.
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => [
    {
      channelType: "vellum",
      contactId: "guardian-vellum",
      principalId: "test-principal-id",
      address: "local",
      status: "active",
    },
  ],
  guardianForChannel: (
    list: Array<{ channelType: string; status: string }>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
  anyGuardian: (list: unknown[]) => list[0],
}));

// Guardian requests/deliveries are created through the gateway client; serve
// that surface from the in-memory sim the assertions read.
import {
  bridgeState,
  gatewayGuardianRequestsStoreBridge,
} from "./helpers/gateway-guardian-requests-store-bridge.js";

mock.module(
  "../channels/gateway-guardian-requests.js",
  () => gatewayGuardianRequestsStoreBridge,
);

import {
  createCallSession,
  createPendingQuestion,
} from "../calls/call-store.js";
import { dispatchGuardianQuestion } from "../calls/guardian-dispatch.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations } from "../persistence/schema/index.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";

await initializeDb();

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

function requestForCallSession(callSessionId: string) {
  return [...bridgeState.requests.values()]
    .filter((r) => r.callSessionId === callSessionId)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}

function resetTables(): void {
  const db = getDb();
  bridgeState.reset();
  db.run("DELETE FROM call_pending_questions");
  db.run("DELETE FROM call_events");
  db.run("DELETE FROM call_sessions");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");

  // Seed the vellum guardian binding (gateway does this at startup in production)
  createGuardianBinding({
    channel: "vellum",
    guardianExternalUserId: "test-principal-id",
    guardianDeliveryChatId: "local",
    guardianPrincipalId: "test-principal-id",
    verifiedVia: "bootstrap",
  });

  emitCalls.length = 0;
  mockConversationCreated = null;
  mockEmitResult = {
    signalId: "sig-1",
    deduplicated: false,
    dispatched: true,
    reason: "ok",
    deliveryResults: [
      {
        channel: "vellum",
        destination: "vellum",
        status: "sent",
        conversationId: "conv-guardian-1",
      },
    ],
  };
}

describe("ASK_GUARDIAN notification path", () => {
  beforeEach(() => {
    resetTables();
  });

  test("dispatches through emitNotificationSignal with guardian context metadata", async () => {
    const convId = "conv-guardian-notif-1";
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "What is the gate code?");

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq,
    });

    expect(emitCalls.length).toBe(1);
    const signalParams = emitCalls[0] as Record<string, unknown>;
    expect(signalParams.sourceEventName).toBe("guardian.question");
    expect(signalParams.sourceChannel).toBe("phone");
    expect(signalParams.dedupeKey).toMatch(/^guardian:/);

    const hints = signalParams.attentionHints as Record<string, unknown>;
    expect(hints.requiresAction).toBe(true);
    expect(hints.urgency).toBe("high");
    expect(hints.isAsyncBackground).toBe(false);
    expect(hints.visibleInSourceNow).toBe(false);

    const payload = signalParams.contextPayload as Record<string, unknown>;
    expect(payload.questionText).toBe("What is the gate code?");
    expect(payload.callSessionId).toBe(session.id);
    expect(payload.requestKind).toBe("pending_question");
    expect(payload.toolName).toBeUndefined();
    expect(payload.pendingQuestionId).toBeUndefined();
    expect(payload.requestId).toBeDefined();
    expect(payload.requestCode).toBeDefined();
  });

  test("uses notification_conversation_created callback instead of a guardian-specific dispatch path", async () => {
    const convId = "conv-guardian-notif-2";
    ensureConversation(convId);
    mockConversationCreated = {
      conversationId: "conv-from-thread-callback",
      title: "Guardian question",
      sourceEventName: "guardian.question",
      silent: false,
    };
    mockEmitResult = {
      signalId: "sig-2",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [
        {
          channel: "vellum",
          destination: "vellum",
          status: "sent",
        },
      ],
    };

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "Need callback verification");

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq,
    });

    const signalParams = emitCalls[0] as Record<string, unknown>;
    expect(typeof signalParams.onConversationCreated).toBe("function");
  });

  test("creates guardian action deliveries from notification pipeline delivery results", async () => {
    const convId = "conv-guardian-notif-3";
    ensureConversation(convId);

    mockEmitResult = {
      signalId: "sig-3",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [
        {
          channel: "vellum",
          destination: "vellum",
          status: "sent",
          conversationId: "conv-guardian-vellum",
        },
        {
          channel: "telegram",
          destination: "tg-chat-abc",
          status: "sent",
        },
      ],
    };

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "Ship it?");

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq,
    });

    const request = requestForCallSession(session.id);
    const deliveries = bridgeState.deliveries.filter(
      (d) => d.requestId === request!.id,
    );

    expect(deliveries).toHaveLength(2);
    const telegram = deliveries.find(
      (d) => d.destinationChannel === "telegram",
    );
    const vellum = deliveries.find((d) => d.destinationChannel === "vellum");
    expect(telegram).toBeDefined();
    expect(telegram!.destinationChatId).toBe("tg-chat-abc");
    expect(telegram!.status).toBe("sent");
    expect(vellum).toBeDefined();
    expect(vellum!.destinationConversationId).toBe("conv-guardian-vellum");
    expect(vellum!.status).toBe("sent");
  });

  test("creates a failed vellum delivery when pipeline emits no vellum result", async () => {
    const convId = "conv-guardian-notif-4";
    ensureConversation(convId);

    mockEmitResult = {
      signalId: "sig-4",
      deduplicated: false,
      dispatched: false,
      reason: "blocked by deterministic checks",
      deliveryResults: [],
    };

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "Fallback row test");

    await expect(
      dispatchGuardianQuestion({
        callSessionId: session.id,
        conversationId: convId,
        assistantId: "self",
        pendingQuestion: pq,
      }),
    ).resolves.toBeUndefined();

    const request = requestForCallSession(session.id);
    const vellumDelivery = bridgeState.deliveries.find(
      (d) => d.requestId === request!.id && d.destinationChannel === "vellum",
    );

    expect(vellumDelivery).toBeDefined();
    expect(vellumDelivery!.status).toBe("failed");
  });

  test("context payload includes callSessionId and activeGuardianRequestCount for candidate-affinity", async () => {
    const convId = "conv-guardian-notif-affinity";
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "Affinity test question");

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq,
    });

    expect(emitCalls.length).toBe(1);
    const signalParams = emitCalls[0] as Record<string, unknown>;
    const payload = signalParams.contextPayload as Record<string, unknown>;

    // callSessionId is present for the decision engine to match candidates to the current call
    expect(payload.callSessionId).toBe(session.id);
    // activeGuardianRequestCount provides a hint about whether to reuse an existing thread
    expect(typeof payload.activeGuardianRequestCount).toBe("number");
    expect(payload.activeGuardianRequestCount).toBeGreaterThanOrEqual(1);
  });

  test("repeated guardian questions retain per-request delivery records when sharing a conversation", async () => {
    const convId = "conv-guardian-notif-reuse";
    ensureConversation(convId);

    const sharedConvId = "conv-guardian-shared-thread";

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });

    // First guardian question
    const pq1 = createPendingQuestion(
      session.id,
      "Can they enter through the side gate?",
    );
    mockEmitResult = {
      signalId: "sig-reuse-a",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [
        {
          channel: "vellum",
          destination: "vellum",
          status: "sent",
          conversationId: sharedConvId,
        },
      ],
    };

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq1,
    });

    // Second guardian question (same call, pipeline reuses the same conversation)
    emitCalls.length = 0;
    const pq2 = createPendingQuestion(session.id, "What about the back door?");
    mockEmitResult = {
      signalId: "sig-reuse-b",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [
        {
          channel: "vellum",
          destination: "vellum",
          status: "sent",
          conversationId: sharedConvId,
        },
      ],
    };

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq2,
    });

    // Verify: two distinct requests exist
    const requests = [...bridgeState.requests.values()]
      .filter((r) => r.callSessionId === session.id)
      .sort((a, b) => a.createdAt - b.createdAt);
    expect(requests).toHaveLength(2);
    expect(requests[0].questionText).toBe(
      "Can they enter through the side gate?",
    );
    expect(requests[1].questionText).toBe("What about the back door?");

    // Verify: each request has its own delivery row pointing to the shared conversation
    const deliveries = bridgeState.deliveries.filter(
      (d) => d.destinationConversationId === sharedConvId,
    );
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0].requestId).toBe(requests[0].id);
    expect(deliveries[1].requestId).toBe(requests[1].id);
    expect(deliveries[0].status).toBe("sent");
    expect(deliveries[1].status).toBe("sent");
  });

  test("follow-up/timeout flow is unchanged — expired request still gets fallback delivery on no pipeline result", async () => {
    const convId = "conv-guardian-notif-timeout";
    ensureConversation(convId);

    // Simulate a scenario where the pipeline returns no delivery results (e.g. blocked)
    mockEmitResult = {
      signalId: "sig-timeout",
      deduplicated: false,
      dispatched: false,
      reason: "blocked by deterministic checks",
      deliveryResults: [],
    };

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "Timeout scenario");

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq,
    });

    // The dispatch should still create a failed fallback delivery row
    const request = requestForCallSession(session.id);
    expect(request).toBeDefined();

    const delivery = bridgeState.deliveries.find(
      (d) => d.requestId === request!.id && d.destinationChannel === "vellum",
    );
    expect(delivery).toBeDefined();
    expect(delivery!.status).toBe("failed");
  });
});
