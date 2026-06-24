import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Wrap the real contacts-write so a test can force the best-effort local mirror
// to fail (simulating a gateway-verified activation whose local DB row failed),
// while normal setup keeps the real implementation. Capture the concrete real
// function BEFORE registering the mock so the wrapper never recurses into
// itself via the (now live) module namespace.
const contactsWriteState = { mirrorThrows: false };
const realContactsWrite = await import("../contacts/contacts-write.js");
const realUpsertContactChannel = realContactsWrite.upsertContactChannel;
mock.module("../contacts/contacts-write.js", () => ({
  ...realContactsWrite,
  upsertContactChannel: (
    params: Parameters<typeof realUpsertContactChannel>[0],
  ) => {
    if (contactsWriteState.mirrorThrows) {
      throw new Error("local mirror exploded");
    }
    return realUpsertContactChannel(params);
  },
}));

// Mock the gateway IPC bridge used by the redemption service for the
// authoritative pre-mutation claim (record_invite_redemption). Tests drive the
// claim result via `gatewayIpc`.
const gatewayIpc = {
  claim: { ok: true, updated: true, mirrored: true } as {
    ok: boolean;
    updated: boolean;
    mirrored: boolean;
  },
  claimThrows: false,
  // When set, contacts_get_rich throws (gateway read unreachable) so the
  // gate-status fallback must fail open.
  richThrows: false,
  // When set, overrides the contacts_get_rich response (e.g. a gateway row
  // under a divergent UUID for the same (type,address)).
  richOverride: null as ((contactId: string | undefined) => unknown) | null,
  // Drives the upsert_verified_channel relay verdict. When false the gateway
  // refuses the actor (blocked/revoked) and the activation is refused.
  activationVerified: true,
  // Gateway channel returned on a verified activation, surfaced as the memberId
  // when the local mirror produces no row.
  activationChannelId: "gw-channel-id" as string | undefined,
  calls: [] as { method: string; params?: Record<string, unknown> }[],
};

mock.module("../ipc/gateway-client.js", () => ({
  ipcCallPersistent: async (
    method: string,
    params?: Record<string, unknown>,
  ) => {
    gatewayIpc.calls.push({ method, params });
    if (method === "contacts_get_rich") {
      if (gatewayIpc.richThrows) throw new Error("gateway read unreachable");
      if (gatewayIpc.richOverride) {
        return gatewayIpc.richOverride(params?.contactId as string);
      }
      return richContactForId(params?.contactId as string);
    }
    if (method === "record_invite_redemption") {
      if (gatewayIpc.claimThrows) throw new Error("gateway unreachable");
      onGatewayClaim?.();
      return gatewayIpc.claim;
    }
    if (method === "upsert_verified_channel") {
      if (!gatewayIpc.activationVerified) {
        return { ok: true, verified: false };
      }
      return {
        ok: true,
        verified: true,
        channel: gatewayIpc.activationChannelId
          ? {
              id: gatewayIpc.activationChannelId,
              contactId: (params?.contactId as string) ?? "gw-contact",
              type: (params?.type as string) ?? "telegram",
              address: (params?.address as string) ?? "gw-addr",
              status: "active",
              verifiedAt: 1,
              verifiedVia: (params?.verifiedVia as string) ?? "invite",
            }
          : undefined,
      };
    }
    return undefined;
  },
}));

// Serves contacts_get_rich (the gateway ACL read backing the gate-status
// fallback) from the seeded local contact, so gate resolution sources status
// from the gateway path rather than the local channel column.
function richContactForId(contactId: string | undefined) {
  if (!contactId) return undefined;
  const contact = getContact(contactId);
  if (!contact) return undefined;
  return {
    ok: true,
    contact: {
      id: contact.id,
      displayName: contact.displayName,
      role: contact.role,
      interactionCount: contact.interactionCount,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
      channels: contact.channels.map((c) => ({
        id: c.id,
        contactId: c.contactId,
        type: c.type,
        address: c.address,
        isPrimary: c.isPrimary,
        externalUserId: c.externalChatId,
        status: c.status,
        policy: c.policy,
        verifiedAt: c.verifiedAt,
        verifiedVia: c.verifiedVia,
        lastSeenAt: c.lastSeenAt,
        interactionCount: c.interactionCount,
        lastInteraction: c.lastInteraction,
        revokedReason: c.revokedReason,
        blockedReason: c.blockedReason,
      })),
    },
  };
}

