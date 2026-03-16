import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "channel-approval-routes-test-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
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

// Mock security check to always pass
mock.module("../security/secret-ingress.js", () => ({
  checkIngressForSecrets: () => ({ blocked: false }),
}));

// Mock render to return the raw content as text
mock.module("../daemon/handlers/shared.js", () => ({
  renderHistoryContent: (content: unknown) => ({
    text: typeof content === "string" ? content : JSON.stringify(content),
  }),
}));

import { upsertContact } from "../contacts/contact-store.js";
import { createGuardianBinding } from "../contacts/contacts-write.js";
import type { Session } from "../daemon/conversation.js";
import {
  createCanonicalGuardianDelivery,
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
} from "../memory/canonical-guardian-store.js";
import { getDb, initializeDb, resetDb, resetTestTables } from "../memory/db.js";
import * as deliveryChannels from "../memory/delivery-channels.js";
import {
  createApprovalRequest,
  getAllPendingApprovalsByGuardianChat,
} from "../memory/guardian-approvals.js";
import {
  conversations,
  externalConversationBindings,
} from "../memory/schema.js";
import { initAuthSigningKey } from "../runtime/auth/token-service.js";
import * as gatewayClient from "../runtime/gateway-client.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import {
  _setTestPollMaxWait,
  handleChannelInbound,
  sweepExpiredGuardianApprovals,
} from "../runtime/routes/channel-routes.js";

initializeDb();
initAuthSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long"));

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

function ensureConversation(conversationId: string): void {
  const db = getDb();
  try {
    db.insert(conversations)
      .values({
        id: conversationId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
  } catch {
    // already exists
  }
}

function resetTables(): void {
  resetTestTables(
    "scoped_approval_grants",
    "canonical_guardian_deliveries",
    "canonical_guardian_requests",
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
  deliveryChannels.resetAllRunDeliveryClaims();
  pendingInteractions.clear();
}

/**
 * Register a pending confirmation in the pending-interactions tracker.
 * Returns the mock session so tests can assert on handleConfirmationResponse.
 */
function registerPendingInteraction(
  requestId: string,
  conversationId: string,
  toolName: string,
  opts?: {
    input?: Record<string, unknown>;
    riskLevel?: string;
    persistentDecisionsAllowed?: boolean;
    allowlistOptions?: Array<{
      label: string;
      description: string;
      pattern: string;
    }>;
    scopeOptions?: Array<{ label: string; scope: string }>;
    executionTarget?: "sandbox" | "host";
  },
): ReturnType<typeof mock> {
  const handleConfirmationResponse = mock(() => {});
  const mockSession = {
    handleConfirmationResponse,
    ensureActorScopedHistory: async () => {},
  } as unknown as Session;

  pendingInteractions.register(requestId, {
    session: mockSession,
    conversationId,
    kind: "confirmation",
    confirmationDetails: {
      toolName,
      input: opts?.input ?? { command: "rm -rf /tmp/test" },
      riskLevel: opts?.riskLevel ?? "high",
      allowlistOptions: opts?.allowlistOptions ?? [
        {
          label: "rm -rf /tmp/test",
          description: "rm -rf /tmp/test",
          pattern: "rm -rf /tmp/test",
        },
      ],
      scopeOptions: opts?.scopeOptions ?? [
        { label: "everywhere", scope: "everywhere" },
      ],
      persistentDecisionsAllowed: opts?.persistentDecisionsAllowed,
      executionTarget: opts?.executionTarget,
    },
  });

  return handleConfirmationResponse;
}

function makeInboundRequest(overrides: Record<string, unknown> = {}): Request {
  const body: Record<string, unknown> = {
    sourceChannel: "telegram",
    conversationExternalId: "chat-123",
    actorExternalId: "telegram-user-default",
    externalMessageId: `msg-${Date.now()}-${Math.random()}`,
    content: "hello",
    replyCallbackUrl: "https://gateway.test/deliver",
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "interface")) {
    body.interface =
      typeof body.sourceChannel === "string" ? body.sourceChannel : "telegram";
  }
  return new Request("http://localhost/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const noopProcessMessage = mock(async () => ({ messageId: "msg-1" }));

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
      {
        type: "slack",
        address: "slack-user-default",
        externalUserId: "slack-user-default",
        status: "active",
        policy: "allow",
      },
    ],
  });
}

