/**
 * Integration tests for the inbound invite redemption intercept.
 *
 * Validates that non-members with valid `/start iv_<token>` payloads are
 * granted access without guardian approval, and that invalid/expired/revoked
 * tokens produce the correct deterministic refusal messages.
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

const emitSignalCalls: Array<Record<string, unknown>> = [];
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitSignalCalls.push(params);
    return {
      signalId: "mock-signal-id",
      deduplicated: false,
      dispatched: true,
      reason: "mock",
      deliveryResults: [],
    };
  },
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

import {
  findContactChannel,
  upsertContact,
} from "../contacts/contact-store.js";
import { upsertContactChannel } from "../contacts/contacts-write.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createInvite, revokeInvite } from "../memory/invite-store.js";
import { handleChannelInbound } from "./helpers/channel-test-adapter.js";

initializeDb();

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
  db.run("DELETE FROM channel_guardian_approval_requests");
  db.run("DELETE FROM notification_events");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  emitSignalCalls.length = 0;
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
    content: "/start iv_sometoken",
    actorExternalId: "user-invite-123",
    actorDisplayName: "Invite User",
    actorUsername: "invite_user",
    replyCallbackUrl: "http://localhost:7830/deliver/telegram",
    sourceMetadata: {
      commandIntent: { type: "start", payload: "iv_sometoken" },
    },
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
 * Build a request with a specific invite token, using the structured
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

describe("inbound invite redemption intercept", () => {
  beforeEach(resetState);

  test("non-member with valid invite token becomes active member without guardian approval", async () => {
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: createTargetContact(),
      maxUses: 5,
    });

    const req = buildInviteRequest(rawToken);
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.inviteRedemption).toBe("redeemed");
    expect(json.memberId).toEqual(expect.any(String));
    expect(json.denied).toBeUndefined();

    // Verify the user is now an active member
    const result = findContactChannel({
      channelType: "telegram",
      externalUserId: "user-invite-123",
    });
    expect(result).not.toBeNull();
    expect(result!.channel.status).toBe("active");

    // Verify a welcome reply was delivered
    expect(deliverReplyCalls.length).toBe(1);
    const replyText = (deliverReplyCalls[0].payload as Record<string, unknown>)
      .text;
    expect(replyText).toContain("Welcome! You've been granted access.");
  });

  test("non-member with invalid token gets refusal text", async () => {
    const req = buildInviteRequest("completely-bogus-token-xyz");
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.denied).toBe(true);
    expect(json.inviteRedemption).toBe("invalid_token");

    // Verify refusal reply was delivered
    expect(deliverReplyCalls.length).toBe(1);
    const replyText = (deliverReplyCalls[0].payload as Record<string, unknown>)
      .text;
    expect(replyText).toContain("no longer valid");

    // Verify the user was NOT made a member
    const result = findContactChannel({
      channelType: "telegram",
      externalUserId: "user-invite-123",
    });
    expect(result).toBeNull();
  });

  test("non-member with expired token gets appropriate message", async () => {
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: createTargetContact(),
      maxUses: 1,
      expiresInMs: -1, // already expired
    });

    const req = buildInviteRequest(rawToken);
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.denied).toBe(true);
    expect(json.inviteRedemption).toBe("expired");

    expect(deliverReplyCalls.length).toBe(1);
    const replyText = (deliverReplyCalls[0].payload as Record<string, unknown>)
      .text;
    expect(replyText).toContain("no longer valid");
  });

  test("non-member with revoked token gets refusal text", async () => {
    const { rawToken, invite } = createInvite({
      sourceChannel: "telegram",
      contactId: createTargetContact(),
      maxUses: 5,
    });
    revokeInvite(invite.id);

    const req = buildInviteRequest(rawToken);
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.denied).toBe(true);
    expect(json.inviteRedemption).toBe("revoked");

    expect(deliverReplyCalls.length).toBe(1);
    const replyText = (deliverReplyCalls[0].payload as Record<string, unknown>)
      .text;
    expect(replyText).toContain("no longer valid");
  });

  test("existing /start gv_<token> guardian bootstrap flow is unaffected", async () => {
    // Send a /start gv_ command — should not be intercepted by the invite flow.
    // Without a valid bootstrap session, it should be denied at the ACL gate.
    const req = buildInboundRequest({
      content: "/start gv_some_bootstrap_token",
      sourceMetadata: {
        commandIntent: { type: "start", payload: "gv_some_bootstrap_token" },
      },
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    // Should be denied as a non-member (bootstrap token is invalid/no session)
    expect(json.denied).toBe(true);
    expect(json.reason).toBe("not_a_member");
    // Should NOT have invite redemption fields
    expect(json.inviteRedemption).toBeUndefined();
  });

  test("duplicate Telegram webhook deliveries do not double-redeem", async () => {
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: createTargetContact(),
      maxUses: 5,
    });

    const sharedMessageId = `msg-dedup-${Date.now()}`;
    const makeReq = () =>
      buildInviteRequest(rawToken, {
        externalMessageId: sharedMessageId,
      });

    // First delivery
    const resp1 = await handleChannelInbound(
      makeReq(),
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json1 = (await resp1.json()) as Record<string, unknown>;
    expect(json1.inviteRedemption).toBe("redeemed");

    // Second delivery (duplicate webhook)
    const resp2 = await handleChannelInbound(
      makeReq(),
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json2 = (await resp2.json()) as Record<string, unknown>;
    // Dedup kicks in — the message is treated as a duplicate and no second
    // redemption attempt occurs.
    expect(json2.duplicate).toBe(true);

    // Only one welcome reply was delivered
    expect(deliverReplyCalls.length).toBe(1);
  });

  test("existing active member sending normal message is unaffected", async () => {
    // Pre-create an active member
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "user-active-member",
      externalChatId: "chat-active",
      status: "active",
      policy: "allow",
    });

    // Active member sends a normal message (no invite token)
    const req = buildInboundRequest({
      content: "Hello, just a normal message!",
      actorExternalId: "user-active-member",
      conversationExternalId: "chat-active",
      sourceMetadata: {},
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    // Should be accepted normally, not denied, not invite-redeemed
    expect(json.accepted).toBe(true);
    expect(json.denied).toBeUndefined();
    expect(json.inviteRedemption).toBeUndefined();
  });

  test("channel mismatch returns appropriate message", async () => {
    // Create an invite for voice, but try to redeem via Telegram
    const { rawToken } = createInvite({
      sourceChannel: "phone",
      contactId: createTargetContact(),
      maxUses: 5,
    });

    const req = buildInviteRequest(rawToken);
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.denied).toBe(true);
    expect(json.inviteRedemption).toBe("channel_mismatch");

    expect(deliverReplyCalls.length).toBe(1);
    const replyText = (deliverReplyCalls[0].payload as Record<string, unknown>)
      .text;
    expect(replyText).toContain("not valid for this channel");
  });

  test("already-active member with invite token gets acknowledgement", async () => {
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: createTargetContact(),
      maxUses: 5,
    });

    // Pre-create an active member that will click the invite link
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "user-already-active",
      externalChatId: "chat-invite-test",
      status: "active",
      policy: "allow",
    });

    const req = buildInviteRequest(rawToken, {
      actorExternalId: "user-already-active",
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    // Active members pass through the ACL gate, so the invite intercept
    // does not fire. The message proceeds to normal processing.
    expect(json.accepted).toBe(true);
    expect(json.denied).toBeUndefined();
  });

  test("reactivation via invite preserves existing guardian-managed member display name", async () => {
    // Pre-create a revoked member named "Jeff" — the invite should preserve
    // that guardian-assigned name rather than overwriting with the Telegram name.
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "user-invite-123",
      externalChatId: "chat-invite-test",
      status: "revoked",
      policy: "allow",
      displayName: "Jeff",
    });

    // Look up the contact that upsertContactChannel created so we can use
    // its ID as the invite's contactId (satisfies the FK constraint).
    const existing = findContactChannel({
      channelType: "telegram",
      externalUserId: "user-invite-123",
      externalChatId: "chat-invite-test",
    });
    const targetContactId = existing!.contact.id;

    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 5,
    });

    const req = buildInviteRequest(rawToken, {
      actorDisplayName: "Noa Flaherty",
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.inviteRedemption).toBe("redeemed");

    const result = findContactChannel({
      channelType: "telegram",
      externalUserId: "user-invite-123",
      externalChatId: "chat-invite-test",
    });
    expect(result).not.toBeNull();
    expect(result!.channel.status).toBe("active");
    expect(result!.contact.displayName).toBe("Jeff");
  });
});
