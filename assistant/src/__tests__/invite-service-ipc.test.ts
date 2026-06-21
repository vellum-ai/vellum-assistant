import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Prevent ensureTelegramBotUsernameResolved() from reading real credentials
// and calling the Telegram API.
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => undefined,
  setSecureKeyAsync: async () => {},
  deleteSecureKeyAsync: async () => {},
}));

import { upsertContact } from "../contacts/contact-store.js";
import { getSqlite } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  createInvite,
  findById,
  hashToken,
} from "../memory/invite-store.js";
import {
  handleMintInvite,
  handleRedeemTokenInvite,
  handleRedeemVoiceInvite,
} from "../runtime/routes/contact-routes.js";
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

describe("handleMintInvite (invites_mint)", () => {
  beforeEach(resetTables);

  test("returns rawToken + gateway projection and persists the assistant row", async () => {
    const contactId = createTargetContact();

    const result = (await handleMintInvite({
      body: { sourceChannel: "telegram", contactId, maxUses: 3 },
    })) as {
      ok: boolean;
      invite: { id: string; token?: string };
      rawToken?: string;
      gateway: {
        id: string;
        inviteCodeHash: string | null;
        sourceChannel: string;
        contactId: string;
        note: string | null;
        maxUses: number;
        expiresAt: number;
      };
    };

    expect(result.ok).toBe(true);
    expect(result.rawToken).toBeDefined();
    expect(typeof result.rawToken).toBe("string");

    // Gateway projection carries exactly the mirrored fields.
    expect(result.gateway).toEqual({
      id: result.invite.id,
      inviteCodeHash: expect.any(String),
      sourceChannel: "telegram",
      contactId,
      note: null,
      maxUses: 3,
      expiresAt: expect.any(Number),
    });

    // The assistant row is persisted and only the token hash is stored.
    const row = findById(result.invite.id);
    expect(row).not.toBeNull();
    expect(row!.contactId).toBe(contactId);
    expect(row!.tokenHash).toBe(hashToken(result.rawToken!));
    expect(row!.inviteCodeHash).toBe(result.gateway.inviteCodeHash);
  });

  test("voice mint does not expose a raw token but persists voice fields", async () => {
    const contactId = createTargetContact();

    const result = (await handleMintInvite({
      body: {
        sourceChannel: "phone",
        contactId,
        expectedExternalUserId: "+15551234567",
        friendName: "Alex",
        guardianName: "Sam",
      },
    })) as {
      ok: boolean;
      invite: { id: string; voiceCode?: string };
      rawToken?: string;
      gateway: { sourceChannel: string; inviteCodeHash: string | null };
    };

    expect(result.ok).toBe(true);
    // Voice invites never expose the generic redemption token.
    expect(result.rawToken).toBeUndefined();
    expect(result.gateway.sourceChannel).toBe("phone");

    const row = findById(result.invite.id);
    expect(row).not.toBeNull();
    expect(row!.expectedExternalUserId).toBe("+15551234567");
    expect(row!.voiceCodeHash).toBeTruthy();
    // Voice invites use voiceCodeHash, not the non-voice inviteCodeHash.
    expect(row!.inviteCodeHash).toBeNull();
  });

  test("returns a 400 when required params are missing", async () => {
    await expect(
      handleMintInvite({ body: { contactId: createTargetContact() } }),
    ).rejects.toThrow();
  });
});

describe("handleRedeemTokenInvite (invites_redeem_token)", () => {
  beforeEach(resetTables);

  test("redeems a valid token and returns the invite shape", () => {
    const contactId = createTargetContact();
    const { rawToken, invite } = createInvite({
      sourceChannel: "telegram",
      contactId,
      maxUses: 1,
    });

    const result = handleRedeemTokenInvite({
      body: {
        token: rawToken,
        sourceChannel: "telegram",
        externalUserId: "user-1",
      },
    }) as { ok: boolean; invite: { id: string } };

    expect(result.ok).toBe(true);
    expect(result.invite.id).toBe(invite.id);
  });

  test("rejects a bogus token with a 400", () => {
    expect(() =>
      handleRedeemTokenInvite({
        body: {
          token: "totally-bogus-token",
          sourceChannel: "telegram",
          externalUserId: "user-1",
        },
      }),
    ).toThrow();
  });

  test("rejects redemption on the wrong channel", () => {
    const contactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId,
      maxUses: 1,
    });

    expect(() =>
      handleRedeemTokenInvite({
        body: {
          token: rawToken,
          sourceChannel: "phone",
          externalUserId: "user-1",
        },
      }),
    ).toThrow();
  });
});

describe("handleRedeemVoiceInvite (invites_redeem_voice)", () => {
  beforeEach(resetTables);

  /** Create a voice invite with a known code; return the invite + plaintext code. */
  function createVoiceInvite(callerPhone = "+15551234567") {
    const code = generateVoiceCode(6);
    const { invite } = createInvite({
      sourceChannel: "phone",
      contactId: createTargetContact(),
      maxUses: 1,
      expectedExternalUserId: callerPhone,
      voiceCodeHash: hashVoiceCode(code),
      voiceCodeDigits: 6,
    });
    return { invite, code };
  }

  test("redeems a valid voice code and returns the documented shape", () => {
    const phone = "+15551234567";
    const { invite, code } = createVoiceInvite(phone);

    const result = handleRedeemVoiceInvite({
      body: { callerExternalUserId: phone, code },
    }) as {
      ok: boolean;
      type: string;
      memberId: string;
      inviteId?: string;
    };

    expect(result).toEqual({
      ok: true,
      type: "redeemed",
      memberId: expect.any(String),
      inviteId: invite.id,
    });
  });

  test("wrong caller identity is rejected with a 400", () => {
    const { code } = createVoiceInvite("+15551234567");

    expect(() =>
      handleRedeemVoiceInvite({
        body: { callerExternalUserId: "+19999999999", code },
      }),
    ).toThrow();
  });

  test("missing callerExternalUserId or code is rejected with a 400", () => {
    expect(() =>
      handleRedeemVoiceInvite({ body: { code: "123456" } }),
    ).toThrow();
    expect(() =>
      handleRedeemVoiceInvite({
        body: { callerExternalUserId: "+15551234567" },
      }),
    ).toThrow();
  });
});
