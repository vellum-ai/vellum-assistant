import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "invite-redemption-service-test-"));

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

import {
  findContactChannel,
  getContact,
  upsertContact,
} from "../contacts/contact-store.js";
import { upsertContactChannel } from "../contacts/contacts-write.js";
import { getSqlite, initializeDb, resetDb } from "../memory/db.js";
import {
  createInvite,
  revokeInvite as revokeStoreFn,
} from "../memory/invite-store.js";
import {
  type InviteRedemptionOutcome,
  redeemInvite,
  redeemInviteByCode,
} from "../runtime/invite-redemption-service.js";
import { hashVoiceCode } from "../util/voice-code.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

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
  beforeEach(resetTables);

  test("redeems a valid invite and returns typed outcome", () => {
    const targetContactId = createTargetContact();
    const { rawToken, invite } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    const outcome = redeemInvite({
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
  });

  test("marks channel as verified via invite on redemption", () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(outcome.ok).toBe(true);

    const result = findContactChannel({
      channelType: "telegram",
      externalUserId: "user-1",
    });

    expect(result).not.toBeNull();
    expect(result!.channel.verifiedAt).toBeGreaterThan(0);
    expect(result!.channel.verifiedVia).toBe("invite");
    expect(result!.channel.status).toBe("active");
  });

  test("marks channel as verified via invite on 6-digit code redemption", () => {
    const targetContactId = createTargetContact();
    const inviteCode = "123456";
    createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
      inviteCodeHash: hashVoiceCode(inviteCode),
    });

    const outcome = redeemInviteByCode({
      code: inviteCode,
      sourceChannel: "telegram",
      externalUserId: "code-user-1",
    });

    expect(outcome.ok).toBe(true);

    const result = findContactChannel({
      channelType: "telegram",
      externalUserId: "code-user-1",
    });

    expect(result).not.toBeNull();
    expect(result!.channel.verifiedAt).toBeGreaterThan(0);
    expect(result!.channel.verifiedVia).toBe("invite");
    expect(result!.channel.status).toBe("active");
  });

  test("returns invalid_token for a bogus token", () => {
    const outcome = redeemInvite({
      rawToken: "totally-bogus-token",
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });
  });

  test("returns expired for an expired invite", () => {
    const targetContactId = createTargetContact();
    // Create an invite that expired 1 ms ago
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
      expiresInMs: -1,
    });

    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(outcome).toEqual({ ok: false, reason: "expired" });
  });

  test("returns revoked for a revoked invite", () => {
    const targetContactId = createTargetContact();
    const { rawToken, invite } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });
    revokeStoreFn(invite.id);

    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(outcome).toEqual({ ok: false, reason: "revoked" });
  });

  test("returns max_uses_reached when invite is fully consumed", () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    // First redemption should succeed
    const first = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });
    expect(first.ok).toBe(true);

    // Second attempt should fail — the invite is now fully redeemed
    const second = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "user-2",
    });

    expect(second).toEqual({ ok: false, reason: "max_uses_reached" });
  });

  test("returns channel_mismatch when redeeming on wrong channel", () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "phone",
      externalUserId: "user-1",
    });

    expect(outcome).toEqual({ ok: false, reason: "channel_mismatch" });
  });

  test("returns missing_identity when no externalUserId or externalChatId", () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
    });

    expect(outcome).toEqual({ ok: false, reason: "missing_identity" });
  });

  test("returns already_member when user is already an active member", () => {
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

    const outcome = redeemInvite({
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

  test("returns invalid_token for a blocked member to avoid leaking membership status", () => {
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

    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "blocked-user",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });
  });

  test("binds redeemer to the invite's target contact, not the guardian", () => {
    // Pre-create a guardian contact with a revoked telegram channel
    const guardianContact = upsertContact({
      displayName: "Guardian",
      role: "guardian",
      channels: [
        {
          type: "telegram",
          address: "guardian-tg-id",
          externalUserId: "guardian-tg-id",
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
    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "guardian-tg-id",
    });

    // Should succeed — redeemer's channel is bound to Mom
    expect(outcome.ok).toBe(true);
    expect((outcome as { type: string }).type).toBe("redeemed");

    // Verify the redeemer's Telegram ID is now bound to Mom's contact
    const result = findContactChannel({
      channelType: "telegram",
      externalUserId: "guardian-tg-id",
    });
    expect(result).not.toBeNull();
    expect(result!.contact.id).toBe(momContact.id);
    expect(result!.channel.status).toBe("active");

    // Verify the original guardian contact was NOT modified
    const guardian = getContact(guardianContact.id);
    expect(guardian).not.toBeNull();
    expect(guardian!.role).toBe("guardian");
  });

  test("downgrades guardian to contact when redeeming invite targeting own contact", () => {
    // Create a guardian contact with a revoked channel
    const guardianContact = upsertContact({
      displayName: "Guardian",
      role: "guardian",
      channels: [
        {
          type: "telegram",
          address: "guardian-own-id",
          externalUserId: "guardian-own-id",
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

    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "guardian-own-id",
    });

    expect(outcome.ok).toBe(true);

    // The guardian should now be downgraded to "contact"
    const updated = getContact(guardianContact.id);
    expect(updated!.role).toBe("contact");
  });

  test("binds redeemer to the invite's target contact via 6-digit code, not the guardian", () => {
    // Pre-create a guardian contact with a revoked telegram channel
    const guardianContact = upsertContact({
      displayName: "Guardian",
      role: "guardian",
      channels: [
        {
          type: "telegram",
          address: "guardian-code-id",
          externalUserId: "guardian-code-id",
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
    const outcome = redeemInviteByCode({
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
      externalUserId: "guardian-code-id",
    });
    expect(result).not.toBeNull();
    expect(result!.contact.id).toBe(momContact.id);
    expect(result!.channel.status).toBe("active");

    // Verify the original guardian contact was NOT modified
    const guardian = getContact(guardianContact.id);
    expect(guardian).not.toBeNull();
    expect(guardian!.role).toBe("guardian");
  });

  test("does not return already_member for a revoked member", () => {
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

    const outcome = redeemInvite({
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

  test("raw token is not present in the outcome object", () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
    });

    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    // Verify the raw token does not appear anywhere in the serialized outcome
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(rawToken);
  });

  test("channel enforcement blocks cross-channel redemption (voice invite via slack)", () => {
    const targetContactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "phone",
      contactId: targetContactId,
      maxUses: 1,
    });

    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "slack",
      externalUserId: "user-1",
    });

    expect(outcome).toEqual({ ok: false, reason: "channel_mismatch" });
  });

  test("returns invalid_token for an active member with a bogus token (no membership probing)", () => {
    // Pre-create an active member
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "probed-user",
      status: "active",
    });

    // Attempt to redeem with a bogus token — must NOT leak membership status
    const outcome = redeemInvite({
      rawToken: "completely-bogus-token",
      sourceChannel: "telegram",
      externalUserId: "probed-user",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });
  });

  test("returns expired for an active member with an expired invite token", () => {
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
    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "expired-token-user",
    });

    expect(outcome).toEqual({ ok: false, reason: "expired" });
  });

  test("returns channel_mismatch for an active member with a valid token for a different channel", () => {
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
    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "cross-channel-user",
    });

    expect(outcome).toEqual({ ok: false, reason: "channel_mismatch" });
  });
});
