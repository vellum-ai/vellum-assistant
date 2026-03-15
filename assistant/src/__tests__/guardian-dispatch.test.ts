import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ConversationCreatedInfo } from "../notifications/broadcaster.js";
import type { NotificationDeliveryResult } from "../notifications/types.js";

const testDir = mkdtempSync(join(tmpdir(), "guardian-dispatch-test-"));

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
// Returns a known principal so guardian-dispatch can attribute requests.
mock.module("../runtime/guardian-vellum-migration.js", () => ({
  ensureVellumGuardianBinding: () => "test-principal-id",
}));

const emitCalls: unknown[] = [];
let conversationCreatedFromMock: ConversationCreatedInfo | null = null;
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
      conversationId: "conv-vellum-1",
    },
  ],
};

mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitCalls.push(params);
    const callback = params.onConversationCreated;
    if (typeof callback === "function" && conversationCreatedFromMock) {
      callback(conversationCreatedFromMock);
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

  // Note: mockTelegramBinding/mockVoiceBinding/mockVellumBinding assignments
  // removed — they only fed the stale channel-guardian-store mock.
  emitCalls.length = 0;
  conversationCreatedFromMock = null;
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
        conversationId: "conv-vellum-1",
      },
    ],
  };
}

describe("guardian-dispatch", () => {
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

  test("creates a guardian action request and vellum delivery from pipeline results", async () => {
    const convId = "conv-dispatch-1";
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

    const db = getDb();
    const raw = (db as unknown as { $client: import("bun:sqlite").Database })
      .$client;
    const request = raw
      .query(
        "SELECT * FROM canonical_guardian_requests WHERE call_session_id = ?",
      )
      .get(session.id) as
      | { id: string; status: string; question_text: string }
      | undefined;
    expect(request).toBeDefined();
    expect(request!.status).toBe("pending");
    expect(request!.question_text).toBe("What is the gate code?");

    const vellumDelivery = raw
      .query(
        "SELECT * FROM canonical_guardian_deliveries WHERE request_id = ? AND destination_channel = ?",
      )
      .get(request!.id, "vellum") as
      | { status: string; destination_conversation_id: string | null }
      | undefined;
    expect(vellumDelivery).toBeDefined();
    expect(vellumDelivery!.status).toBe("sent");
    expect(vellumDelivery!.destination_conversation_id).toBe("conv-vellum-1");

    const signalParams = emitCalls[0] as Record<string, unknown>;
    expect(signalParams.skipVellumThread).toBeUndefined();
    expect(typeof signalParams.onConversationCreated).toBe("function");
  });

  test("creates a telegram guardian delivery with binding metadata when pipeline sends telegram", async () => {
    const convId = "conv-dispatch-2";
    ensureConversation(convId);

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
          conversationId: "conv-vellum-2",
        },
        {
          channel: "telegram",
          destination: "tg-chat-999",
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
    const pq = createPendingQuestion(session.id, "Should I proceed?");

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
    const telegramDelivery = raw
      .query(
        "SELECT * FROM canonical_guardian_deliveries WHERE request_id = ? AND destination_channel = ?",
      )
      .get(request!.id, "telegram") as
      | { status: string; destination_chat_id: string | null }
      | undefined;
    expect(telegramDelivery).toBeDefined();
    expect(telegramDelivery!.status).toBe("sent");
    expect(telegramDelivery!.destination_chat_id).toBe("tg-chat-999");
  });

  test("marks non-sent pipeline delivery results as failed", async () => {
    const convId = "conv-dispatch-3";
    ensureConversation(convId);

    mockEmitResult = {
      signalId: "sig-3",
      deduplicated: false,
      dispatched: true,
      reason: "partial",
      deliveryResults: [
        {
          channel: "vellum",
          destination: "vellum",
          status: "failed",
          errorMessage: "delivery unavailable",
          conversationId: "conv-vellum-3",
        },
      ],
    };

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "Error case");

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
    const vellumDelivery = raw
      .query(
        "SELECT * FROM canonical_guardian_deliveries WHERE request_id = ? AND destination_channel = ?",
      )
      .get(request!.id, "vellum") as { status: string } | undefined;
    expect(vellumDelivery).toBeDefined();
    expect(vellumDelivery!.status).toBe("failed");
  });

  test("uses onConversationCreated callback conversation when delivery result omits conversationId", async () => {
    const convId = "conv-dispatch-4";
    ensureConversation(convId);

    conversationCreatedFromMock = {
      conversationId: "conv-from-thread-created",
      title: "Guardian alert",
      sourceEventName: "guardian.question",
    };
    mockEmitResult = {
      signalId: "sig-4",
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
    const pq = createPendingQuestion(session.id, "Need callback conversation");

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
    const vellumDelivery = raw
      .query(
        "SELECT * FROM canonical_guardian_deliveries WHERE request_id = ? AND destination_channel = ?",
      )
      .get(request!.id, "vellum") as
      | { destination_conversation_id: string | null }
      | undefined;
    expect(vellumDelivery).toBeDefined();
    expect(vellumDelivery!.destination_conversation_id).toBe(
      "conv-from-thread-created",
    );
  });

  test("persists toolName and inputDigest on canonical guardian request for tool-approval dispatches", async () => {
    const convId = "conv-dispatch-5";
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(
      session.id,
      "Allow send_email to bob@example.com?",
    );

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq,
      toolName: "send_email",
      inputDigest: "abc123def456",
    });

    const db = getDb();
    const raw = (db as unknown as { $client: import("bun:sqlite").Database })
      .$client;
    const request = raw
      .query(
        "SELECT * FROM canonical_guardian_requests WHERE call_session_id = ?",
      )
      .get(session.id) as
      | { id: string; tool_name: string | null; input_digest: string | null }
      | undefined;
    expect(request).toBeDefined();
    expect(request!.tool_name).toBe("send_email");
    expect(request!.input_digest).toBe("abc123def456");

    const signalParams = emitCalls[0] as Record<string, unknown>;
    const payload = signalParams.contextPayload as Record<string, unknown>;
    expect(payload.requestKind).toBe("pending_question");
    expect(payload.toolName).toBe("send_email");
  });

  test("omitting toolName and inputDigest stores null for informational ASK_GUARDIAN dispatches", async () => {
    const convId = "conv-dispatch-6";
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "What time works?");

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
      .get(session.id) as
      | { id: string; tool_name: string | null; input_digest: string | null }
      | undefined;
    expect(request).toBeDefined();
    expect(request!.tool_name).toBeNull();
    expect(request!.input_digest).toBeNull();
  });

  test("includes activeGuardianRequestCount in context payload", async () => {
    const convId = "conv-dispatch-7";
    ensureConversation(convId);

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });
    const pq = createPendingQuestion(session.id, "First question");

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq,
    });

    const signalParams = emitCalls[0] as Record<string, unknown>;
    const payload = signalParams.contextPayload as Record<string, unknown>;
    // The request was just created so there is 1 pending request for this session
    expect(payload.activeGuardianRequestCount).toBe(1);
    expect(payload.callSessionId).toBe(session.id);
    expect(payload.requestKind).toBe("pending_question");
    expect(payload.toolName).toBeUndefined();
    expect(payload.pendingQuestionId).toBeUndefined();
  });

  test("repeated guardian questions in the same call each create per-request delivery rows even when sharing a conversation", async () => {
    const convId = "conv-dispatch-reuse-1";
    ensureConversation(convId);

    // Both dispatches deliver to the same vellum conversation (simulating thread reuse)
    const sharedConversationId = "conv-shared-guardian";

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });

    // First dispatch
    const pq1 = createPendingQuestion(session.id, "What is the gate code?");
    mockEmitResult = {
      signalId: "sig-reuse-1",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [
        {
          channel: "vellum",
          destination: "vellum",
          status: "sent",
          conversationId: sharedConversationId,
        },
      ],
    };

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq1,
    });

    // Second dispatch (same call session, same shared conversation)
    emitCalls.length = 0;
    const pq2 = createPendingQuestion(session.id, "Should I let them in?");
    mockEmitResult = {
      signalId: "sig-reuse-2",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [
        {
          channel: "vellum",
          destination: "vellum",
          status: "sent",
          conversationId: sharedConversationId,
        },
      ],
    };

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq2,
    });

    // Both dispatches should have created separate canonical requests
    const db = getDb();
    const raw = (db as unknown as { $client: import("bun:sqlite").Database })
      .$client;
    const requests = raw
      .query(
        "SELECT * FROM canonical_guardian_requests WHERE call_session_id = ? ORDER BY created_at ASC",
      )
      .all(session.id) as Array<{ id: string; question_text: string }>;
    expect(requests).toHaveLength(2);
    expect(requests[0].question_text).toBe("What is the gate code?");
    expect(requests[1].question_text).toBe("Should I let them in?");

    // Each request should have its own delivery row, both pointing to the shared conversation
    for (const req of requests) {
      const delivery = raw
        .query(
          "SELECT * FROM canonical_guardian_deliveries WHERE request_id = ? AND destination_channel = ?",
        )
        .get(req.id, "vellum") as
        | { status: string; destination_conversation_id: string | null }
        | undefined;
      expect(delivery).toBeDefined();
      expect(delivery!.status).toBe("sent");
      expect(delivery!.destination_conversation_id).toBe(sharedConversationId);
    }

    // Total delivery rows should be 2 (one per request), not 1
    const allDeliveries = raw
      .query(
        "SELECT * FROM canonical_guardian_deliveries WHERE destination_conversation_id = ?",
      )
      .all(sharedConversationId) as Array<{ request_id: string }>;
    expect(allDeliveries).toHaveLength(2);

    // Second dispatch should report a higher activeGuardianRequestCount
    const secondPayload = (emitCalls[0] as Record<string, unknown>)
      .contextPayload as Record<string, unknown>;
    expect(secondPayload.activeGuardianRequestCount).toBe(2);
  });

  test("second guardian question in same call session passes conversationAffinityHint with first conversation ID", async () => {
    const convId = "conv-dispatch-affinity-1";
    ensureConversation(convId);

    const sharedConversationId = "conv-affinity-guardian";

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });

    // First dispatch — no affinity hint expected (no prior delivery exists)
    const pq1 = createPendingQuestion(session.id, "First question");
    mockEmitResult = {
      signalId: "sig-affinity-1",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [
        {
          channel: "vellum",
          destination: "vellum",
          status: "sent",
          conversationId: sharedConversationId,
        },
      ],
    };

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq1,
    });

    const firstParams = emitCalls[0] as Record<string, unknown>;
    // First dispatch should not have an affinity hint
    expect(firstParams.conversationAffinityHint).toBeUndefined();

    // Second dispatch — should carry the affinity hint from the first delivery
    emitCalls.length = 0;
    const pq2 = createPendingQuestion(session.id, "Second question");
    mockEmitResult = {
      signalId: "sig-affinity-2",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [
        {
          channel: "vellum",
          destination: "vellum",
          status: "sent",
          conversationId: sharedConversationId,
        },
      ],
    };

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq2,
    });

    const secondParams = emitCalls[0] as Record<string, unknown>;
    expect(secondParams.conversationAffinityHint).toEqual({
      vellum: sharedConversationId,
    });
  });

  test("ASK_GUARDIAN_APPROVAL path (toolName present) uses same-thread affinity on second dispatch", async () => {
    const convId = "conv-dispatch-affinity-tool";
    ensureConversation(convId);

    const sharedConversationId = "conv-affinity-tool-guardian";

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });

    // First dispatch — tool-approval style pending_question (toolName set)
    const pq1 = createPendingQuestion(
      session.id,
      "Allow send_email to bob@example.com?",
    );
    mockEmitResult = {
      signalId: "sig-tool-affinity-1",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [
        {
          channel: "vellum",
          destination: "vellum",
          status: "sent",
          conversationId: sharedConversationId,
        },
      ],
    };

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq1,
      toolName: "send_email",
    });

    const firstParams = emitCalls[0] as Record<string, unknown>;
    expect(firstParams.conversationAffinityHint).toBeUndefined();

    // Second dispatch — also with toolName
    emitCalls.length = 0;
    const pq2 = createPendingQuestion(
      session.id,
      "Allow run_script with sudo?",
    );
    mockEmitResult = {
      signalId: "sig-tool-affinity-2",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [
        {
          channel: "vellum",
          destination: "vellum",
          status: "sent",
          conversationId: sharedConversationId,
        },
      ],
    };

    await dispatchGuardianQuestion({
      callSessionId: session.id,
      conversationId: convId,
      assistantId: "self",
      pendingQuestion: pq2,
      toolName: "run_script",
    });

    const secondParams = emitCalls[0] as Record<string, unknown>;
    expect(secondParams.conversationAffinityHint).toEqual({
      vellum: sharedConversationId,
    });
  });

  test("third guardian question in same call session also carries affinity hint", async () => {
    const convId = "conv-dispatch-affinity-2";
    ensureConversation(convId);

    const sharedConversationId = "conv-affinity-triple";

    const session = createCallSession({
      conversationId: convId,
      provider: "twilio",
      fromNumber: "+15550001111",
      toNumber: "+15550002222",
    });

    // Dispatch three guardian questions in the same call session
    for (let i = 0; i < 3; i++) {
      emitCalls.length = 0;
      const pq = createPendingQuestion(session.id, `Question ${i + 1}`);
      mockEmitResult = {
        signalId: `sig-triple-${i}`,
        deduplicated: false,
        dispatched: true,
        reason: "ok",
        deliveryResults: [
          {
            channel: "vellum",
            destination: "vellum",
            status: "sent",
            conversationId: sharedConversationId,
          },
        ],
      };

      await dispatchGuardianQuestion({
        callSessionId: session.id,
        conversationId: convId,
        assistantId: "self",
        pendingQuestion: pq,
      });

      const params = emitCalls[0] as Record<string, unknown>;
      if (i === 0) {
        // First dispatch — no affinity hint
        expect(params.conversationAffinityHint).toBeUndefined();
      } else {
        // Subsequent dispatches — affinity hint points to the shared conversation
        expect(params.conversationAffinityHint).toEqual({
          vellum: sharedConversationId,
        });
      }
    }
  });
});