beforeEach(() => {
  resetTables();
  ensureTestContact();
  noopProcessMessage.mockClear();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Stale callback handling without matching pending approval
// ═══════════════════════════════════════════════════════════════════════════

describe("stale callback handling without matching pending approval", () => {
  test("ignores stale callback payloads even when pending approvals exist", async () => {
    ensureConversation("conv-1");

    // Register a pending interaction for this conversation
    registerPendingInteraction("req-abc", "conv-1", "shell");

    const req = makeInboundRequest({
      content: "approve",
      // Callback data references a DIFFERENT requestId than the one pending
      callbackData: "apr:req-different:approve_once",
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    // Callback payloads without a matching pending approval are treated as
    // stale and ignored.
    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("stale_ignored");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Callback data triggers decision handling
// ═══════════════════════════════════════════════════════════════════════════

describe("inbound callback metadata triggers decision handling", () => {
  beforeEach(() => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });
  });

  test('callback data "apr:<requestId>:approve_once" is parsed and applied', async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    // Establish the conversation to get a conversationId mapping
    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    expect(conversationId).toBeTruthy();
    ensureConversation(conversationId!);

    // Register a pending interaction for this conversation
    const sessionMock = registerPendingInteraction(
      "req-cb-1",
      conversationId!,
      "shell",
    );

    // Send a callback data message
    const req = makeInboundRequest({
      content: "",
      callbackData: "apr:req-cb-1:approve_once",
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalledWith("req-cb-1", "allow");

    deliverSpy.mockRestore();
  });

  test('callback data "apr:<requestId>:reject" applies a rejection', async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-cb-2",
      conversationId!,
      "shell",
    );

    const req = makeInboundRequest({
      content: "",
      callbackData: "apr:req-cb-2:reject",
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalledWith("req-cb-2", "deny");

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Plain text triggers decision handling
// ═══════════════════════════════════════════════════════════════════════════

describe("inbound text matching approval phrases triggers decision handling", () => {
  beforeEach(() => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });
  });

  test('text "approve" triggers approve_once decision', async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-txt-1",
      conversationId!,
      "shell",
    );

    const req = makeInboundRequest({ content: "approve" });
    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalledWith("req-txt-1", "allow");

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Non-decision messages during pending approval (no conversational engine)
// ═══════════════════════════════════════════════════════════════════════════

describe("non-decision messages during pending approval (no conversational engine)", () => {
  beforeEach(() => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });
  });

  test("sends a status reply when message is not a decision and no conversational engine", async () => {
    const replySpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    registerPendingInteraction("req-nd-1", conversationId!, "shell");

    // Send a message that is NOT a decision
    const req = makeInboundRequest({ content: "what is the weather?" });
    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("assistant_turn");

    // A status reply should have been delivered via deliverChannelReply
    expect(replySpy).toHaveBeenCalled();
    const statusCall = replySpy.mock.calls.find(
      (call) =>
        typeof call[1] === "object" &&
        (call[1] as { chatId?: string }).chatId === "chat-123",
    );
    expect(statusCall).toBeDefined();
    const statusPayload = statusCall![1] as { text?: string };
    // The status text mentions a pending approval
    expect(statusPayload.text).toContain("pending approval request");

    replySpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Messages without pending approval proceed normally
// ═══════════════════════════════════════════════════════════════════════════

describe("messages without pending approval proceed normally", () => {
  test("proceeds to normal processing when no pending approval exists", async () => {
    const req = makeInboundRequest({ content: "hello world" });
    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBeUndefined();
  });

  test('text "approve" is processed normally when no pending approval exists', async () => {
    const req = makeInboundRequest({ content: "approve" });
    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    // Should NOT be treated as an approval decision since there's no pending approval
    expect(body.approval).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Empty content with callbackData bypasses validation
// ═══════════════════════════════════════════════════════════════════════════

describe("empty content with callbackData bypasses validation", () => {
  beforeEach(() => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });
  });

  test("rejects empty content without callbackData", async () => {
    const req = makeInboundRequest({ content: "" });
    const res = await handleChannelInbound(req, noopProcessMessage);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.error as Record<string, unknown>).message).toBe(
      "content or attachmentIds is required",
    );
  });

  test("allows empty content when callbackData is present", async () => {
    // Establish the conversation first
    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-empty-1",
      conversationId!,
      "shell",
    );

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const req = makeInboundRequest({
      content: "",
      callbackData: "apr:req-empty-1:approve_once",
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalledWith("req-empty-1", "allow");

    deliverSpy.mockRestore();
  });

  test("allows undefined content when callbackData is present", async () => {
    // Establish the conversation first
    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const _sessionMock = registerPendingInteraction(
      "req-empty-2",
      conversationId!,
      "shell",
    );

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    // Send with no content field at all, just callbackData
    const reqBody = {
      sourceChannel: "telegram",
      interface: "telegram",
      conversationExternalId: "chat-123",
      externalMessageId: `msg-${Date.now()}-${Math.random()}`,
      callbackData: "apr:req-empty-2:approve_once",
      replyCallbackUrl: "https://gateway.test/deliver",
      actorExternalId: "telegram-user-default",
    };
    const req = new Request("http://localhost/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    expect(res.status).toBe(200);
    const resBody = (await res.json()) as Record<string, unknown>;
    expect(resBody.accepted).toBe(true);

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Callback requestId validation — stale button press
// ═══════════════════════════════════════════════════════════════════════════

describe("callback requestId validation", () => {
  beforeEach(() => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });
  });

  test("ignores stale callback when requestId does not match any pending interaction", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    // Register a pending interaction
    const sessionMock = registerPendingInteraction(
      "req-valid",
      conversationId!,
      "shell",
    );

    // Send callback with a DIFFERENT requestId (stale button)
    const req = makeInboundRequest({
      content: "",
      callbackData: "apr:stale-request-id:approve_once",
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("stale_ignored");
    // session should NOT have been called because the requestId didn't match
    expect(sessionMock).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
  });

  test("applies callback when requestId matches pending interaction", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-match",
      conversationId!,
      "shell",
    );

    // Send callback with the CORRECT requestId
    const req = makeInboundRequest({
      content: "",
      callbackData: "apr:req-match:approve_once",
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalledWith("req-match", "allow");

    deliverSpy.mockRestore();
  });

  test("plain-text decisions bypass requestId validation (no requestId in result)", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-plaintext",
      conversationId!,
      "shell",
    );

    // Send plain text "yes" — no requestId in the parsed result
    const req = makeInboundRequest({ content: "yes" });
    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalledWith("req-plaintext", "allow");

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. No immediate reply after approval decision
// ═══════════════════════════════════════════════════════════════════════════

describe("no immediate reply after approval decision", () => {
  beforeEach(() => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });
  });

  test("deliverChannelReply is NOT called from interception after decision is applied", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    registerPendingInteraction("req-noreply-1", conversationId!, "shell");

    // Clear the spy to only track calls from the decision path
    deliverSpy.mockClear();

    // Send a callback decision
    const req = makeInboundRequest({
      content: "",
      callbackData: "apr:req-noreply-1:approve_once",
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.approval).toBe("decision_applied");

    // The interception handler should NOT have called deliverChannelReply.
    // The reply should only come from the session's onEvent callback.
    expect(deliverSpy).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
  });

  test("plain-text decision also does not trigger immediate reply", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    registerPendingInteraction("req-noreply-2", conversationId!, "shell");

    deliverSpy.mockClear();

    // Send a plain-text approval
    const req = makeInboundRequest({ content: "approve" });
    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.approval).toBe("decision_applied");
    expect(deliverSpy).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Stale callback with no pending approval returns stale_ignored
// ═══════════════════════════════════════════════════════════════════════════

describe("stale callback handling", () => {
  test("callback with no pending approval returns stale_ignored", async () => {
    // No pending interactions — send a stale callback
    const req = makeInboundRequest({
      content: "",
      callbackData: "apr:stale-req:approve_once",
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("stale_ignored");
  });

  test("callback with non-empty content but no pending approval returns stale_ignored", async () => {
    // Simulate what normalize.ts does: callbackData present AND content is
    // set to the callback data value (non-empty).
    const req = makeInboundRequest({
      content: "apr:stale-req:approve_once",
      callbackData: "apr:stale-req:approve_once",
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("stale_ignored");
  });

  test("non-callback message without pending approval proceeds to normal processing", async () => {
    // Regular text message (no callbackData) should proceed normally
    const req = makeInboundRequest({ content: "hello world" });

    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    // No approval field — normal processing
    expect(body.approval).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. Plain-text channel approval decisions (telegram)
// ═══════════════════════════════════════════════════════════════════════════

describe("plain-text channel approval decisions", () => {
  beforeEach(() => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });
  });

  function makePlainTextInboundRequest(
    overrides: Record<string, unknown> = {},
  ): Request {
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
      },
      body: JSON.stringify(body),
    });
  }

  test('plain-text "yes" triggers approve_once decision', async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    // Establish the conversation
    const initReq = makePlainTextInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[events.length - 1]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-pt-1",
      conversationId!,
      "shell",
    );

    const req = makePlainTextInboundRequest({ content: "yes" });
    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalledWith("req-pt-1", "allow");

    deliverSpy.mockRestore();
  });

  test('plain-text "no" triggers reject decision', async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makePlainTextInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[events.length - 1]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-pt-2",
      conversationId!,
      "shell",
    );

    const req = makePlainTextInboundRequest({ content: "no" });
    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalledWith("req-pt-2", "deny");

    deliverSpy.mockRestore();
  });

  test("non-decision message during pending approval sends status reply", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });
    const approvalSpy = spyOn(
      gatewayClient,
      "deliverApprovalPrompt",
    ).mockResolvedValue(undefined);

    const initReq = makePlainTextInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[events.length - 1]?.conversation_id;
    ensureConversation(conversationId!);

    registerPendingInteraction("req-pt-3", conversationId!, "shell");

    const req = makePlainTextInboundRequest({ content: "what is happening?" });
    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("assistant_turn");

    // Non-decision: status reply delivered via plain text
    expect(deliverSpy).toHaveBeenCalled();
    expect(approvalSpy).not.toHaveBeenCalled();
    const statusCall = deliverSpy.mock.calls.find(
      (call) =>
        typeof call[1] === "object" &&
        (call[1] as { chatId?: string }).chatId === "chat-123",
    );
    expect(statusCall).toBeDefined();
    const statusPayload = statusCall![1] as {
      text?: string;
      approval?: unknown;
    };
    const deliveredText = statusPayload.text ?? "";
    expect(deliveredText).toContain("pending approval request");
    expect(statusPayload.approval).toBeUndefined();

    deliverSpy.mockRestore();
    approvalSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. Guardian verify intercept
// ═══════════════════════════════════════════════════════════════════════════

describe("telegram guardian verify intercept", () => {
  test("verification code reply works with sourceChannel telegram", async () => {
    const { createInboundVerificationSession } =
      await import("../runtime/channel-verification-service.js");
    const { secret } = createInboundVerificationSession("telegram");

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const req = new Request("http://localhost/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourceChannel: "telegram",
        interface: "telegram",
        conversationExternalId: "tg-chat-verify",
        externalMessageId: `msg-${Date.now()}-${Math.random()}`,
        content: secret,
        actorExternalId: "tg-user-42",
        replyCallbackUrl: "https://gateway.test/deliver",
      }),
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.verificationOutcome).toBe("verified");

    expect(deliverSpy).toHaveBeenCalled();
    const replyArgs = deliverSpy.mock.calls[0];
    const replyPayload = replyArgs[1] as { chatId: string; text: string };
    expect(replyPayload.chatId).toBe("tg-chat-verify");
    expect(typeof replyPayload.text).toBe("string");
    expect(replyPayload.text.toLowerCase()).toContain("guardian");
    expect(replyPayload.text.toLowerCase()).toContain("verif");

    deliverSpy.mockRestore();
  });

  test("invalid verification code returns failed via telegram", async () => {
    const { createInboundVerificationSession } =
      await import("../runtime/channel-verification-service.js");
    // Ensure there is a pending challenge so bare-code verification is intercepted.
    createInboundVerificationSession("telegram");

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const req = new Request("http://localhost/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourceChannel: "telegram",
        interface: "telegram",
        conversationExternalId: "tg-chat-verify-fail",
        externalMessageId: `msg-${Date.now()}-${Math.random()}`,
        content: "000000",
        actorExternalId: "tg-user-43",
        replyCallbackUrl: "https://gateway.test/deliver",
      }),
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.verificationOutcome).toBe("failed");

    expect(deliverSpy).toHaveBeenCalled();
    const replyArgs = deliverSpy.mock.calls[0];
    const replyPayload = replyArgs[1] as { chatId: string; text: string };
    expect(typeof replyPayload.text).toBe("string");
    expect(replyPayload.text.toLowerCase()).toContain("verif");
    expect(replyPayload.text.toLowerCase()).toContain("invalid");

    deliverSpy.mockRestore();
  });

  test("64-char hex verification codes are intercepted when a pending challenge exists", async () => {
    const { createHash, randomBytes } = await import("node:crypto");
    const { createInboundSession } =
      await import("../memory/channel-verification-sessions.js");

    const secret = randomBytes(32).toString("hex");
    const challengeHash = createHash("sha256").update(secret).digest("hex");
    createInboundSession({
      id: `challenge-hex-${Date.now()}`,
      channel: "telegram",
      challengeHash,
      expiresAt: Date.now() + 600_000,
    });

    let processMessageCalled = false;
    const processMessage = async () => {
      processMessageCalled = true;
      return { messageId: "msg-hex-not-verify" };
    };

    const req = new Request("http://localhost/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourceChannel: "telegram",
        interface: "telegram",
        conversationExternalId: "tg-chat-hex-message",
        externalMessageId: `msg-${Date.now()}-${Math.random()}`,
        content: secret,
        actorExternalId: "tg-user-hex",
        replyCallbackUrl: "https://gateway.test/deliver",
      }),
    });

    const res = await handleChannelInbound(req, processMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.verificationOutcome).toBe("verified");
    expect(processMessageCalled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 21. Guardian decision scoping — callback for older request
// ═══════════════════════════════════════════════════════════════════════════

describe("guardian decision scoping — multiple pending approvals", () => {
  test("callback for older request resolves to the correct approval request", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-scope-user",
      guardianDeliveryChatId: "guardian-scope-chat",
      guardianPrincipalId: "guardian-scope-user",
    });

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const olderConvId = "conv-scope-older";
    const newerConvId = "conv-scope-newer";
    ensureConversation(olderConvId);
    ensureConversation(newerConvId);

    // Register pending interactions and create guardian approval requests
    const olderSession = registerPendingInteraction(
      "req-older",
      olderConvId,
      "shell",
    );
    createApprovalRequest({
      runId: "run-older",
      requestId: "req-older",
      conversationId: olderConvId,
      channel: "telegram",
      requesterExternalUserId: "requester-a",
      requesterChatId: "chat-requester-a",
      guardianExternalUserId: "guardian-scope-user",
      guardianChatId: "guardian-scope-chat",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    const newerSession = registerPendingInteraction(
      "req-newer",
      newerConvId,
      "browser",
    );
    createApprovalRequest({
      runId: "run-newer",
      requestId: "req-newer",
      conversationId: newerConvId,
      channel: "telegram",
      requesterExternalUserId: "requester-b",
      requesterChatId: "chat-requester-b",
      guardianExternalUserId: "guardian-scope-user",
      guardianChatId: "guardian-scope-chat",
      toolName: "browser",
      expiresAt: Date.now() + 300_000,
    });

    // The guardian clicks the approval button for the OLDER request
    const req = makeInboundRequest({
      content: "",
      conversationExternalId: "guardian-scope-chat",
      callbackData: "apr:req-older:approve_once",
      actorExternalId: "guardian-scope-user",
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("guardian_decision_applied");

    // The older request's session should have been called
    expect(olderSession).toHaveBeenCalledWith("req-older", "allow");

    // The newer request's session should NOT have been called
    expect(newerSession).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 22. Ambiguous plain-text decision with multiple pending requests
// ═══════════════════════════════════════════════════════════════════════════

describe("ambiguous plain-text decision with multiple pending requests", () => {
  test("does not apply plain-text decision to wrong request when multiple pending", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-ambig-user",
      guardianDeliveryChatId: "guardian-ambig-chat",
      guardianPrincipalId: "guardian-ambig-user",
    });

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const convA = "conv-ambig-a";
    const convB = "conv-ambig-b";
    ensureConversation(convA);
    ensureConversation(convB);

    const sessionA = registerPendingInteraction("req-ambig-a", convA, "shell");
    createApprovalRequest({
      runId: "run-ambig-a",
      requestId: "req-ambig-a",
      conversationId: convA,
      channel: "telegram",
      requesterExternalUserId: "requester-x",
      requesterChatId: "chat-requester-x",
      guardianExternalUserId: "guardian-ambig-user",
      guardianChatId: "guardian-ambig-chat",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    const sessionB = registerPendingInteraction(
      "req-ambig-b",
      convB,
      "browser",
    );
    createApprovalRequest({
      runId: "run-ambig-b",
      requestId: "req-ambig-b",
      conversationId: convB,
      channel: "telegram",
      requesterExternalUserId: "requester-y",
      requesterChatId: "chat-requester-y",
      guardianExternalUserId: "guardian-ambig-user",
      guardianChatId: "guardian-ambig-chat",
      toolName: "browser",
      expiresAt: Date.now() + 300_000,
    });

    // Conversational engine that returns keep_pending for disambiguation
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "keep_pending" as const,
      replyText: "You have 2 pending requests. Which one?",
    }));

    // Guardian sends plain-text "yes" — ambiguous because two approvals are pending
    const req = makeInboundRequest({
      content: "yes",
      conversationExternalId: "guardian-ambig-chat",
      actorExternalId: "guardian-ambig-user",
    });

    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("assistant_turn");

    // Neither session should have been called — disambiguation was required
    expect(sessionA).not.toHaveBeenCalled();
    expect(sessionB).not.toHaveBeenCalled();

    // The conversational engine should have been called with both pending approvals
    expect(mockConversationGenerator).toHaveBeenCalledTimes(1);
    const engineCtx = mockConversationGenerator.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(engineCtx.pendingApprovals as Array<unknown>).toHaveLength(2);

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 23. Expired guardian approval auto-denies and transitions to terminal status
// ═══════════════════════════════════════════════════════════════════════════

describe("expired guardian approval auto-denies via sweep", () => {
  test("sweepExpiredGuardianApprovals auto-denies and notifies both parties", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const convId = "conv-expiry-sweep";
    ensureConversation(convId);

    // Register a pending interaction so the sweep can resolve the session
    const sessionMock = registerPendingInteraction(
      "req-exp-1",
      convId,
      "shell",
    );

    createApprovalRequest({
      runId: "run-exp-1",
      requestId: "req-exp-1",
      conversationId: convId,
      channel: "telegram",
      requesterExternalUserId: "requester-exp",
      requesterChatId: "chat-requester-exp",
      guardianExternalUserId: "guardian-exp-user",
      guardianChatId: "guardian-exp-chat",
      toolName: "shell",
      expiresAt: Date.now() - 1000, // already expired
    });

    // Run the sweep
    sweepExpiredGuardianApprovals("https://gateway.test", () => "token");

    // Wait for async notifications
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The session should have been denied
    expect(sessionMock).toHaveBeenCalledWith("req-exp-1", "deny");

    // Both requester and guardian should have been notified
    const requesterNotify = deliverSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === "object" &&
        (call[1] as { chatId?: string }).chatId === "chat-requester-exp" &&
        (call[1] as { text?: string }).text?.includes("expired"),
    );
    expect(requesterNotify.length).toBeGreaterThanOrEqual(1);

    const guardianNotify = deliverSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === "object" &&
        (call[1] as { chatId?: string }).chatId === "guardian-exp-chat" &&
        (call[1] as { text?: string }).text?.includes("expired"),
    );
    expect(guardianNotify.length).toBeGreaterThanOrEqual(1);

    // Verify the delivery URL is constructed per-channel
    const allDeliverCalls = deliverSpy.mock.calls;
    for (const call of allDeliverCalls) {
      expect(call[0]).toBe("https://gateway.test/deliver/telegram");
    }

    deliverSpy.mockRestore();
  });

  test("non-expired approvals are not affected by the sweep", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const convId = "conv-not-expired";
    ensureConversation(convId);

    const sessionMock = registerPendingInteraction("req-ne-1", convId, "shell");

    createApprovalRequest({
      runId: "run-ne-1",
      requestId: "req-ne-1",
      conversationId: convId,
      channel: "telegram",
      requesterExternalUserId: "requester-ne",
      requesterChatId: "chat-requester-ne",
      guardianExternalUserId: "guardian-ne-user",
      guardianChatId: "guardian-ne-chat",
      toolName: "shell",
      expiresAt: Date.now() + 300_000, // still valid
    });

    sweepExpiredGuardianApprovals("https://gateway.test", () => "token");

    await new Promise((resolve) => setTimeout(resolve, 10));

    // The session should NOT have been called
    expect(sessionMock).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 24. Deliver-once idempotency guard
// ═══════════════════════════════════════════════════════════════════════════

describe("deliver-once idempotency guard", () => {
  test("claimRunDelivery returns true on first call, false on subsequent calls", () => {
    const runId = "run-idem-unit";
    expect(deliveryChannels.claimRunDelivery(runId)).toBe(true);
    expect(deliveryChannels.claimRunDelivery(runId)).toBe(false);
    expect(deliveryChannels.claimRunDelivery(runId)).toBe(false);
    deliveryChannels.resetRunDeliveryClaim(runId);
  });

  test("different run IDs are independent", () => {
    expect(deliveryChannels.claimRunDelivery("run-a")).toBe(true);
    expect(deliveryChannels.claimRunDelivery("run-b")).toBe(true);
    expect(deliveryChannels.claimRunDelivery("run-a")).toBe(false);
    expect(deliveryChannels.claimRunDelivery("run-b")).toBe(false);
    deliveryChannels.resetRunDeliveryClaim("run-a");
    deliveryChannels.resetRunDeliveryClaim("run-b");
  });

  test("resetRunDeliveryClaim allows re-claim", () => {
    const runId = "run-idem-reset";
    expect(deliveryChannels.claimRunDelivery(runId)).toBe(true);
    deliveryChannels.resetRunDeliveryClaim(runId);
    expect(deliveryChannels.claimRunDelivery(runId)).toBe(true);
    deliveryChannels.resetRunDeliveryClaim(runId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 26. Assistant-scoped guardian verification via handleChannelInbound
// ═══════════════════════════════════════════════════════════════════════════

describe("assistant-scoped guardian verification via handleChannelInbound", () => {
  test("verification code uses the threaded assistantId (default: self)", async () => {
    const { createInboundVerificationSession } =
      await import("../runtime/channel-verification-service.js");
    const { secret } = createInboundVerificationSession("telegram");

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const req = makeInboundRequest({
      content: secret,
      actorExternalId: "user-default-asst",
    });

    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.verificationOutcome).toBe("verified");

    deliverSpy.mockRestore();
  });

  test("verification code with explicit assistantId resolves against canonical scope", async () => {
    const { createInboundVerificationSession } =
      await import("../runtime/channel-verification-service.js");
    const { getGuardianBinding } =
      await import("../runtime/channel-verification-service.js");

    // All assistant IDs canonicalize to 'self' in the single-tenant daemon
    const { secret } = createInboundVerificationSession("telegram");

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const req = makeInboundRequest({
      content: secret,
      actorExternalId: "user-for-asst-x",
    });

    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "asst-route-X",
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.verificationOutcome).toBe("verified");

    const bindingX = getGuardianBinding("self", "telegram");
    expect(bindingX).not.toBeNull();
    expect(bindingX!.guardianExternalUserId).toBe("user-for-asst-x");

    deliverSpy.mockRestore();
  });

  test("all assistant IDs share canonical scope for verification", async () => {
    const { createInboundVerificationSession } =
      await import("../runtime/channel-verification-service.js");

    // Both IDs canonicalize to 'self', so the challenge is found
    const { secret } = createInboundVerificationSession("telegram");

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const req = makeInboundRequest({
      content: secret,
      actorExternalId: "user-cross-test",
    });

    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "asst-B-cross",
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.verificationOutcome).toBe("verified");

    deliverSpy.mockRestore();
  });

  test("inbound with explicit assistantId does not mutate existing external bindings", async () => {
    upsertContact({
      displayName: "Incoming User",
      channels: [
        {
          type: "telegram",
          address: "incoming-user",
          externalUserId: "incoming-user",
          status: "active",
          policy: "allow",
        },
      ],
    });

    const db = getDb();
    const now = Date.now();
    ensureConversation("conv-existing-binding");
    db.insert(externalConversationBindings)
      .values({
        conversationId: "conv-existing-binding",
        sourceChannel: "telegram",
        externalChatId: "chat-existing-999",
        externalUserId: "existing-user",
        createdAt: now,
        updatedAt: now,
        lastInboundAt: now,
      })
      .run();

    const req = makeInboundRequest({
      content: "hello from non-self assistant",
      actorExternalId: "incoming-user",
    });

    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "asst-non-self",
    );
    expect(res.status).toBe(200);

    const binding = db
      .select()
      .from(externalConversationBindings)
      .where(
        eq(
          externalConversationBindings.conversationId,
          "conv-existing-binding",
        ),
      )
      .get();
    expect(binding).not.toBeNull();
    expect(binding!.externalUserId).toBe("existing-user");
  });
});

// Sections 28-29 (verifyGatewayOrigin / gatewayOriginSecret integration) removed:
// gateway-origin proof is now handled by JWT auth — the gateway proves its
// identity by minting a daemon-audience token with the shared signing key.

// ═══════════════════════════════════════════════════════════════════════════
// Conversational approval engine — standard path
// ═══════════════════════════════════════════════════════════════════════════

describe("conversational approval engine — standard path", () => {
  beforeEach(() => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });
  });

  test("non-decision follow-up: engine returns keep_pending, reply sent", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-conv-1",
      conversationId!,
      "shell",
    );

    deliverSpy.mockClear();

    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "keep_pending" as const,
      replyText:
        "There is a pending shell command. Would you like to approve or deny it?",
    }));

    const req = makeInboundRequest({ content: "what does this command do?" });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("assistant_turn");

    // The engine reply should have been delivered
    expect(deliverSpy).toHaveBeenCalled();
    const replyCall = deliverSpy.mock.calls.find(
      (call) =>
        typeof call[1] === "object" &&
        (call[1] as { text?: string }).text?.includes("pending shell command"),
    );
    expect(replyCall).toBeDefined();

    // The session should NOT have received a decision
    expect(sessionMock).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
  });

  test("natural-language approval: engine returns approve_once, decision applied", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-conv-2",
      conversationId!,
      "shell",
    );

    deliverSpy.mockClear();

    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "approve_once" as const,
      replyText: "Got it, approving the shell command.",
    }));

    const req = makeInboundRequest({ content: "yeah go ahead and run it" });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");

    // The session should have received an allow decision
    expect(sessionMock).toHaveBeenCalledWith("req-conv-2", "allow");

    deliverSpy.mockRestore();
  });

  test('"nevermind" style message: engine returns reject, rejection applied', async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-conv-3",
      conversationId!,
      "shell",
    );

    deliverSpy.mockClear();

    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "reject" as const,
      replyText: "No problem, I've cancelled the shell command.",
    }));

    const req = makeInboundRequest({ content: "nevermind, don't run that" });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");

    expect(sessionMock).toHaveBeenCalledWith("req-conv-3", "deny");

    deliverSpy.mockRestore();
  });

  test("callback button still takes priority even with conversational engine present", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-conv-4",
      conversationId!,
      "shell",
    );

    // Mock conversational engine — should NOT be called for callback buttons
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "keep_pending" as const,
      replyText: "This should not be called",
    }));

    const req = makeInboundRequest({
      content: "",
      callbackData: "apr:req-conv-4:approve_once",
    });

    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");

    // The callback button should have been used directly, not the engine
    expect(mockConversationGenerator).not.toHaveBeenCalled();
    expect(sessionMock).toHaveBeenCalledWith("req-conv-4", "allow");

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Guardian conversational approval engine tests
// ═══════════════════════════════════════════════════════════════════════════

