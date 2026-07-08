import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const _conversationMocks = new Map<string, unknown>();
mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => _conversationMocks.get(id),
}));

// Mock render to return the raw content as text
mock.module("../daemon/handlers/shared.js", () => ({
  renderHistoryContent: (content: unknown) => ({
    text: typeof content === "string" ? content : JSON.stringify(content),
    toolCalls: [],
    toolCallsBeforeText: false,
    textSegments: [],
    contentOrder: [],
    surfaces: [],
    thinkingSegments: [],
  }),
}));

// The handler imports processMessage directly — provide a controllable mock so
// background dispatch doesn't attempt a real agent loop (no LLM provider in tests).
// Tests that need a custom processMessage can override via setTestProcessMessage().
let _testProcessMessage: ((...args: unknown[]) => unknown) | undefined;

function setTestProcessMessage(fn: (...args: any[]) => any): void {
  _testProcessMessage = fn;
}

mock.module("../daemon/process-message.js", () => ({
  // Only processMessage is imported by inbound-message-handler; stub the rest.
  resolveTurnChannel: () => "telegram",
  resolveTurnInterface: () => "telegram",
  prepareConversationForMessage: async () => ({}),
  processMessage: (...args: unknown[]) => {
    if (_testProcessMessage) return _testProcessMessage(...args);
    return Promise.resolve({ messageId: "mock-msg-1" });
  },
  processMessageInBackground: async () => ({ messageId: "mock-bg" }),
}));

// Approval generators require a configured LLM provider. Expose module-level
// overrides so individual tests can inject custom generators (e.g. conversation
// engine mocks) while defaulting to undefined for the plain-text matching path.
let _testApprovalCopyGenerator: unknown = undefined;
let _testApprovalConversationGenerator: unknown = undefined;

function setTestApprovalConversationGenerator(gen: unknown): void {
  _testApprovalConversationGenerator = gen;
}

mock.module("../daemon/approval-generators.js", () => ({
  createApprovalCopyGenerator: () => _testApprovalCopyGenerator,
  createApprovalConversationGenerator: () => _testApprovalConversationGenerator,
}));

import {
  createCanonicalGuardianDelivery,
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
} from "../contacts/canonical-guardian-store.js";
import type { Conversation } from "../daemon/conversation.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import * as deliveryChannels from "../persistence/delivery-channels.js";
import { resetTestTables } from "../persistence/raw-query.js";
import { conversations } from "../persistence/schema/index.js";
import { initAuthSigningKey } from "../runtime/auth/token-service.js";
import * as gatewayClient from "../runtime/gateway-client.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { _setTestPollMaxWait } from "../runtime/routes/channel-route-shared.js";
import { resetDbForTesting } from "./db-test-helpers.js";
import {
  handleChannelInbound,
  seedContactChannel,
} from "./helpers/channel-test-adapter.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";
import { resetGatewayAclStore } from "./helpers/gateway-acl-store.js";

await initializeDb();
initAuthSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long"));

