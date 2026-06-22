import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const gatewayIpc = {
  claim: { ok: true, updated: true, mirrored: true } as {
    ok: boolean;
    updated: boolean;
    mirrored: boolean;
  },
  claimThrows: false,
  calls: [] as { method: string; params?: Record<string, unknown> }[],
};

mock.module("../ipc/gateway-client.js", () => ({
  ipcCallPersistent: async (
    method: string,
    params?: Record<string, unknown>,
  ) => {
    gatewayIpc.calls.push({ method, params });
    if (method === "record_invite_redemption") {
      if (gatewayIpc.claimThrows) throw new Error("gateway unreachable");
      return gatewayIpc.claim;
    }
    return undefined;
  },
}));

function resetGatewayIpc() {
  gatewayIpc.claim = { ok: true, updated: true, mirrored: true };
  gatewayIpc.claimThrows = false;
  gatewayIpc.calls = [];
}

import {
  findContactChannel,
  getContact,
  upsertContact,
} from "../contacts/contact-store.js";
import { upsertContactChannel } from "../contacts/contacts-write.js";
import { getSqlite } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createInvite, revokeInvite } from "../memory/invite-store.js";
import { redeemVoiceInviteCode } from "../runtime/invite-redemption-service.js";
import { generateVoiceCode, hashVoiceCode } from "../util/voice-code.js";

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

// ---------------------------------------------------------------------------
// generateVoiceCode
// ---------------------------------------------------------------------------

describe("generateVoiceCode", () => {
  test("generates a code with the default 6 digits", async () => {
    const code = generateVoiceCode();
    expect(code.length).toBe(6);
    expect(/^\d{6}$/.test(code)).toBe(true);
  });

  test("generates a code with the requested digit count", async () => {
    for (const digits of [4, 5, 6, 7, 8, 9, 10]) {
      const code = generateVoiceCode(digits);
      expect(code.length).toBe(digits);
      expect(new RegExp(`^\\d{${digits}}$`).test(code)).toBe(true);
    }
  });

  test("throws for digit count below 4", async () => {
    expect(() => generateVoiceCode(3)).toThrow(/between 4 and 10/);
  });

  test("throws for digit count above 10", async () => {
    expect(() => generateVoiceCode(11)).toThrow(/between 4 and 10/);
  });

  test("produces different codes across multiple calls (randomness)", async () => {
    // Generate many codes and check that we don't get the same one every time.
    // With 6 digits there are 900,000 possibilities, so getting 10 identical
    // codes would be astronomically unlikely.
    const codes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      codes.add(generateVoiceCode());
    }
    // At least 2 distinct values in 10 tries
    expect(codes.size).toBeGreaterThanOrEqual(2);
  });

  test("generated code is within the valid numeric range", async () => {
    for (let i = 0; i < 20; i++) {
      const code = generateVoiceCode(6);
      const num = parseInt(code, 10);
      // 6 digits: range [100000, 999999]
      expect(num).toBeGreaterThanOrEqual(100000);
      expect(num).toBeLessThanOrEqual(999999);
    }
  });
});

// ---------------------------------------------------------------------------
// hashVoiceCode
// ---------------------------------------------------------------------------

