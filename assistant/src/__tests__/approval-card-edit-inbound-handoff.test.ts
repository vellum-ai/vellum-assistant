/**
 * The inbound handoff of the approval-card message id, driven through the
 * real handler.
 *
 * The companion suite (approval-card-edit.test.ts) pins the interception
 * seam but injects `approvalMessageId` directly, so it stays green if the
 * inbound handler stops reading `sourceMetadata.messageId` off the wire.
 * This suite closes that gap: a Telegram button decision enters through
 * `handleChannelInbound` exactly as the gateway forwards it, and the edit
 * must address the message id the wire carried.
 */
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

const _conversationMocks = new Map<string, unknown>();
mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => _conversationMocks.get(id),
}));

mock.module("../runtime/local-actor-identity.js", () => ({
  findLocalGuardianPrincipalId: async () => "vellum-principal-1",
}));

import type { TrustVerdict } from "@vellumai/gateway-client";

import type { Conversation } from "../daemon/conversation.js";
import * as providers from "../messaging/providers/index.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import {
  handleChannelInbound,
  setAdapterProcessMessage,
} from "./helpers/channel-test-adapter.js";

await initializeDb();

const CHAT_ID = "chat-123";
const GUARDIAN = "user-1";
const BUTTON_MESSAGE_ID = "4242";
const CALLBACK_URL = "https://gateway.test/deliver/telegram";

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

function guardianVerdict(): TrustVerdict {
  return {
    trustClass: "guardian",
    canonicalSenderId: GUARDIAN,
    contactId: "contact-1",
    channelId: "channel-1",
    type: "telegram",
    address: GUARDIAN,
    externalChatId: CHAT_ID,
    status: "active",
    policy: "allow",
    guardianExternalUserId: GUARDIAN,
    guardianDeliveryChatId: CHAT_ID,
    guardianPrincipalId: "vellum-principal-1",
  } satisfies TrustVerdict;
}

function makeInboundRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": "test-token",
    },
    body: JSON.stringify({
      sourceChannel: "telegram",
      interface: "telegram",
      conversationExternalId: CHAT_ID,
      externalMessageId: `msg-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      content: "hello",
      actorExternalId: GUARDIAN,
      replyCallbackUrl: CALLBACK_URL,
      sourceMetadata: { trustVerdict: guardianVerdict() },
      ...overrides,
    }),
  });
}

function conversationIdFromInboundEvents(): string {
  const rows = getDb()
    .$client.prepare("SELECT conversation_id FROM channel_inbound_events")
    .all() as Array<{ conversation_id: string }>;
  expect(rows.length).toBeGreaterThan(0);
  return rows[0].conversation_id;
}

function registerPendingInteraction(
  requestId: string,
  conversationId: string,
): void {
  const _mockSession = {
    handleConfirmationResponse: mock(() => {}),
    ensureActorScopedHistory: async () => {},
  } as unknown as Conversation;
  _conversationMocks.set(conversationId, _mockSession);

  pendingInteractions.register(requestId, {
    conversationId,
    kind: "confirmation",
    confirmationDetails: {
      toolName: "execute_shell",
      input: { command: "ls" },
      riskLevel: "high",
      allowlistOptions: [
        { label: "test", description: "test", pattern: "test" },
      ],
      scopeOptions: [{ label: "everywhere", scope: "everywhere" }],
    },
  });
}

describe("approval-card edit: inbound message-id handoff", () => {
  let editSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetTables();
    pendingInteractions.clear();
    _conversationMocks.clear();
    setAdapterProcessMessage(undefined);
    editSpy = spyOn(providers, "editChannelMessage").mockResolvedValue({
      ok: true,
    });
  });

  test("a Telegram button press edits the message id the wire carried", async () => {
    // First inbound materializes the conversation the pending approval
    // will hang off, the way a real approval prompt's conversation exists
    // before its buttons are pressed.
    const first = await handleChannelInbound(makeInboundRequest());
    expect(((await first.json()) as { accepted?: boolean }).accepted).toBe(
      true,
    );
    const conversationId = conversationIdFromInboundEvents();
    registerPendingInteraction("req-handoff-1", conversationId);

    // The gateway forwards a button press with the keyboard message's id on
    // sourceMetadata.messageId; nothing in this request names the id any
    // other way, so the edit below proves the handler read it off the wire.
    const res = await handleChannelInbound(
      makeInboundRequest({
        content: "",
        callbackData: "apr:req-handoff-1:approve_once",
        sourceMetadata: {
          trustVerdict: guardianVerdict(),
          messageId: BUTTON_MESSAGE_ID,
        },
      }),
    );
    expect(res.status).toBe(200);

    expect(editSpy).toHaveBeenCalledTimes(1);
    const [callbackUrl, payload] = editSpy.mock.calls[0];
    expect(callbackUrl).toBe(CALLBACK_URL);
    expect(payload.chatId).toBe(CHAT_ID);
    expect(payload.messageId).toBe(BUTTON_MESSAGE_ID);
    expect(payload.text).toContain("Approved");

    editSpy.mockRestore();
  });

  test("a button press whose wire carries no message id edits nothing", async () => {
    // The inverse pin: the edit is driven by the wire's id and only by it.
    const first = await handleChannelInbound(makeInboundRequest());
    expect(((await first.json()) as { accepted?: boolean }).accepted).toBe(
      true,
    );
    const conversationId = conversationIdFromInboundEvents();
    registerPendingInteraction("req-handoff-2", conversationId);

    const res = await handleChannelInbound(
      makeInboundRequest({
        content: "",
        callbackData: "apr:req-handoff-2:approve_once",
        sourceMetadata: { trustVerdict: guardianVerdict() },
      }),
    );
    expect(res.status).toBe(200);

    expect(editSpy).not.toHaveBeenCalled();

    editSpy.mockRestore();
  });
});
