import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "conv-attn-telegram-test-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
  migrateToDataLayout: () => {},
  migrateToWorkspaceLayout: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  isDebug: () => false,
  truncateForLog: (value: string) => value,
}));

// Mock security check to always pass
mock.module("../security/secret-ingress.js", () => ({
  checkIngressForSecrets: () => ({ blocked: false }),
}));

// Mock render to return the raw content as text
mock.module("../daemon/handlers.js", () => ({
  renderHistoryContent: (content: unknown) => ({
    text: typeof content === "string" ? content : JSON.stringify(content),
  }),
}));

import { eq } from "drizzle-orm";

import { upsertContact } from "../contacts/contact-store.js";
import * as channelDeliveryStore from "../memory/channel-delivery-store.js";
import { getDb, initializeDb, resetDb, resetTestTables } from "../memory/db.js";
import { attachments, conversationAttentionEvents } from "../memory/schema.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { handleChannelInbound } from "../runtime/routes/channel-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetTables(): void {
  resetTestTables(
    "conversation_attention_events",
    "conversation_assistant_attention_state",
    "channel_guardian_approval_requests",
    "channel_verification_sessions",
    "conversation_keys",
    "message_runs",
    "channel_inbound_events",
    "messages",
    "conversations",
    "contact_channels",
    "contacts",
  );
  channelDeliveryStore.resetAllRunDeliveryClaims();
  pendingInteractions.clear();
}

function ensureTestContact(): void {
  upsertContact({
    displayName: "Test User",
    channels: [
      {
        type: "telegram",
        address: "telegram-user-default",
        externalUserId: "telegram-user-default",
        status: "active",
        policy: "allow",
      },
    ],
  });
}

const TEST_BEARER_TOKEN = "token";