describe("hashVoiceCode", () => {
  test("produces a deterministic hash", async () => {
    const code = "123456";
    const hash1 = hashVoiceCode(code);
    const hash2 = hashVoiceCode(code);
    expect(hash1).toBe(hash2);
  });

  test("produces a hex-encoded SHA-256 hash (64 chars)", async () => {
    const hash = hashVoiceCode("654321");
    expect(hash.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  test("different codes produce different hashes", async () => {
    const hash1 = hashVoiceCode("111111");
    const hash2 = hashVoiceCode("222222");
    expect(hash1).not.toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// redeemVoiceInviteCode
// ---------------------------------------------------------------------------

describe("redeemVoiceInviteCode", () => {
  beforeEach(() => {
    resetTables();
    resetGatewayIpc();
  });

  /**
   * Helper: create a voice invite with a known code and return the
   * invite record plus the plaintext code.
   */
  function createVoiceInvite(
    opts: {
      callerPhone?: string;
      maxUses?: number;
      expiresInMs?: number;
      voiceCodeDigits?: number;
      assistantId?: string;
      contactId?: string;
    } = {},
  ) {
    const digits = opts.voiceCodeDigits ?? 6;
    const code = generateVoiceCode(digits);
    const codeHash = hashVoiceCode(code);

    const contactId = opts.contactId ?? createTargetContact();

    const { invite } = createInvite({
      sourceChannel: "phone",
      contactId,
      maxUses: opts.maxUses ?? 1,
      expiresInMs: opts.expiresInMs,
      expectedExternalUserId: opts.callerPhone ?? "+15551234567",
      voiceCodeHash: codeHash,
      voiceCodeDigits: digits,
    });

    return { invite, code };
  }

  test("happy path: correct caller + correct code redeems successfully", async () => {
    const phone = "+15551234567";
    const { code } = createVoiceInvite({ callerPhone: phone });

    const result = await redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "phone",
      code,
    });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      type: "redeemed",
      memberId: expect.any(String),
      inviteId: expect.any(String),
    });

    // The redemption claimed the gateway-canonical row before mutating.
    const claim = gatewayIpc.calls.find(
      (c) => c.method === "record_invite_redemption",
    );
    expect(claim).toBeDefined();
    expect(claim!.params).toMatchObject({ redeemedByExternalUserId: phone });
  });

  test("rejects voice redemption when the gateway claim is not consumable (no mutation)", async () => {
    const phone = "+15551234567";
    const { code } = createVoiceInvite({ callerPhone: phone });

    // Gateway row exists but was NOT consumable (revoked/exhausted/raced).
    gatewayIpc.claim = { ok: true, updated: false, mirrored: true };

    const result = await redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "phone",
      code,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
    expect(findContactChannel({ channelType: "phone", address: phone })).toBeNull();
  });

  test("proceeds for a legacy voice invite the gateway has never seen (mirrored:false)", async () => {
    const phone = "+15551234567";
    const { code } = createVoiceInvite({ callerPhone: phone });

    gatewayIpc.claim = { ok: true, updated: false, mirrored: false };

    const result = await redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "phone",
      code,
    });

    expect(result.ok).toBe(true);
    expect(
      findContactChannel({ channelType: "phone", address: phone }),
    ).not.toBeNull();
  });

  test("fails open when the gateway claim throws on voice redemption", async () => {
    const phone = "+15551234567";
    const { code } = createVoiceInvite({ callerPhone: phone });

    gatewayIpc.claimThrows = true;

    const result = await redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "phone",
      code,
    });

    expect(result.ok).toBe(true);
    expect(
      findContactChannel({ channelType: "phone", address: phone }),
    ).not.toBeNull();
  });

  test("marks channel as verified via invite on voice redemption", async () => {
    const phone = "+15551234567";
    const { code } = createVoiceInvite({ callerPhone: phone });

    const result = await redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "phone",
      code,
    });

    expect(result.ok).toBe(true);

    const channelResult = findContactChannel({
      channelType: "phone",
      address: phone,
    });

    expect(channelResult).not.toBeNull();
    expect(channelResult!.channel.verifiedAt).toBeGreaterThan(0);
    expect(channelResult!.channel.verifiedVia).toBe("invite");
    expect(channelResult!.channel.status).toBe("active");
  });

  test("wrong caller identity fails with generic error", async () => {
    const { code } = createVoiceInvite({ callerPhone: "+15551234567" });

    const result = await redeemVoiceInviteCode({
      callerExternalUserId: "+19999999999",
      sourceChannel: "phone",
      code,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("wrong code fails with generic error", async () => {
    createVoiceInvite({ callerPhone: "+15551234567" });

    const result = await redeemVoiceInviteCode({
      callerExternalUserId: "+15551234567",
      sourceChannel: "phone",
      code: "000000",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("expired invite fails", async () => {
    const phone = "+15551234567";
    const { code } = createVoiceInvite({ callerPhone: phone, expiresInMs: -1 });

    const result = await redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "phone",
      code,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("max uses exhausted fails", async () => {
    const phone = "+15551234567";
    const { code } = createVoiceInvite({ callerPhone: phone, maxUses: 1 });

    // First redemption succeeds
    const first = await redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "phone",
      code,
    });
    expect(first.ok).toBe(true);

    // Second redemption fails — max uses exhausted
    const second = await redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "phone",
      code,
    });
    expect(second).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("revoked invite fails", async () => {
    const phone = "+15551234567";
    const { invite, code } = createVoiceInvite({ callerPhone: phone });

    revokeInvite(invite.id);

    const result = await redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "phone",
      code,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("voice-only invite cannot be redeemed if sourceChannel on invite is not voice", async () => {
    // Create a non-voice invite with voice code metadata to simulate a
    // hypothetical misconfiguration. The redemption service filters by
    // sourceChannel='phone', so non-phone invites are invisible.
    const targetContactId = createTargetContact();
    const code = generateVoiceCode(6);
    const codeHash = hashVoiceCode(code);

    createInvite({
      sourceChannel: "telegram",
      contactId: targetContactId,
      maxUses: 1,
      expectedExternalUserId: "+15551234567",
      voiceCodeHash: codeHash,
      voiceCodeDigits: 6,
    });

    const result = await redeemVoiceInviteCode({
      callerExternalUserId: "+15551234567",
      sourceChannel: "phone",
      code,
    });

    // findActiveVoiceInvites filters by sourceChannel='phone', so the
    // telegram invite won't be found.
    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("already-member caller gets already_member outcome", async () => {
    const phone = "+15551234567";

    // Pre-create an active member for this phone on voice channel
    const member = upsertContactChannel({
      sourceChannel: "phone",
      externalUserId: phone,
      status: "active",
      policy: "allow",
    });

    // Create a voice invite targeting the same contact that owns the channel
    const { code } = createVoiceInvite({
      callerPhone: phone,
      contactId: member!.contact.id,
    });

    const result = await redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "phone",
      code,
    });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      type: "already_member",
      memberId: expect.any(String),
    });

    // No gateway claim — already_member must not consume a use.
    expect(
      gatewayIpc.calls.some((c) => c.method === "record_invite_redemption"),
    ).toBe(false);
  });

  test("blocked member gets generic failure to avoid leaking membership status", async () => {
    const phone = "+15551234567";

    // Pre-create a blocked member and find their contact
    const member = upsertContactChannel({
      sourceChannel: "phone",
      externalUserId: phone,
      status: "blocked",
      policy: "deny",
    });

    // Create a voice invite targeting the same contact that owns the channel
    const { code } = createVoiceInvite({
      callerPhone: phone,
      contactId: member!.contact.id,
    });

    const result = await redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "phone",
      code,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("empty callerExternalUserId fails", async () => {
    const result = await redeemVoiceInviteCode({
      callerExternalUserId: "",
      sourceChannel: "phone",
      code: "123456",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  test("binds redeemer to the invite's target contact, not the guardian, on voice redemption", async () => {
    const phone = "+15559998888";

    // Pre-create a guardian contact with a revoked phone channel
    const guardianContact = upsertContact({
      displayName: "Guardian",
      role: "guardian",
      channels: [
        {
          type: "phone",
          address: phone,
          status: "revoked",
        },
      ],
    });

    // Create a separate target contact "Mom"
    const momContact = upsertContact({
      displayName: "Mom",
      role: "contact",
    });

    // Create a voice invite targeting Mom's contact
    const { code } = createVoiceInvite({
      callerPhone: phone,
      contactId: momContact.id,
    });

    const result = await redeemVoiceInviteCode({
      callerExternalUserId: phone,
      sourceChannel: "phone",
      code,
    });

    // Should succeed — redeemer's channel is bound to Mom
    expect(result.ok).toBe(true);
    expect((result as { type: string }).type).toBe("redeemed");

    // Verify the redeemer's phone is now bound to Mom's contact
    const contactResult = findContactChannel({
      channelType: "phone",
      address: phone,
    });
    expect(contactResult).not.toBeNull();
    expect(contactResult!.contact.id).toBe(momContact.id);
    expect(contactResult!.channel.status).toBe("active");

    // Verify the original guardian contact was NOT modified
    const guardian = getContact(guardianContact.id);
    expect(guardian).not.toBeNull();
    expect(guardian!.role).toBe("guardian");
  });
});