describe("guardian conversational approval via conversation engine", () => {
  test("guardian follow-up clarification: engine returns keep_pending", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-conv-user",
      guardianDeliveryChatId: "guardian-conv-chat",
      guardianPrincipalId: "guardian-conv-user",
    });

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const convId = "conv-guardian-clarify";
    ensureConversation(convId);

    const sessionMock = registerPendingInteraction(
      "req-gclarify-1",
      convId,
      "shell",
    );
    createApprovalRequest({
      runId: "run-gclarify-1",
      requestId: "req-gclarify-1",
      conversationId: convId,
      channel: "telegram",
      requesterExternalUserId: "requester-clarify",
      requesterChatId: "chat-requester-clarify",
      guardianExternalUserId: "guardian-conv-user",
      guardianChatId: "guardian-conv-chat",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "keep_pending" as const,
      replyText: "Could you clarify which action you want me to approve?",
    }));

    const req = makeInboundRequest({
      content: "hmm what does this do?",
      conversationExternalId: "guardian-conv-chat",
      actorExternalId: "guardian-conv-user",
    });

    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("assistant_turn");

    // The engine should have been called with role: 'guardian'
    expect(mockConversationGenerator).toHaveBeenCalledTimes(1);
    const callCtx = mockConversationGenerator.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(callCtx.role).toBe("guardian");
    expect(callCtx.allowedActions).toEqual(["approve_once", "reject"]);
    expect(callCtx.userMessage).toBe("hmm what does this do?");

    // The session should NOT have received a decision
    expect(sessionMock).not.toHaveBeenCalled();

    // The approval should still be pending
    const pending = getAllPendingApprovalsByGuardianChat(
      "telegram",
      "guardian-conv-chat",
    );
    expect(pending).toHaveLength(1);

    deliverSpy.mockRestore();
  });

  test("guardian natural-language approval: engine returns approve_once", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-nlp-user",
      guardianDeliveryChatId: "guardian-nlp-chat",
      guardianPrincipalId: "guardian-nlp-user",
    });

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const convId = "conv-guardian-nlp";
    ensureConversation(convId);

    const sessionMock = registerPendingInteraction(
      "req-gnlp-1",
      convId,
      "shell",
    );
    createApprovalRequest({
      runId: "run-gnlp-1",
      requestId: "req-gnlp-1",
      conversationId: convId,
      channel: "telegram",
      requesterExternalUserId: "requester-nlp",
      requesterChatId: "chat-requester-nlp",
      guardianExternalUserId: "guardian-nlp-user",
      guardianChatId: "guardian-nlp-chat",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "approve_once" as const,
      replyText: "Approved! The shell command will proceed.",
    }));

    const req = makeInboundRequest({
      content: "yes go ahead and run it",
      conversationExternalId: "guardian-nlp-chat",
      actorExternalId: "guardian-nlp-user",
    });

    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("guardian_decision_applied");

    // The session should have received an 'allow' decision
    expect(sessionMock).toHaveBeenCalledWith("req-gnlp-1", "allow");

    // The approval record should have been updated (no longer pending)
    const pending = getAllPendingApprovalsByGuardianChat(
      "telegram",
      "guardian-nlp-chat",
    );
    expect(pending).toHaveLength(0);

    // The engine context excluded approve_always for guardians
    const callCtx = mockConversationGenerator.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(callCtx.allowedActions).toEqual(["approve_once", "reject"]);
    expect(callCtx.allowedActions as string[]).not.toContain("approve_always");

    deliverSpy.mockRestore();
  });

  test("guardian callback button approve_always is downgraded to approve_once", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-dg-user",
      guardianDeliveryChatId: "guardian-dg-chat",
      guardianPrincipalId: "guardian-dg-user",
    });

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const convId = "conv-guardian-downgrade";
    ensureConversation(convId);

    const sessionMock = registerPendingInteraction(
      "req-gdg-1",
      convId,
      "shell",
    );
    createApprovalRequest({
      runId: "run-gdg-1",
      requestId: "req-gdg-1",
      conversationId: convId,
      channel: "telegram",
      requesterExternalUserId: "requester-dg",
      requesterChatId: "chat-requester-dg",
      guardianExternalUserId: "guardian-dg-user",
      guardianChatId: "guardian-dg-chat",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    // Guardian clicks approve_always via callback button
    const req = makeInboundRequest({
      content: "",
      conversationExternalId: "guardian-dg-chat",
      callbackData: "apr:req-gdg-1:approve_always",
      actorExternalId: "guardian-dg-user",
    });

    const res = await handleChannelInbound(req, noopProcessMessage, "self");
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("guardian_decision_applied");

    // approve_always should have been downgraded to approve_once ('allow')
    expect(sessionMock).toHaveBeenCalledWith("req-gdg-1", "allow");

    deliverSpy.mockRestore();
  });

  test("multi-pending guardian disambiguation: engine requests clarification", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-multi-user",
      guardianDeliveryChatId: "guardian-multi-chat",
      guardianPrincipalId: "guardian-multi-user",
    });

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const convA = "conv-multi-a";
    const convB = "conv-multi-b";
    ensureConversation(convA);
    ensureConversation(convB);

    const sessionA = registerPendingInteraction("req-multi-a", convA, "shell");
    createApprovalRequest({
      runId: "run-multi-a",
      requestId: "req-multi-a",
      conversationId: convA,
      channel: "telegram",
      requesterExternalUserId: "requester-multi-a",
      requesterChatId: "chat-requester-multi-a",
      guardianExternalUserId: "guardian-multi-user",
      guardianChatId: "guardian-multi-chat",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    const sessionB = registerPendingInteraction(
      "req-multi-b",
      convB,
      "file_edit",
    );
    createApprovalRequest({
      runId: "run-multi-b",
      requestId: "req-multi-b",
      conversationId: convB,
      channel: "telegram",
      requesterExternalUserId: "requester-multi-b",
      requesterChatId: "chat-requester-multi-b",
      guardianExternalUserId: "guardian-multi-user",
      guardianChatId: "guardian-multi-chat",
      toolName: "file_edit",
      expiresAt: Date.now() + 300_000,
    });

    // Engine returns keep_pending for disambiguation
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "keep_pending" as const,
      replyText: "You have 2 pending requests: shell and file_edit. Which one?",
    }));

    const req = makeInboundRequest({
      content: "approve it",
      conversationExternalId: "guardian-multi-chat",
      actorExternalId: "guardian-multi-user",
    });

    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("assistant_turn");

    // Neither session should have been called
    expect(sessionA).not.toHaveBeenCalled();
    expect(sessionB).not.toHaveBeenCalled();

    // The engine should have received both pending approvals
    expect(mockConversationGenerator).toHaveBeenCalledTimes(1);
    const engineCtx = mockConversationGenerator.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(engineCtx.pendingApprovals as Array<unknown>).toHaveLength(2);
    expect(engineCtx.role).toBe("guardian");

    // Disambiguation reply delivered to guardian
    const disambigCall = deliverSpy.mock.calls.find((call) =>
      (call[1] as { text?: string }).text?.includes("2 pending requests"),
    );
    expect(disambigCall).toBeTruthy();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// keep_pending must remain conversational (no deterministic fallback)
