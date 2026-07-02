/**
 * Integration tests pinning that the daemon performs NO local invite
 * interception on inbound text messages.
 *
 * Invite 6-digit codes and `/start iv_<token>` deep links are redeemed at
 * gateway ingress and never forwarded to the daemon. Any such message that
 * reaches the runtime was already judged a non-invite by the gateway, so the
 * daemon must treat it as a normal message: non-members flow through the
 * standard ACL deny lane with no redemption attempt or invite-store lookup.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

// Mock the credential metadata store so the Telegram transport adapter
// resolves without touching the filesystem.
mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: () => undefined,
  upsertCredentialMetadata: () => {},
  deleteCredentialMetadata: () => {},
  listCredentialMetadata: () => [],
}));

mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async () => ({
    signalId: "mock-signal-id",
    deduplicated: false,
    dispatched: true,
    reason: "mock",
    deliveryResults: [],
  }),
}));

const deliverReplyCalls: Array<{
  url: string;
  payload: Record<string, unknown>;
}> = [];
mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (
    url: string,
    payload: Record<string, unknown>,
  ) => {
    deliverReplyCalls.push({ url, payload });
  },
}));

mock.module("../runtime/approval-message-composer.js", () => ({
  composeApprovalMessage: () => "mock approval message",
  composeApprovalMessageGenerative: async () => "mock generative message",
}));

// There is no daemon-side redemption service to spy on — the daemon has no
// local redemption code path at all (redemption is gateway-native). These
// tests pin the observable behavior instead: the sender never becomes a
// member and the invite row is never consumed.

// Stub the gateway IPC so ACL reads resolve deterministically without a
// running gateway socket.
mock.module("../ipc/gateway-client.js", () => ({
  ipcCallPersistent: async () => undefined,
}));

import {
  findContactChannel,
  upsertContact,
} from "../contacts/contact-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { createInvite, findById } from "../persistence/invite-store.js";
import { hashVoiceCode } from "../util/voice-code.js";
import {
  handleChannelInbound,
  seedContactChannel,
} from "./helpers/channel-test-adapter.js";
import { resetGatewayAclStore } from "./helpers/gateway-acl-store.js";

await initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a throwaway contact and return its ID, for use as the invite's contactId. */
function createTargetContact(displayName = "Test Contact"): string {
  return upsertContact({ displayName, role: "contact" }).id;
}

const TEST_BEARER_TOKEN = "test-token";
let msgCounter = 0;

function resetState(): void {
  const db = getDb();
  db.run("DELETE FROM assistant_ingress_invites");
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM notification_events");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  resetGatewayAclStore();
  deliverReplyCalls.length = 0;
  msgCounter = 0;
}

function buildInboundRequest(overrides: Record<string, unknown> = {}): Request {
  msgCounter++;
  const body: Record<string, unknown> = {
    sourceChannel: "telegram",
    interface: "telegram",
    conversationExternalId: "chat-invite-test",
    externalMessageId: `msg-invite-${Date.now()}-${msgCounter}`,
    content: "hello there",
    actorExternalId: "user-invite-123",
    actorDisplayName: "Invite User",
    actorUsername: "invite_user",
    replyCallbackUrl: "http://localhost:7830/deliver/telegram",
    sourceMetadata: {},
    ...overrides,
  };

  return new Request("http://localhost:8080/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": TEST_BEARER_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Build a request carrying an invite token deep link, using the structured
 * commandIntent that the gateway produces for `/start <payload>`.
 */
function buildInviteRequest(
  rawToken: string,
  overrides: Record<string, unknown> = {},
): Request {
  return buildInboundRequest({
    content: `/start iv_${rawToken}`,
    sourceMetadata: {
      commandIntent: { type: "start", payload: `iv_${rawToken}` },
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inbound invite messages — no daemon-side interception", () => {
  beforeEach(resetState);

  test("non-member /start iv_<valid token> is denied as a normal non-member, no redemption", async () => {
    const { rawToken, invite } = createInvite({
      sourceChannel: "telegram",
      contactId: createTargetContact(),
      maxUses: 5,
    });

    const req = buildInviteRequest(rawToken);
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    // Standard non-member deny — no invite redemption surface in the response.
    expect(json.accepted).toBe(true);
    expect(json.denied).toBe(true);
    expect(json.reason).toBe("not_a_member");
    expect(json.inviteRedemption).toBeUndefined();
    expect(json.memberId).toBeUndefined();

    // The sender was NOT made a member and the invite was not consumed.
    expect(
      findContactChannel({
        channelType: "telegram",
        address: "user-invite-123",
      }),
    ).toBeNull();
    const inviteAfter = findById(invite.id);
    expect(inviteAfter!.useCount).toBe(0);
    expect(inviteAfter!.status).toBe("active");

    // The standard ACL rejection reply was delivered.
    expect(deliverReplyCalls.length).toBe(1);
    const replyText = String(
      (deliverReplyCalls[0].payload as Record<string, unknown>).text,
    );
    expect(replyText).toMatch(/approved|tried talking to me/);
  });

  test("non-member bare 6-digit message matching an active invite code is denied as a normal message", async () => {
    const code = "123456";
    const { invite } = createInvite({
      sourceChannel: "telegram",
      contactId: createTargetContact(),
      maxUses: 5,
      inviteCodeHash: hashVoiceCode(code),
    });

    const req = buildInboundRequest({ content: code });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    // The gateway already judged this message a non-invite; the daemon
    // treats it as any other non-member message.
    expect(json.accepted).toBe(true);
    expect(json.denied).toBe(true);
    expect(json.reason).toBe("not_a_member");
    expect(json.inviteRedemption).toBeUndefined();

    // No membership granted, invite untouched.
    expect(
      findContactChannel({
        channelType: "telegram",
        address: "user-invite-123",
      }),
    ).toBeNull();
    expect(findById(invite.id)!.useCount).toBe(0);
  });

  test("existing /start gv_<token> guardian bootstrap flow is unaffected", async () => {
    // Send a /start gv_ command — without a valid bootstrap session it is
    // denied at the ACL gate like any other non-member message.
    const req = buildInboundRequest({
      content: "/start gv_some_bootstrap_token",
      sourceMetadata: {
        commandIntent: { type: "start", payload: "gv_some_bootstrap_token" },
      },
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.denied).toBe(true);
    expect(json.reason).toBe("not_a_member");
  });

  test("existing active member sending a normal message is unaffected", async () => {
    seedContactChannel({
      sourceChannel: "telegram",
      externalUserId: "user-active-member",
      externalChatId: "chat-active",
      status: "active",
      policy: "allow",
    });

    const req = buildInboundRequest({
      content: "Hello, just a normal message!",
      actorExternalId: "user-active-member",
      conversationExternalId: "chat-active",
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.denied).toBeUndefined();
  });

  test("active member sending a bare 6-digit message is processed as a normal message", async () => {
    seedContactChannel({
      sourceChannel: "telegram",
      externalUserId: "user-active-member",
      externalChatId: "chat-active",
      status: "active",
      policy: "allow",
    });
    // Even with a live invite whose code matches, the daemon does not
    // intercept — the message flows to normal processing.
    createInvite({
      sourceChannel: "telegram",
      contactId: createTargetContact(),
      maxUses: 5,
      inviteCodeHash: hashVoiceCode("654321"),
    });

    const req = buildInboundRequest({
      content: "654321",
      actorExternalId: "user-active-member",
      conversationExternalId: "chat-active",
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.denied).toBeUndefined();
    expect(json.inviteRedemption).toBeUndefined();
  });
});