// Lets a test inject a side-effect into the gateway claim — runs after the
// service's pre-validation but before the assistant use-bump, so it can race a
// revoke into the window that makes `recordInviteUse` return false.
let onGatewayClaim: (() => void) | null = null;

function resetGatewayIpc() {
  gatewayIpc.claim = { ok: true, updated: true, mirrored: true };
  gatewayIpc.claimThrows = false;
  gatewayIpc.richThrows = false;
  gatewayIpc.richOverride = null;
  gatewayIpc.activationVerified = true;
  gatewayIpc.activationChannelId = "gw-channel-id";
  gatewayIpc.calls = [];
  onGatewayClaim = null;
}

import type { TrustVerdict } from "@vellumai/gateway-client";

import {
  findContactChannel,
  getContact,
  upsertContact,
} from "../contacts/contact-store.js";
import { upsertContactChannel } from "../contacts/contacts-write.js";
import { getSqlite } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  createInvite,
  revokeInvite as revokeStoreFn,
} from "../memory/invite-store.js";
import {
  type InviteRedemptionOutcome,
  redeemInvite,
  redeemInviteByCode,
  resolveMemberGateStatus,
} from "../runtime/invite-redemption-service.js";
import { hashVoiceCode } from "../util/voice-code.js";

await initializeDb();

function resetTables() {
  getSqlite().run("DELETE FROM assistant_ingress_invites");
  getSqlite().run("DELETE FROM contact_channels");
  getSqlite().run("DELETE FROM contacts");
}

/** Create a throwaway contact and return its ID, for use as the invite's contactId. */
function createTargetContact(displayName = "Target Contact"): string {
  return upsertContact({ displayName, role: "contact" }).id;
}

