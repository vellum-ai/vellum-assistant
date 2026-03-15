/**
 * Regression tests for the ASK_GUARDIAN canonical notification path.
 *
 * Validates that guardian dispatch relies on the generic notification
 * pipeline (including conversation-created callbacks) without a custom dispatch path.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ConversationCreatedInfo } from "../notifications/broadcaster.js";
import type { NotificationDeliveryResult } from "../notifications/types.js";

const testDir = mkdtempSync(join(tmpdir(), "notification-guardian-path-"));

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

// Note: stale mock for channel-guardian-store.js removed — the barrel was
// deleted and none of the functions it mocked (getActiveBinding, createBinding,
// listActiveBindingsByAssistant) existed in the barrel.

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    calls: {
      userConsultTimeoutSeconds: 120,
    },
  }),
}));

// Mock guardian-vellum-migration to use a stable principal, avoiding UNIQUE
// constraint errors when ensureVellumGuardianBinding is called across tests.
mock.module("../runtime/guardian-vellum-migration.js", () => ({
  ensureVellumGuardianBinding: () => "test-principal-id",
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
  registerBroadcastFn: () => {},
}));

import {
  createCallSession,
  createPendingQuestion,
} from "../calls/call-store.js";
import { dispatchGuardianQuestion } from "../calls/guardian-dispatch.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
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
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM canonical_guardian_requests");
  db.run("DELETE FROM guardian_action_deliveries");
  db.run("DELETE FROM guardian_action_requests");
  db.run("DELETE FROM call_pending_questions");
  db.run("DELETE FROM call_events");
  db.run("DELETE FROM call_sessions");
  db.run("DELETE FROM conversations");

  emitCalls.length = 0;
  // Note: mockTelegramBinding/mockVellumBinding assignments
  // removed — they only fed the stale channel-guardian-store mock.
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

describe("ASK_GUARDIAN canonical notification path", () => {
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

  test("uses notification_thread_created callback instead of a guardian-specific dispatch path", async () => {
    const convId = "conv-guardian-notif-2";
    ensureConversation(convId);
    mockConversationCreated = {
      conversationId: "conv-from-thread-callback",
      title: "Guardian question",
      sourceEventName: "guardian.question",
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
    expect(signalParams.skipVellumThread).toBeUndefined();
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

    const db = getDb();
    const raw = (db as unknown as { $client: import("bun:sqlite").Database })
      .$client;
    const request = raw
      .query(
        "SELECT * FROM canonical_guardian_requests WHERE call_session_id = ?",
      )
      .get(session.id) as { id: string } | undefined;
    const deliveries = raw
      .query(
        "SELECT destination_channel, destination_conversation_id, destination_chat_id, status FROM canonical_guardian_deliveries WHERE request_id = ? ORDER BY destination_channel ASC",
      )
      .all(request!.id) as Array<{
      destination_channel: string;
      destination_conversation_id: string | null;
      destination_chat_id: string | null;
      status: string;
    }>;

    expect(deliveries).toHaveLength(2);
    const telegram = deliveries.find(
      (d) => d.destination_channel === "telegram",
    );
    const vellum = deliveries.find((d) => d.destination_channel === "vellum");
    expect(telegram).toBeDefined();
    expect(telegram!.destination_chat_id).toBe("tg-chat-abc");
    expect(telegram!.status).toBe("sent");
    expect(vellum).toBeDefined();
    expect(vellum!.destination_conversation_id).toBe("conv-guardian-vellum");
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

    const db = getDb();
    const raw = (db as unknown as { $client: import("bun:sqlite").Database })
      .$client;
    const request = raw
      .query(
        "SELECT * FROM canonical_guardian_requests WHERE call_session_id = ?",
      )
      .get(session.id) as { id: string } | undefined;
    const vellumDelivery = raw
      .query(
        "SELECT status FROM canonical_guardian_deliveries WHERE request_id = ? AND destination_channel = ?",
      )
      .get(request!.id, "vellum") as { status: string } | undefined;

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

    // Verify: two distinct canonical_guardian_requests exist
    const db = getDb();
    const raw = (db as unknown as { $client: import("bun:sqlite").Database })
      .$client;
    const requests = raw
      .query(
        "SELECT id, question_text FROM canonical_guardian_requests WHERE call_session_id = ? ORDER BY created_at ASC",
      )
      .all(session.id) as Array<{ id: string; question_text: string }>;
    expect(requests).toHaveLength(2);
    expect(requests[0].question_text).toBe(
      "Can they enter through the side gate?",
    );
    expect(requests[1].question_text).toBe("What about the back door?");

    // Verify: each request has its own delivery row pointing to the shared conversation
    const deliveries = raw
      .query(
        "SELECT request_id, destination_conversation_id, status FROM canonical_guardian_deliveries WHERE destination_conversation_id = ? ORDER BY created_at ASC",
      )
      .all(sharedConvId) as Array<{
      request_id: string;
      destination_conversation_id: string;
      status: string;
    }>;
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0].request_id).toBe(requests[0].id);
    expect(deliveries[1].request_id).toBe(requests[1].id);
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
    const db = getDb();
    const raw = (db as unknown as { $client: import("bun:sqlite").Database })
      .$client;
    const request = raw
      .query(
        "SELECT id FROM canonical_guardian_requests WHERE call_session_id = ?",
      )
      .get(session.id) as { id: string } | undefined;
    expect(request).toBeDefined();

    const delivery = raw
      .query(
        "SELECT status FROM canonical_guardian_deliveries WHERE request_id = ? AND destination_channel = ?",
      )
      .get(request!.id, "vellum") as { status: string } | undefined;
    expect(delivery).toBeDefined();
    expect(delivery!.status).toBe("failed");
  });
});