// ═══════════════════════════════════════════════════════════════════════════

describe("keep_pending remains conversational — standard path", () => {
  beforeEach(() => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });
  });

  test('explicit "approve" with keep_pending returns assistant_turn and does not auto-decide', async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-kp-1",
      conversationId!,
      "shell",
    );

    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "keep_pending" as const,
      replyText: "Before deciding, can you confirm the intent?",
    }));

    const req = makeInboundRequest({ content: "approve" });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("assistant_turn");
    expect(sessionMock).not.toHaveBeenCalled();

    const followupReply = deliverSpy.mock.calls.find((call) =>
      (call[1] as { text?: string }).text?.includes("confirm the intent"),
    );
    expect(followupReply).toBeDefined();

    deliverSpy.mockRestore();
  });
});

describe("keep_pending remains conversational — guardian path", () => {
  test('guardian explicit "yes" with keep_pending returns assistant_turn without applying a decision', async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-fb",
      guardianDeliveryChatId: "guardian-chat-fb",
      guardianPrincipalId: "guardian-user-fb",
    });

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const convId = "conv-gfb-1";
    ensureConversation(convId);

    const sessionMock = registerPendingInteraction(
      "req-gfb-1",
      convId,
      "shell",
    );
    createApprovalRequest({
      runId: "run-gfb-1",
      requestId: "req-gfb-1",
      conversationId: convId,
      channel: "telegram",
      requesterExternalUserId: "requester-user-fb",
      requesterChatId: "requester-chat-fb",
      guardianExternalUserId: "guardian-user-fb",
      guardianChatId: "guardian-chat-fb",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "keep_pending" as const,
      replyText: "Which run are you approving?",
    }));

    const guardianReq = makeInboundRequest({
      content: "yes",
      conversationExternalId: "guardian-chat-fb",
      actorExternalId: "guardian-user-fb",
    });
    const res = await handleChannelInbound(
      guardianReq,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("assistant_turn");
    expect(sessionMock).not.toHaveBeenCalled();

    const followupReply = deliverSpy.mock.calls.find((call) =>
      (call[1] as { text?: string }).text?.includes(
        "Which run are you approving",
      ),
    );
    expect(followupReply).toBeDefined();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Requester cancel of guardian-gated pending request
// ═══════════════════════════════════════════════════════════════════════════

describe("requester cancel of guardian-gated pending request", () => {
  beforeEach(() => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-cancel",
      guardianDeliveryChatId: "guardian-cancel-chat",
      guardianPrincipalId: "guardian-cancel",
    });
    upsertContact({
      displayName: "Requester Cancel User",
      channels: [
        {
          type: "telegram",
          address: "requester-cancel-user",
          externalUserId: "requester-cancel-user",
          status: "active",
          policy: "allow",
        },
      ],
    });
  });

  test('requester explicit "deny" can cancel when the conversation engine returns reject', async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    // Create requester conversation
    const initReq = makeInboundRequest({
      content: "init",
      conversationExternalId: "requester-cancel-chat",
      actorExternalId: "requester-cancel-user",
    });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-cancel-1",
      conversationId!,
      "shell",
    );

    createApprovalRequest({
      runId: "run-cancel-1",
      requestId: "req-cancel-1",
      conversationId: conversationId!,
      channel: "telegram",
      requesterExternalUserId: "requester-cancel-user",
      requesterChatId: "requester-cancel-chat",
      guardianExternalUserId: "guardian-cancel",
      guardianChatId: "guardian-cancel-chat",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    deliverSpy.mockClear();

    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "reject" as const,
      replyText: "Cancelling this request now.",
    }));

    const req = makeInboundRequest({
      content: "deny",
      conversationExternalId: "requester-cancel-chat",
      actorExternalId: "requester-cancel-user",
    });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalledWith("req-cancel-1", "deny");

    // Requester should have been notified
    const requesterReply = deliverSpy.mock.calls.find(
      (call) =>
        (call[1] as { chatId?: string }).chatId === "requester-cancel-chat",
    );
    expect(requesterReply).toBeDefined();

    // Guardian should have been notified of the cancellation
    const guardianNotice = deliverSpy.mock.calls.find(
      (call) =>
        (call[1] as { chatId?: string }).chatId === "guardian-cancel-chat",
    );
    expect(guardianNotice).toBeDefined();

    deliverSpy.mockRestore();
  });

  test('requester "nevermind" via conversational engine cancels guardian-gated request', async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({
      content: "init",
      conversationExternalId: "requester-cancel-chat",
      actorExternalId: "requester-cancel-user",
    });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-cancel-2",
      conversationId!,
      "shell",
    );

    createApprovalRequest({
      runId: "run-cancel-2",
      requestId: "req-cancel-2",
      conversationId: conversationId!,
      channel: "telegram",
      requesterExternalUserId: "requester-cancel-user",
      requesterChatId: "requester-cancel-chat",
      guardianExternalUserId: "guardian-cancel",
      guardianChatId: "guardian-cancel-chat",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    deliverSpy.mockClear();

    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "reject" as const,
      replyText: "OK, I have cancelled the pending request.",
    }));

    const req = makeInboundRequest({
      content: "actually never mind, cancel it",
      conversationExternalId: "requester-cancel-chat",
      actorExternalId: "requester-cancel-user",
    });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalledWith("req-cancel-2", "deny");

    // Engine should have been called with reject-only allowed actions
    expect(mockConversationGenerator).toHaveBeenCalledTimes(1);
    const engineCtx = mockConversationGenerator.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(engineCtx.allowedActions).toEqual(["reject"]);

    deliverSpy.mockRestore();
  });

  test("requester non-cancel message with keep_pending returns conversational reply", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({
      content: "init",
      conversationExternalId: "requester-cancel-chat",
      actorExternalId: "requester-cancel-user",
    });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    const sessionMock = registerPendingInteraction(
      "req-cancel-3",
      conversationId!,
      "shell",
    );

    createApprovalRequest({
      runId: "run-cancel-3",
      requestId: "req-cancel-3",
      conversationId: conversationId!,
      channel: "telegram",
      requesterExternalUserId: "requester-cancel-user",
      requesterChatId: "requester-cancel-chat",
      guardianExternalUserId: "guardian-cancel",
      guardianChatId: "guardian-cancel-chat",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    deliverSpy.mockClear();

    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "keep_pending" as const,
      replyText: "Still waiting.",
    }));

    const req = makeInboundRequest({
      content: "what is happening?",
      conversationExternalId: "requester-cancel-chat",
      actorExternalId: "requester-cancel-user",
    });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("assistant_turn");
    expect(sessionMock).not.toHaveBeenCalled();

    const pendingReply = deliverSpy.mock.calls.find((call) =>
      (call[1] as { text?: string }).text?.includes("Still waiting."),
    );
    expect(pendingReply).toBeDefined();

    deliverSpy.mockRestore();
  });

  test('requester "approve" is blocked — self-approval not allowed even during cancel check', async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({
      content: "init",
      conversationExternalId: "requester-cancel-chat",
      actorExternalId: "requester-cancel-user",
    });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    registerPendingInteraction("req-cancel-4", conversationId!, "shell");

    createApprovalRequest({
      runId: "run-cancel-4",
      requestId: "req-cancel-4",
      conversationId: conversationId!,
      channel: "telegram",
      requesterExternalUserId: "requester-cancel-user",
      requesterChatId: "requester-cancel-chat",
      guardianExternalUserId: "guardian-cancel",
      guardianChatId: "guardian-cancel-chat",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    deliverSpy.mockClear();

    // Requester tries to self-approve while guardian approval is pending.
    const req = makeInboundRequest({
      content: "approve",
      conversationExternalId: "requester-cancel-chat",
      actorExternalId: "requester-cancel-user",
    });
    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    // Should get the guardian-pending notice, NOT decision_applied
    expect(body.approval).toBe("assistant_turn");

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Engine decision race condition — standard path
// ═══════════════════════════════════════════════════════════════════════════

describe("engine decision race condition — standard path", () => {
  beforeEach(() => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });
  });

  test("returns stale_ignored when engine approves but interaction was already resolved", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({ content: "init" });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    registerPendingInteraction("req-race-1", conversationId!, "shell");

    deliverSpy.mockClear();

    // Engine returns approve_once, but resolves the pending interaction
    // before handleChannelDecision is called (simulating race condition)
    const mockConversationGenerator = mock(async (_ctx: unknown) => {
      pendingInteractions.resolve("req-race-1");
      return {
        disposition: "approve_once" as const,
        replyText: "Approved! Running the command now.",
      };
    });

    const req = makeInboundRequest({ content: "go ahead" });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("stale_ignored");

    // The engine's optimistic "Approved!" reply should NOT have been delivered
    const approvedReply = deliverSpy.mock.calls.find((call) =>
      (call[1] as { text?: string }).text?.includes("Approved!"),
    );
    expect(approvedReply).toBeUndefined();

    // A stale notice should have been delivered instead
    const staleReply = deliverSpy.mock.calls.find((call) =>
      (call[1] as { text?: string }).text?.includes("already been resolved"),
    );
    expect(staleReply).toBeDefined();

    deliverSpy.mockRestore();
  });
});