describe("invite-redemption-service", () => {
  beforeEach(() => {
    resetTables();
    resetGatewayIpc();
    contactsWriteState.mirrorThrows = false;
  });

  test("redeems a valid invite and returns typed outcome", async () => {
    const targetContactId = createTargetContact();
    const { rawToken, invite } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome).toEqual({
      ok: true,
      type: "redeemed",
      memberId: expect.any(String),
      inviteId: invite.id,
    });

    // The activation is written to the gateway via upsert_verified_channel.
    expect(
      gatewayIpc.calls.some((c) => c.method === "upsert_verified_channel"),
    ).toBe(true);
  });

  test("marks channel as verified via invite on redemption", async () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(outcome.ok).toBe(true);

    const result = findContactChannel({
      channelType: "telegram",
      address: "user-1",
    });

    expect(result).not.toBeNull();
    expect(result!.channel.verifiedAt).toBeGreaterThan(0);
    expect(result!.channel.verifiedVia).toBe("invite");
    expect(result!.channel.status).toBe("active");
  });

  test("marks channel as verified via invite on 6-digit code redemption", async () => {
    const targetContactId = createTargetContact();
    const inviteCode = "123456";
    createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
      inviteCodeHash: hashVoiceCode(inviteCode),
    });

    const outcome = await redeemInviteByCode({
      code: inviteCode,
      sourceChannel: "telegram",
      externalUserId: "code-user-1",
    });

    expect(outcome.ok).toBe(true);

    const result = findContactChannel({
      channelType: "telegram",
      address: "code-user-1",
    });

    expect(result).not.toBeNull();
    expect(result!.channel.verifiedAt).toBeGreaterThan(0);
    expect(result!.channel.verifiedVia).toBe("invite");
    expect(result!.channel.status).toBe("active");
  });

  test("returns invalid_token for a bogus token", async () => {
    const outcome = await redeemInvite({
      rawToken: "totally-bogus-token",
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });
  });

  test("returns expired for an expired invite", async () => {
    const targetContactId = createTargetContact();
    // Create an invite that expired 1 ms ago
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
      expiresInMs: -1,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(outcome).toEqual({ ok: false, reason: "expired" });
  });

  test("returns revoked for a revoked invite", async () => {
    const targetContactId = createTargetContact();
    const { rawToken, invite } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });
    revokeStoreFn(invite.id);

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(outcome).toEqual({ ok: false, reason: "revoked" });
  });

  test("returns max_uses_reached when invite is fully consumed", async () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    // First redemption should succeed
    const first = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });
    expect(first.ok).toBe(true);

    // Second attempt should fail — the invite is now fully redeemed
    const second = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "user-2",
    });

    expect(second).toEqual({ ok: false, reason: "max_uses_reached" });
  });

  test("returns channel_mismatch when redeeming on wrong channel", async () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "phone",
      externalUserId: "user-1",
    });

    expect(outcome).toEqual({ ok: false, reason: "channel_mismatch" });
  });

  test("returns missing_identity when no externalUserId or externalChatId", async () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
    });

    expect(outcome).toEqual({ ok: false, reason: "missing_identity" });
  });

  test("returns already_member when user is already an active member", async () => {
    // Pre-create an active member and find their contact
    const member = upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "existing-user",
      status: "active",
    });

    // Create an invite targeting the same contact that owns the channel
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: member!.contact.id,
      maxUses: 5,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "existing-user",
    });

    expect(outcome.ok).toBe(true);
    expect(
      (outcome as Extract<InviteRedemptionOutcome, { type: "already_member" }>)
        .type,
    ).toBe("already_member");
    expect(
      (outcome as Extract<InviteRedemptionOutcome, { type: "already_member" }>)
        .memberId,
    ).toEqual(expect.any(String));
  });

  test("returns invalid_token for a blocked member to avoid leaking membership status", async () => {
    // Pre-create a blocked member and find their contact
    const member = upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "blocked-user",
      status: "blocked",
    });

    // Create an invite targeting the same contact that owns the channel
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: member!.contact.id,
      maxUses: 5,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "blocked-user",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });
  });

  test("matches an active member by (type,address) when the gateway row has a divergent uuid", async () => {
    const member = upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "divergent-user",
      status: "active",
    });

    // The gateway row for the same (type,address) carries a DIFFERENT id, as a
    // reconcile divergence would produce. Matching by id alone would miss it.
    gatewayIpc.richOverride = () => ({
      ok: true,
      contact: {
        id: member!.contact.id,
        displayName: member!.contact.displayName,
        role: member!.contact.role,
        interactionCount: 0,
        createdAt: 1,
        updatedAt: 1,
        channels: [
          {
            id: "gateway-divergent-uuid",
            contactId: member!.contact.id,
            type: "telegram",
            address: "divergent-user",
            isPrimary: false,
            externalUserId: null,
            status: "active",
            policy: "allow",
            verifiedAt: 1,
            verifiedVia: "invite",
            lastSeenAt: null,
            interactionCount: 0,
            lastInteraction: null,
            revokedReason: null,
            blockedReason: null,
          },
        ],
      },
    });

    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: member!.contact.id,
      maxUses: 5,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "divergent-user",
    });

    expect(outcome.ok).toBe(true);
    expect((outcome as { type: string }).type).toBe("already_member");
  });

  test("blocks via the (type,address) match when the gateway row has a divergent uuid", async () => {
    const member = upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "divergent-blocked",
      status: "blocked",
    });

    gatewayIpc.richOverride = () => ({
      ok: true,
      contact: {
        id: member!.contact.id,
        displayName: member!.contact.displayName,
        role: member!.contact.role,
        interactionCount: 0,
        createdAt: 1,
        updatedAt: 1,
        channels: [
          {
            id: "gateway-divergent-blocked-uuid",
            contactId: member!.contact.id,
            type: "telegram",
            // Case-divergent address must still match (COLLATE NOCASE).
            address: "DIVERGENT-BLOCKED",
            isPrimary: false,
            externalUserId: null,
            status: "blocked",
            policy: "deny",
            verifiedAt: null,
            verifiedVia: null,
            lastSeenAt: null,
            interactionCount: 0,
            lastInteraction: null,
            revokedReason: null,
            blockedReason: "guardian blocked",
          },
        ],
      },
    });

    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: member!.contact.id,
      maxUses: 5,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "divergent-blocked",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });
  });

  test("fails open (no throw) when the gateway gate-status read is unreachable", async () => {
    // No verdict member and an unreachable gateway read must degrade to the
    // fail-open path: redemption still resolves rather than throwing.
    const member = upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "readfail-user",
      status: "revoked",
    });

    gatewayIpc.richThrows = true;

    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: member!.contact.id,
      maxUses: 1,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "readfail-user",
    });

    expect(outcome.ok).toBe(true);
  });

  test("binds redeemer to the invite's target contact, not the guardian", async () => {
    // Pre-create a guardian contact with a revoked telegram channel
    const guardianContact = upsertContact({
      displayName: "Guardian",
      role: "guardian",
      channels: [
        {
          type: "telegram",
          address: "guardian-tg-id",
          status: "revoked",
        },
      ],
    });

    // Create a separate target contact "Mom"
    const momContact = upsertContact({
      displayName: "Mom",
      role: "contact",
    });

    // Create an invite targeting Mom's contact
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: momContact.id,
      maxUses: 5,
    });

    // Redeem using the guardian's Telegram identity
    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "guardian-tg-id",
    });

    // Should succeed — redeemer's channel is bound to Mom
    expect(outcome.ok).toBe(true);
    expect((outcome as { type: string }).type).toBe("redeemed");

    // Gateway-first: the activation relays the target contactId so the gateway
    // binds the channel to Mom (not the guardian) — the binding is not lost.
    const upsert = gatewayIpc.calls.find(
      (c) => c.method === "upsert_verified_channel",
    );
    expect(upsert).toBeDefined();
    expect(upsert!.params).toMatchObject({
      type: "telegram",
      address: "guardian-tg-id",
      contactId: momContact.id,
    });

    // Verify the redeemer's Telegram ID is now bound to Mom's contact
    const result = findContactChannel({
      channelType: "telegram",
      address: "guardian-tg-id",
    });
    expect(result).not.toBeNull();
    expect(result!.contact.id).toBe(momContact.id);
    expect(result!.channel.status).toBe("active");

    // Verify the original guardian contact was NOT modified
    const guardian = getContact(guardianContact.id);
    expect(guardian).not.toBeNull();
    expect(guardian!.role).toBe("guardian");
  });

  test("downgrades guardian to contact when redeeming invite targeting own contact", async () => {
    // Create a guardian contact with a revoked channel
    const guardianContact = upsertContact({
      displayName: "Guardian",
      role: "guardian",
      channels: [
        {
          type: "telegram",
          address: "guardian-own-id",
          status: "revoked",
        },
      ],
    });

    // Create invite targeting the guardian's own contact
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: guardianContact.id,
      maxUses: 5,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "guardian-own-id",
    });

    expect(outcome.ok).toBe(true);

    // The guardian should now be downgraded to "contact"
    const updated = getContact(guardianContact.id);
    expect(updated!.role).toBe("contact");
  });

  test("binds redeemer to the invite's target contact via 6-digit code, not the guardian", async () => {
    // Pre-create a guardian contact with a revoked telegram channel
    const guardianContact = upsertContact({
      displayName: "Guardian",
      role: "guardian",
      channels: [
        {
          type: "telegram",
          address: "guardian-code-id",
          status: "revoked",
        },
      ],
    });

    // Create a separate target contact "Mom"
    const momContact = upsertContact({
      displayName: "Mom",
      role: "contact",
    });

    // Create an invite targeting Mom's contact with a 6-digit code
    const code = "123456";
    const inviteCodeHash = hashVoiceCode(code);
    createInvite({
      sourceChannel: "telegram",
      contactId: momContact.id,
      maxUses: 5,
      inviteCodeHash,
    });

    // Redeem using the guardian's Telegram identity
    const outcome = await redeemInviteByCode({
      code,
      sourceChannel: "telegram",
      externalUserId: "guardian-code-id",
    });

    // Should succeed — redeemer's channel is bound to Mom
    expect(outcome.ok).toBe(true);
    expect((outcome as { type: string }).type).toBe("redeemed");

    // Verify the redeemer's Telegram ID is now bound to Mom's contact
    const result = findContactChannel({
      channelType: "telegram",
      address: "guardian-code-id",
    });
    expect(result).not.toBeNull();
    expect(result!.contact.id).toBe(momContact.id);
    expect(result!.channel.status).toBe("active");

    // Verify the original guardian contact was NOT modified
    const guardian = getContact(guardianContact.id);
    expect(guardian).not.toBeNull();
    expect(guardian!.role).toBe("guardian");
  });

  test("does not return already_member for a revoked member", async () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 5,
    });

    // Pre-create a revoked member
    const member = upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "revoked-user",
      status: "revoked",
    });
    expect(member!.channel.status).toBe("revoked");

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "revoked-user",
    });

    // Should redeem, not return already_member
    expect(outcome.ok).toBe(true);
    expect(
      (outcome as Extract<InviteRedemptionOutcome, { type: "redeemed" }>).type,
    ).toBe("redeemed");
  });

  test("raw token is not present in the outcome object", async () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    // Verify the raw token does not appear anywhere in the serialized outcome
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(rawToken);
  });

  test("channel enforcement blocks cross-channel redemption (voice invite via slack)", async () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "phone",
      contactId: targetContactId,
      maxUses: 1,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "slack",
      externalUserId: "user-1",
    });

    expect(outcome).toEqual({ ok: false, reason: "channel_mismatch" });
  });

  test("returns invalid_token for an active member with a bogus token (no membership probing)", async () => {
    // Pre-create an active member
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "probed-user",
      status: "active",
    });

    // Attempt to redeem with a bogus token — must NOT leak membership status
    const outcome = await redeemInvite({
      rawToken: "completely-bogus-token",
      sourceChannel: "telegram",
      externalUserId: "probed-user",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });
  });

  test("returns expired for an active member with an expired invite token", async () => {
    const targetContactId = createTargetContact();
    // Create an expired invite
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 5,
      expiresInMs: -1,
    });

    // Pre-create an active member
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "expired-token-user",
      status: "active",
    });

    // Expired token must return expired, not already_member
    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "expired-token-user",
    });

    expect(outcome).toEqual({ ok: false, reason: "expired" });
  });

  test("returns channel_mismatch for an active member with a valid token for a different channel", async () => {
    const targetContactId = createTargetContact();
    // Create an invite for voice
    const { rawToken } = createInvite({
      sourceChannel: "phone",
      contactId: targetContactId,
      maxUses: 5,
    });

    // Pre-create an active member on telegram
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "cross-channel-user",
      status: "active",
    });

    // Valid token for wrong channel must return channel_mismatch, not already_member
    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "cross-channel-user",
    });

    expect(outcome).toEqual({ ok: false, reason: "channel_mismatch" });
  });

  // ── Gateway lifecycle pre-check + redemption mirror ────────────────────

  test("rejects redemption when the gateway claim is not consumable (no assistant mutation)", async () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    // Gateway row exists but was NOT consumable (revoked/exhausted/raced).
    gatewayIpc.claim = { ok: true, updated: false, mirrored: true };

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "gw-revoked-user",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });

    // No member was created — the assistant DB was never mutated.
    expect(
      findContactChannel({
        channelType: "telegram",
        address: "gw-revoked-user",
      }),
    ).toBeNull();
  });

  test("does not activate the member when recordInviteUse loses the race (returns false)", async () => {
    const targetContactId = createTargetContact();
    const { rawToken, invite } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    // Legacy gateway row so the claim proceeds past the gateway gate. Revoke
    // the assistant invite during the claim — after pre-validation, before the
    // use-bump — so `recordInviteUse` sees a non-active row and returns false.
    gatewayIpc.claim = { ok: true, updated: false, mirrored: false };
    onGatewayClaim = () => {
      revokeStoreFn(invite.id);
    };

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "raced-user",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });

    // The member was NOT activated: no gateway upsert and no active channel.
    expect(
      gatewayIpc.calls.some((c) => c.method === "upsert_verified_channel"),
    ).toBe(false);
    expect(
      findContactChannel({ channelType: "telegram", address: "raced-user" }),
    ).toBeNull();
  });

  test("proceeds and mutates when the gateway claim is consumed (updated:true)", async () => {
    const targetContactId = createTargetContact();
    const { rawToken, invite } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    gatewayIpc.claim = { ok: true, updated: true, mirrored: true };

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "gw-active-user",
    });

    expect(outcome.ok).toBe(true);

    // The claim was performed against the resolved invite id.
    const claim = gatewayIpc.calls.find(
      (c) => c.method === "record_invite_redemption",
    );
    expect(claim).toBeDefined();
    expect(claim!.params).toMatchObject({ inviteId: invite.id });

    // The assistant DB was mutated.
    expect(
      findContactChannel({ channelType: "telegram", address: "gw-active-user" }),
    ).not.toBeNull();
  });

  test("proceeds for a legacy invite the gateway has never seen (mirrored:false)", async () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    gatewayIpc.claim = { ok: true, updated: false, mirrored: false };

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "legacy-user",
    });

    expect(outcome.ok).toBe(true);
    expect(
      findContactChannel({ channelType: "telegram", address: "legacy-user" }),
    ).not.toBeNull();
  });

  test("fails open when the gateway claim throws (assistant-side checks still apply)", async () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    gatewayIpc.claimThrows = true;

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "failopen-user",
    });

    expect(outcome.ok).toBe(true);
    expect(
      findContactChannel({ channelType: "telegram", address: "failopen-user" }),
    ).not.toBeNull();
  });

  test("does not claim the gateway row for an already-active member", async () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    // Seed an already-active member bound to the invite's target contact.
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "already-member-user",
      role: "contact",
      status: "active",
      policy: "allow",
      contactId: targetContactId,
    });

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "already-member-user",
    });

    expect(outcome.ok).toBe(true);
    expect((outcome as { type: string }).type).toBe("already_member");

    // No gateway claim was made — no use must be consumed for a non-redemption.
    expect(
      gatewayIpc.calls.some((c) => c.method === "record_invite_redemption"),
    ).toBe(false);
  });

  test("rejects 6-digit code redemption when the gateway claim is not consumable", async () => {
    const targetContactId = createTargetContact();
    const code = "654321";
    createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
      inviteCodeHash: hashVoiceCode(code),
    });

    gatewayIpc.claim = { ok: true, updated: false, mirrored: true };

    const outcome = await redeemInviteByCode({
      code,
      sourceChannel: "telegram",
      externalUserId: "gw-revoked-code-user",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });
    expect(
      findContactChannel({
        channelType: "telegram",
        address: "gw-revoked-code-user",
      }),
    ).toBeNull();
  });

  test("returns invalid_token (no throw) when the gateway refuses the activation", async () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    // Gateway claim consumes the row, then refuses the channel activation
    // (blocked/revoked actor). The committed use is acceptable for this rare
    // blocked-backstop path; the outcome must be the branch failure, not a 500.
    gatewayIpc.activationVerified = false;

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "refused-user",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });
  });

  test("redeems with the gateway channel id when the gateway verifies but the local mirror fails", async () => {
    const targetContactId = createTargetContact();
    const { rawToken, invite } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    // Gateway verifies and returns its channel; the best-effort local mirror
    // throws. The activation must still stand using the gateway channel id.
    gatewayIpc.activationChannelId = "gw-verified-channel";
    contactsWriteState.mirrorThrows = true;

    const outcome = await redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "mirrorless-user",
    });

    expect(outcome).toEqual({
      ok: true,
      type: "redeemed",
      memberId: "gw-verified-channel",
      inviteId: invite.id,
    });
  });
});