afterAll(() => {
  resetDbForTesting();
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
    "conversation_keys",
    "message_runs",
    "channel_inbound_events",
    "messages",
    "conversations",
    "contact_channels",
    "contacts",
  );
  resetGatewayAclStore();
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
  const _mockSession = {
    handleConfirmationResponse,
    ensureActorScopedHistory: async () => {},
  } as unknown as Conversation;
  _conversationMocks.set(conversationId, _mockSession);

  pendingInteractions.register(requestId, {
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
  seedContactChannel({
    sourceChannel: "telegram",
    externalUserId: "telegram-user-default",
    displayName: "Test User",
    status: "active",
    policy: "allow",
  });
  seedContactChannel({
    sourceChannel: "slack",
    externalUserId: "slack-user-default",
    displayName: "Test User",
    status: "active",
    policy: "allow",
  });
}

beforeEach(() => {
  resetTables();
  ensureTestContact();
  noopProcessMessage.mockClear();
  _testProcessMessage = undefined;
  _testApprovalCopyGenerator = undefined;
  _testApprovalConversationGenerator = undefined;
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
    expect(sessionMock).toHaveBeenCalledWith("req-cb-1", "allow", {
      decisionContext: undefined,
    });

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
    expect(sessionMock).toHaveBeenCalledWith("req-cb-2", "deny", {
      decisionContext: undefined,
    });

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
    expect(sessionMock).toHaveBeenCalledWith("req-txt-1", "allow", {
      decisionContext: undefined,
    });

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
    expect(sessionMock).toHaveBeenCalledWith("req-empty-1", "allow", {
      decisionContext: undefined,
    });

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
    expect(sessionMock).toHaveBeenCalledWith("req-match", "allow", {
      decisionContext: undefined,
    });

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
    expect(sessionMock).toHaveBeenCalledWith("req-plaintext", "allow", {
      decisionContext: undefined,
    });

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
    expect(sessionMock).toHaveBeenCalledWith("req-pt-1", "allow", {
      decisionContext: undefined,
    });

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
    expect(sessionMock).toHaveBeenCalledWith("req-pt-2", "deny", {
      decisionContext: undefined,
    });

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
    ).mockResolvedValue({ ok: true });

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
// ═══════════════════════════════════════════════════════════════════════════
// 21. Guardian decision scoping — callback for older request
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 22. Ambiguous plain-text decision with multiple pending requests
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 23. Expired guardian approval auto-denies and transitions to terminal status
// ═══════════════════════════════════════════════════════════════════════════

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
    setTestApprovalConversationGenerator(mockConversationGenerator);

    const req = makeInboundRequest({ content: "what does this command do?" });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
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
    setTestApprovalConversationGenerator(mockConversationGenerator);

    const req = makeInboundRequest({ content: "yeah go ahead and run it" });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");

    // The session should have received an allow decision
    expect(sessionMock).toHaveBeenCalledWith("req-conv-2", "allow", {
      decisionContext: undefined,
    });

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
    setTestApprovalConversationGenerator(mockConversationGenerator);

    const req = makeInboundRequest({ content: "nevermind, don't run that" });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");

    expect(sessionMock).toHaveBeenCalledWith("req-conv-3", "deny", {
      decisionContext: undefined,
    });

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
    setTestApprovalConversationGenerator(mockConversationGenerator);

    const req = makeInboundRequest({
      content: "",
      callbackData: "apr:req-conv-4:approve_once",
    });

    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.approval).toBe("decision_applied");

    // The callback button should have been used directly, not the engine
    expect(mockConversationGenerator).not.toHaveBeenCalled();
    expect(sessionMock).toHaveBeenCalledWith("req-conv-4", "allow", {
      decisionContext: undefined,
    });

    deliverSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Guardian conversational approval engine tests
// ═══════════════════════════════════════════════════════════════════════════

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
    setTestApprovalConversationGenerator(mockConversationGenerator);

    const req = makeInboundRequest({ content: "approve" });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
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

// ═══════════════════════════════════════════════════════════════════════════
// Requester cancel of guardian-gated pending request
// ═══════════════════════════════════════════════════════════════════════════

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
    setTestApprovalConversationGenerator(mockConversationGenerator);

    const req = makeInboundRequest({ content: "go ahead" });
    const res = await handleChannelInbound(
      req,
      noopProcessMessage,
      "self",
      undefined,
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
    ).mockResolvedValue({ ok: true });
    const processCalls: Array<{ options?: Record<string, unknown> }> = [];

    const processMessage = mock(
      async (
        conversationId: string,
        _content: string,
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

    setTestProcessMessage(processMessage);
    const res = await handleChannelInbound(req);
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
    ).mockResolvedValue({ ok: true });
    const processCalls: Array<{ options?: Record<string, unknown> }> = [];

    const processMessage = mock(
      async (
        conversationId: string,
        _content: string,
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

    setTestProcessMessage(processMessage);
    const res = await handleChannelInbound(req);
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

    setTestProcessMessage(processMessage);
    const res = await handleChannelInbound(req);
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
    ).mockResolvedValue({ ok: true });
    const processCalls: Array<{ options?: Record<string, unknown> }> = [];

    const processMessage = mock(
      async (
        conversationId: string,
        _content: string,
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

    setTestProcessMessage(processMessage);
    const res = await handleChannelInbound(req);
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
    seedContactChannel({
      sourceChannel: "telegram",
      externalUserId: "tc-selfapproval-user",
      displayName: "TC Self-Approval User",
      status: "active",
      policy: "allow",
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

    // Register a pending interaction — but do NOT create a canonical guardian
    // request row. This simulates the window between the pending confirmation
    // being created (isInteractive=true) and the guardian approval prompt being
    // delivered.
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
    setTestApprovalConversationGenerator(mockConversationGenerator);

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
