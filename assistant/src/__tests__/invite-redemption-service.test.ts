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
  getSocketPath: () => join(testDir, "test.sock"),
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

import { findContactChannel } from "../contacts/contact-store.js";
import { upsertContactChannel } from "../contacts/contacts-write.js";
import { getSqlite, initializeDb, resetDb } from "../memory/db.js";
import {
  createInvite,
  revokeInvite as revokeStoreFn,
} from "../memory/invite-store.js";
import {
  type InviteRedemptionOutcome,
  redeemInvite,
} from "../runtime/invite-redemption-service.js";

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

describe("invite-redemption-service", () => {
  beforeEach(resetTables);

  test("redeems a valid invite and returns typed outcome", () => {
    const { rawToken, invite } = createInvite({
      sourceChannel: "telegram",
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
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
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

  test("returns invalid_token for a bogus token", () => {
    const outcome = redeemInvite({
      rawToken: "totally-bogus-token",
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });
  });

  test("returns expired for an expired invite", () => {
    // Create an invite that expired 1 ms ago
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
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
    const { rawToken, invite } = createInvite({
      sourceChannel: "telegram",
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
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
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
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      maxUses: 1,
    });

    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "sms",
      externalUserId: "user-1",
    });

    expect(outcome).toEqual({ ok: false, reason: "channel_mismatch" });
  });

  test("returns missing_identity when no externalUserId or externalChatId", () => {
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      maxUses: 1,
    });

    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
    });

    expect(outcome).toEqual({ ok: false, reason: "missing_identity" });
  });

  test("returns already_member when user is already an active member", () => {
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      maxUses: 5,
    });

    // Pre-create an active member
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "existing-user",
      status: "active",
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
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      maxUses: 5,
    });

    // Pre-create a blocked member — simulates a guardian-initiated block
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "blocked-user",
      status: "blocked",
    });

    const outcome = redeemInvite({
      rawToken,
      sourceChannel: "telegram",
      externalUserId: "blocked-user",
    });

    expect(outcome).toEqual({ ok: false, reason: "invalid_token" });
  });

  test("does not return already_member for a revoked member", () => {
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
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
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
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
    const { rawToken } = createInvite({ sourceChannel: "voice", maxUses: 1 });

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
    // Create an expired invite
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
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
    // Create an invite for SMS
    const { rawToken } = createInvite({
      sourceChannel: "sms",
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