describe("resolveMemberGateStatus", () => {
  const memberlessVerdict: TrustVerdict = {
    trustClass: "unverified_contact",
    canonicalSenderId: "telegram:blocked-user",
  };
  const memberVerdict: TrustVerdict = {
    trustClass: "trusted_contact",
    canonicalSenderId: "telegram:active-user",
    contactId: "contact-1",
    channelId: "channel-1",
    type: "telegram",
    address: "active-user",
    status: "active",
    policy: "allow",
  };

  test("uses the verdict member status when the verdict resolves a member", async () => {
    expect(await resolveMemberGateStatus(memberVerdict, "blocked")).toBe(
      "active",
    );
  });

  test("falls back to local status when a non-null verdict carries no member", async () => {
    // A previously blocked contact with a valid invite must stay blocked even
    // when the verdict is non-null but memberless (externalChatId-only match /
    // resolutionFailed), so it can't bypass the gate.
    expect(await resolveMemberGateStatus(memberlessVerdict, "blocked")).toBe(
      "blocked",
    );
  });

  test("falls back to local status when the verdict is null", async () => {
    expect(await resolveMemberGateStatus(null, "blocked")).toBe("blocked");
  });

  test("returns null when neither verdict member nor local status is present", async () => {
    expect(await resolveMemberGateStatus(memberlessVerdict, null)).toBeNull();
  });
});