function makeInboundRequest(overrides: Record<string, unknown> = {}): Request {
  const body = {
    sourceChannel: "telegram",
    interface: "telegram",
    conversationExternalId: "chat-123",
    actorExternalId: "telegram-user-default",
    externalMessageId: `msg-${Date.now()}-${Math.random()}`,
    content: "hello",
    replyCallbackUrl: "https://gateway.test/deliver",
    ...overrides,
  };
  return new Request("http://localhost/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": TEST_BEARER_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

const noopProcessMessage = mock(async () => ({ messageId: "msg-1" }));

function getAttentionEvents(conversationId: string) {
  const db = getDb();
  return db
    .select()
    .from(conversationAttentionEvents)
    .where(eq(conversationAttentionEvents.conversationId, conversationId))
    .all();
}

beforeEach(() => {
  resetTables();
  ensureTestContact();
  noopProcessMessage.mockClear();
});

// ═══════════════════════════════════════════════════════════════════════════
// Telegram inbound messages record inferred seen signals
// ═══════════════════════════════════════════════════════════════════════════

describe("Telegram inbound message seen signals", () => {
  test("records inferred seen signal for non-duplicate text message", async () => {
    const req = makeInboundRequest({ content: "Hello there!" });

    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.duplicate).toBe(false);

    // Find the conversation ID from inbound events
    const db = getDb();
    const inboundEvents = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    expect(inboundEvents.length).toBeGreaterThan(0);

    const conversationId = inboundEvents[0].conversation_id;
    const events = getAttentionEvents(conversationId);

    expect(events.length).toBe(1);
    expect(events[0].signalType).toBe("telegram_inbound_message");
    expect(events[0].confidence).toBe("inferred");
    expect(events[0].sourceChannel).toBe("telegram");
    expect(events[0].source).toBe("inbound-message-handler");
    expect(events[0].evidenceText).toBe("User sent message: 'Hello there!'");
  });

  test("records inferred seen signal for media attachment without text", async () => {
    // Insert a fake attachment directly so the handler's validation passes
    const db = getDb();
    const attachmentId = `att-${Date.now()}`;
    db.insert(attachments)
      .values({
        id: attachmentId,
        originalFilename: "photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1024,
        kind: "base64",
        dataBase64: "dGVzdA==",
        createdAt: Date.now(),
      })
      .run();

    const req = makeInboundRequest({
      content: "",
      attachmentIds: [attachmentId],
    });

    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.duplicate).toBe(false);

    const inboundEvents2 = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = inboundEvents2[0].conversation_id;
    const events = getAttentionEvents(conversationId);

    expect(events.length).toBe(1);
    expect(events[0].signalType).toBe("telegram_inbound_message");
    expect(events[0].evidenceText).toBe("User sent media attachment");
  });

  test("evidence text is correctly truncated for long messages", async () => {
    const longMessage = "A".repeat(120);
    const req = makeInboundRequest({ content: longMessage });

    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.duplicate).toBe(false);

    const db = getDb();
    const inboundEvents = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = inboundEvents[0].conversation_id;
    const events = getAttentionEvents(conversationId);

    expect(events.length).toBe(1);
    // 80 chars of 'A' + '...'
    const expectedPreview = "A".repeat(80) + "...";
    expect(events[0].evidenceText).toBe(
      `User sent message: '${expectedPreview}'`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Telegram callbacks record inferred seen signals
// ═══════════════════════════════════════════════════════════════════════════

describe("Telegram callback seen signals", () => {
  test("records inferred seen signal for handled callback", async () => {
    // First, send a regular message to establish the conversation
    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage, TEST_BEARER_TOKEN);

    const db = getDb();
    const inboundEvents = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = inboundEvents[0].conversation_id;

    // Register a pending interaction so the approval interception handles it
    const handleConfirmationResponse = mock(() => {});
    const mockSession = {
      handleConfirmationResponse,
    } as unknown as import("../daemon/session.js").Session;
    pendingInteractions.register("req-cb-test", {
      session: mockSession,
      conversationId,
      kind: "confirmation",
      confirmationDetails: {
        toolName: "shell",
        input: { command: "echo hello" },
        riskLevel: "high",
        allowlistOptions: [
          {
            label: "echo hello",
            description: "echo hello",
            pattern: "echo hello",
          },
        ],
        scopeOptions: [{ label: "everywhere", scope: "everywhere" }],
      },
    });

    // Create a guardian binding (via contacts) so approval can be handled
    const { createGuardianBinding } =
      await import("../contacts/contacts-write.js");
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });

    // Clear attention events from the init message
    db.delete(conversationAttentionEvents).run();

    // Send callback data that matches the pending approval
    const cbReq = makeInboundRequest({
      content: "approve",
      callbackData: "apr:req-cb-test:approve_once",
    });

    const res = await handleChannelInbound(
      cbReq,
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBeDefined();

    const events = getAttentionEvents(conversationId);
    expect(events.length).toBe(1);
    expect(events[0].signalType).toBe("telegram_callback");
    expect(events[0].confidence).toBe("inferred");
    expect(events[0].sourceChannel).toBe("telegram");
    expect(events[0].source).toBe("inbound-message-handler");
    expect(events[0].evidenceText).toContain(
      "User tapped callback: 'apr:req-cb-test:approve_once'",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Duplicate events do NOT produce duplicate seen signals
// ═══════════════════════════════════════════════════════════════════════════

describe("duplicate event deduplication", () => {
  test("duplicate Telegram message does not record a second seen signal", async () => {
    const fixedMessageId = `msg-dedup-${Date.now()}`;

    // First (non-duplicate) message
    const req1 = makeInboundRequest({
      content: "first message",
      externalMessageId: fixedMessageId,
    });
    const res1 = await handleChannelInbound(
      req1,
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    const body1 = (await res1.json()) as Record<string, unknown>;
    expect(body1.duplicate).toBe(false);

    // Same externalMessageId => duplicate
    const req2 = makeInboundRequest({
      content: "first message",
      externalMessageId: fixedMessageId,
    });
    const res2 = await handleChannelInbound(
      req2,
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2.duplicate).toBe(true);

    // Only one attention event should exist
    const db = getDb();
    const inboundEvents = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = inboundEvents[0].conversation_id;
    const events = getAttentionEvents(conversationId);

    expect(events.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Non-Telegram channels do NOT record Telegram seen signals
// ═══════════════════════════════════════════════════════════════════════════

describe("non-Telegram channel filtering", () => {
  test("email inbound message does not record a Telegram seen signal", async () => {
    const req = makeInboundRequest({
      sourceChannel: "email",
      interface: "email",
      content: "email message",
    });

    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      TEST_BEARER_TOKEN,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);

    // No attention events should be recorded for non-Telegram channels
    const db = getDb();
    const allEvents = db.select().from(conversationAttentionEvents).all();
    expect(allEvents.length).toBe(0);
  });
});