describe("engine decision race condition — guardian path", () => {
  test("returns stale_ignored when guardian engine approves but interaction was already resolved", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-race-user",
      guardianDeliveryChatId: "guardian-race-chat",
      guardianPrincipalId: "guardian-race-user",
    });

    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const convId = "conv-guardian-race";
    ensureConversation(convId);

    registerPendingInteraction("req-grc-1", convId, "shell");
    createApprovalRequest({
      runId: "run-grc-1",
      requestId: "req-grc-1",
      conversationId: convId,
      channel: "telegram",
      requesterExternalUserId: "requester-race-user",
      requesterChatId: "requester-race-chat",
      guardianExternalUserId: "guardian-race-user",
      guardianChatId: "guardian-race-chat",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    deliverSpy.mockClear();

    // Guardian engine returns approve_once, but resolves the pending interaction
    // to simulate a concurrent resolution (expiry sweep or requester cancel)
    const mockConversationGenerator = mock(async (_ctx: unknown) => {
      pendingInteractions.resolve("req-grc-1");
      return {
        disposition: "approve_once" as const,
        replyText: "Approved the request.",
      };
    });

    const guardianReq = makeInboundRequest({
      content: "approve it",
      conversationExternalId: "guardian-race-chat",
      actorExternalId: "guardian-race-user",
    });
    const res = await handleChannelInbound(
      guardianReq,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("stale_ignored");

    // The engine's "Approved the request." should NOT be delivered
    const optimisticReply = deliverSpy.mock.calls.find((call) =>
      (call[1] as { text?: string }).text?.includes("Approved the request"),
    );
    expect(optimisticReply).toBeUndefined();

    // A stale notice should have been delivered instead
    const staleReply = deliverSpy.mock.calls.find((call) =>
      (call[1] as { text?: string }).text?.includes("already been resolved"),
    );
    expect(staleReply).toBeDefined();

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Non-decision status reply for different channels
// ═══════════════════════════════════════════════════════════════════════════

describe("non-decision status reply for different channels", () => {
  beforeEach(() => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });
    createGuardianBinding({
      channel: "slack",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });
  });

  test("non-decision message on slack sends status reply", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    // Establish the conversation using slack
    const initReq = makeInboundRequest({
      content: "init",
      sourceChannel: "slack",
    });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    registerPendingInteraction("req-status-slack", conversationId!, "shell");

    // Send a non-decision message
    const req = makeInboundRequest({
      content: "what is happening?",
      sourceChannel: "slack",
    });
    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("assistant_turn");

    // Status reply delivered via deliverChannelReply
    expect(deliverSpy).toHaveBeenCalled();
    const statusCall = deliverSpy.mock.calls.find(
      (call) =>
        typeof call[1] === "object" &&
        (call[1] as { chatId?: string }).chatId === "chat-123",
    );
    expect(statusCall).toBeDefined();
    const statusPayload = statusCall![1] as { text?: string };
    expect(statusPayload.text).toContain("pending approval request");

    deliverSpy.mockRestore();
  });

  test("non-decision message on telegram sends status reply", async () => {
    const replySpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    // Establish the conversation using telegram (rich channel)
    const initReq = makeInboundRequest({
      content: "init",
      sourceChannel: "telegram",
    });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    registerPendingInteraction("req-status-tg", conversationId!, "shell");

    // Send a non-decision message
    const req = makeInboundRequest({
      content: "what is happening?",
      sourceChannel: "telegram",
    });
    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("assistant_turn");

    // Status reply delivered via deliverChannelReply
    expect(replySpy).toHaveBeenCalled();
    const statusCall = replySpy.mock.calls.find(
      (call) =>
        typeof call[1] === "object" &&
        (call[1] as { chatId?: string }).chatId === "chat-123",
    );
    expect(statusCall).toBeDefined();
    const statusPayload = statusCall![1] as { text?: string };
    expect(statusPayload.text).toContain("pending approval request");

    replySpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Background prompt delivery for channel-triggered tool approvals
// ═══════════════════════════════════════════════════════════════════════════

describe("background channel processing approval prompts", () => {
  test("marks guardian channel turns interactive and delivers approval prompt when confirmation is pending", async () => {
    // Set up a guardian binding so the sender is recognized as a guardian
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });

    const deliverPromptSpy = spyOn(
      gatewayClient,
      "deliverApprovalPrompt",
    ).mockResolvedValue(undefined);
    const processCalls: Array<{ options?: Record<string, unknown> }> = [];

    const processMessage = mock(
      async (
        conversationId: string,
        _content: string,
        _attachmentIds?: string[],
        options?: Record<string, unknown>,
      ) => {
        processCalls.push({ options });

        registerPendingInteraction("req-bg-1", conversationId, "host_bash", {
          input: { command: "ls -la" },
          riskLevel: "medium",
        });

        await new Promise((resolve) => setTimeout(resolve, 350));
        return { messageId: "msg-bg-1" };
      },
    );

    const req = makeInboundRequest({
      content: "run ls",
      sourceChannel: "telegram",
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
      externalMessageId: "msg-bg-1",
    });

    const res = await handleChannelInbound(
      req,
      processMessage as unknown as typeof noopProcessMessage,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(processCalls.length).toBeGreaterThan(0);
    expect(processCalls[0].options?.isInteractive).toBe(true);

    expect(deliverPromptSpy).toHaveBeenCalled();
    const approvalMeta = deliverPromptSpy.mock.calls[0]?.[3] as
      | { requestId?: string }
      | undefined;
    expect(approvalMeta?.requestId).toBe("req-bg-1");

    deliverPromptSpy.mockRestore();
  });

  test("guardian prompt delivery still works when binding ID formatting differs from sender ID", async () => {
    // Guardian binding includes extra whitespace; trust resolution canonicalizes
    // identity and prompt delivery should still treat this sender as the guardian.
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "  telegram-user-default  ",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "  telegram-user-default  ",
    });

    const deliverPromptSpy = spyOn(
      gatewayClient,
      "deliverApprovalPrompt",
    ).mockResolvedValue(undefined);
    const processCalls: Array<{ options?: Record<string, unknown> }> = [];

    const processMessage = mock(
      async (
        conversationId: string,
        _content: string,
        _attachmentIds?: string[],
        options?: Record<string, unknown>,
      ) => {
        processCalls.push({ options });

        registerPendingInteraction(
          "req-bg-format-1",
          conversationId,
          "host_bash",
          {
            input: { command: "ls -la" },
            riskLevel: "medium",
          },
        );

        await new Promise((resolve) => setTimeout(resolve, 350));
        return { messageId: "msg-bg-format-1" };
      },
    );

    const req = makeInboundRequest({
      content: "run ls",
      sourceChannel: "telegram",
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
      externalMessageId: "msg-bg-format-1",
    });

    const res = await handleChannelInbound(
      req,
      processMessage as unknown as typeof noopProcessMessage,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(processCalls.length).toBeGreaterThan(0);
    expect(processCalls[0].options?.isInteractive).toBe(true);
    expect(deliverPromptSpy).toHaveBeenCalled();

    deliverPromptSpy.mockRestore();
  });

  test("trusted-contact channel turns with resolvable guardian route are interactive", async () => {
    // Set up a guardian binding for a DIFFERENT user so the sender is a
    // trusted contact (not the guardian). The guardian route is resolvable
    // because the binding exists — approval notifications can be delivered.
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-other",
      guardianDeliveryChatId: "guardian-chat-other",
      guardianPrincipalId: "guardian-user-other",
    });

    const processCalls: Array<{ options?: Record<string, unknown> }> = [];

    const processMessage = mock(
      async (
        _conversationId: string,
        _content: string,
        _attachmentIds?: string[],
        options?: Record<string, unknown>,
      ) => {
        processCalls.push({ options });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { messageId: "msg-ng-1" };
      },
    );

    const req = makeInboundRequest({
      content: "run something",
      sourceChannel: "telegram",
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
      externalMessageId: "msg-ng-1",
    });

    const res = await handleChannelInbound(
      req,
      processMessage as unknown as typeof noopProcessMessage,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(processCalls.length).toBeGreaterThan(0);
    // Trusted contacts with a resolvable guardian route should be interactive
    // so approval prompts can be routed to the guardian for decision.
    expect(processCalls[0].options?.isInteractive).toBe(true);
  });

  test("unverified channel turns never broadcast approval prompts", async () => {
    // No guardian binding is created, so the sender resolves to unverified_channel.
    const deliverPromptSpy = spyOn(
      gatewayClient,
      "deliverApprovalPrompt",
    ).mockResolvedValue(undefined);
    const processCalls: Array<{ options?: Record<string, unknown> }> = [];

    const processMessage = mock(
      async (
        conversationId: string,
        _content: string,
        _attachmentIds?: string[],
        options?: Record<string, unknown>,
      ) => {
        processCalls.push({ options });

        // Simulate a pending confirmation becoming visible while background
        // processing is running. Unverified actors must still not receive it.
        registerPendingInteraction(
          "req-bg-unverified-1",
          conversationId,
          "host_bash",
          {
            input: { command: "ls -la" },
            riskLevel: "medium",
          },
        );

        await new Promise((resolve) => setTimeout(resolve, 350));
        return { messageId: "msg-bg-unverified-1" };
      },
    );

    const req = makeInboundRequest({
      content: "run ls",
      sourceChannel: "telegram",
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
      externalMessageId: "msg-bg-unverified-1",
    });

    const res = await handleChannelInbound(
      req,
      processMessage as unknown as typeof noopProcessMessage,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(processCalls.length).toBeGreaterThan(0);
    expect(processCalls[0].options?.isInteractive).toBe(false);
    expect(deliverPromptSpy).not.toHaveBeenCalled();

    deliverPromptSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NL approval routing via destination-scoped canonical requests
// ═══════════════════════════════════════════════════════════════════════════

describe("NL approval routing via destination-scoped canonical requests", () => {
  beforeEach(() => {
    resetTables();
    noopProcessMessage.mockClear();
  });

  test('guardian plain-text "yes" fails closed for tool_approval with no guardianExternalUserId', async () => {
    // Simulate a voice-originated tool approval without guardianExternalUserId
    const guardianChatId = "guardian-chat-nl-1";
    const guardianUserId = "guardian-user-nl-1";

    // Ensure the conversation exists so the resolver finds it
    ensureConversation("conv-voice-nl-1");

    // Create guardian binding for Telegram
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: guardianUserId,
      guardianDeliveryChatId: guardianChatId,

      guardianPrincipalId: guardianUserId,
    });

    // Create canonical tool_approval request WITHOUT guardianExternalUserId
    // but WITH a conversationId (required by the tool_approval resolver)
    const canonicalReq = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      sourceChannel: "twilio",
      conversationId: "conv-voice-nl-1",
      toolName: "shell",
      guardianPrincipalId: "test-principal-id",
      expiresAt: Date.now() + 60_000,
      // guardianExternalUserId intentionally omitted
    });

    // Register pending interaction so resolver can find it
    registerPendingInteraction(canonicalReq.id, "conv-voice-nl-1", "shell");

    // Create canonical delivery row targeting guardian chat
    createCanonicalGuardianDelivery({
      requestId: canonicalReq.id,
      destinationChannel: "telegram",
      destinationChatId: guardianChatId,
    });

    // Send inbound guardian text reply "yes" from that chat
    const req = makeInboundRequest({
      sourceChannel: "telegram",
      conversationExternalId: guardianChatId,
      actorExternalId: guardianUserId,
      content: "yes",
      externalMessageId: `msg-nl-approve-${Date.now()}`,
    });
    const res = await handleChannelInbound(req, noopProcessMessage as any);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.canonicalRouter).toBe("canonical_decision_stale");

    // Verify the request remains pending (identity-bound fail-closed).
    const resolved = getCanonicalGuardianRequest(canonicalReq.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("pending");
  });

  test("inbound from different chat ID does not auto-match delivery-scoped canonical request", async () => {
    const guardianChatId = "guardian-chat-nl-2";
    const guardianUserId = "guardian-user-nl-2";
    const differentChatId = "different-chat-999";

    // Create guardian binding for the guardian user on the different chat
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: guardianUserId,
      guardianDeliveryChatId: differentChatId,

      guardianPrincipalId: guardianUserId,
    });

    // Create canonical pending_question WITHOUT guardianExternalUserId
    const canonicalReq = createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "voice",
      sourceChannel: "twilio",
      toolName: "shell",
      guardianPrincipalId: "test-principal-id",
      expiresAt: Date.now() + 60_000,
    });

    // Delivery targets the original guardian chat, NOT the different chat
    createCanonicalGuardianDelivery({
      requestId: canonicalReq.id,
      destinationChannel: "telegram",
      destinationChatId: guardianChatId,
    });

    // Send from differentChatId — delivery-scoped lookup should not match
    const req = makeInboundRequest({
      sourceChannel: "telegram",
      conversationExternalId: differentChatId,
      actorExternalId: guardianUserId,
      content: "approve",
      externalMessageId: `msg-nl-mismatch-${Date.now()}`,
    });
    const res = await handleChannelInbound(req, noopProcessMessage as any);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    // Should NOT have been consumed by canonical router since there are no
    // delivery-scoped pending requests for this chat, and identity-based
    // fallback finds no match either (no guardianExternalUserId on request)
    expect(body.canonicalRouter).toBeUndefined();

    // Request should remain pending
    const unchanged = getCanonicalGuardianRequest(canonicalReq.id);
    expect(unchanged).not.toBeNull();
    expect(unchanged!.status).toBe("pending");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Trusted-contact self-approval guard (pre-row)
// ═══════════════════════════════════════════════════════════════════════════

describe("trusted-contact self-approval blocked before guardian approval row exists", () => {
  beforeEach(() => {
    // Create a guardian binding so the requester resolves as trusted_contact
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-tc-selfapproval",
      guardianDeliveryChatId: "guardian-tc-selfapproval-chat",
      guardianPrincipalId: "guardian-tc-selfapproval",
    });
    upsertContact({
      displayName: "TC Self-Approval User",
      channels: [
        {
          type: "telegram",
          address: "tc-selfapproval-user",
          externalUserId: "tc-selfapproval-user",
          status: "active",
          policy: "allow",
        },
      ],
    });
  });

  test("trusted contact cannot self-approve via conversational engine when no guardian approval row exists", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    // Create the requester conversation (different user than guardian)
    const initReq = makeInboundRequest({
      content: "init",
      conversationExternalId: "tc-selfapproval-chat",
      actorExternalId: "tc-selfapproval-user",
    });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    // Register a pending interaction — but do NOT create a guardian approval
    // row in channelGuardianApprovalRequests. This simulates the window
    // between the pending confirmation being created (isInteractive=true)
    // and the guardian approval prompt being delivered.
    const sessionMock = registerPendingInteraction(
      "req-tc-selfapproval-1",
      conversationId!,
      "shell",
    );

    deliverSpy.mockClear();

    // The conversational engine would normally classify "yes" as approve_once,
    // but the guard should intercept before the engine runs.
    const mockConversationGenerator = mock(async (_ctx: unknown) => ({
      disposition: "approve_once" as const,
      replyText: "Approved!",
    }));

    // Trusted contact sends "yes" to try to self-approve
    const req = makeInboundRequest({
      content: "yes",
      conversationExternalId: "tc-selfapproval-chat",
      actorExternalId: "tc-selfapproval-user",
    });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
      mockConversationGenerator,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    // Should be blocked with assistant_turn (pending guardian notice),
    // NOT decision_applied
    expect(body.approval).toBe("assistant_turn");
    // The session should NOT have been resolved
    expect(sessionMock).not.toHaveBeenCalled();

    // The pending interaction should still be registered (not consumed)
    const stillPending = pendingInteractions.get("req-tc-selfapproval-1");
    expect(stillPending).toBeDefined();

    deliverSpy.mockRestore();
  });

  test("trusted contact cannot self-approve via legacy parser when no guardian approval row exists", async () => {
    const deliverSpy = spyOn(
      gatewayClient,
      "deliverChannelReply",
    ).mockResolvedValue({ ok: true });

    const initReq = makeInboundRequest({
      content: "init",
      conversationExternalId: "tc-selfapproval-chat",
      actorExternalId: "tc-selfapproval-user",
    });
    await handleChannelInbound(initReq, noopProcessMessage);

    const db = getDb();
    const events = db.$client
      .prepare("SELECT conversation_id FROM channel_inbound_events")
      .all() as Array<{ conversation_id: string }>;
    const conversationId = events[0]?.conversation_id;
    ensureConversation(conversationId!);

    // Register pending interaction without guardian approval row
    const sessionMock = registerPendingInteraction(
      "req-tc-selfapproval-2",
      conversationId!,
      "shell",
    );

    deliverSpy.mockClear();

    // No conversational engine — falls through to legacy parser path.
    // "approve" would normally be parsed as an approval decision.
    const req = makeInboundRequest({
      content: "approve",
      conversationExternalId: "tc-selfapproval-chat",
      actorExternalId: "tc-selfapproval-user",
    });
    const res = await handleChannelInbound(req, noopProcessMessage);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    // Should be blocked, not decision_applied
    expect(body.approval).toBe("assistant_turn");
    expect(sessionMock).not.toHaveBeenCalled();

    // Pending interaction should still exist
    const stillPending = pendingInteractions.get("req-tc-selfapproval-2");
    expect(stillPending).toBeDefined();

    deliverSpy.mockRestore();
  });
});
