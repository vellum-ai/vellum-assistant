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
import { handleMintInvite } from "../ipc/routes/invite-ipc-routes.js";
import { getSqlite } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  createInvite,
  findById,
  hashToken,
} from "../memory/invite-store.js";
import {
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
        inviteCodeHash: string;
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
        expectedExternalUserId: "+12025550100",
        friendName: "Alex",
        guardianName: "Sam",
      },
    })) as {
      ok: boolean;
      invite: { id: string; voiceCode?: string };
      rawToken?: string;
      gateway: { sourceChannel: string; inviteCodeHash: string };
    };

    expect(result.ok).toBe(true);
    // Voice invites never expose the generic redemption token.
    expect(result.rawToken).toBeUndefined();
    expect(result.gateway.sourceChannel).toBe("phone");

    const row = findById(result.invite.id);
    expect(row).not.toBeNull();
    expect(row!.expectedExternalUserId).toBe("+12025550100");
    expect(row!.voiceCodeHash).toBeTruthy();
    // Voice invites have no non-voice inviteCodeHash; the gateway projection
    // mirrors the voice code hash instead so the NOT NULL mirror constraint holds.
    expect(row!.inviteCodeHash).toBeNull();
    expect(row!.voiceCodeHash).toBe(result.gateway.inviteCodeHash);
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
    }) as { ok: boolean; invite: { id: string }; type: string };

    expect(result.ok).toBe(true);
    expect(result.invite.id).toBe(invite.id);
    expect(result.type).toBe("redeemed");
  });

  test("surfaces type 'already_member' when an existing contact reopens the link", () => {
    const contactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId,
      maxUses: 2,
    });

    // First redeem makes the caller an active contact.
    handleRedeemTokenInvite({
      body: {
        token: rawToken,
        sourceChannel: "telegram",
        externalUserId: "user-1",
      },
    });

    // Second redeem by the SAME caller is a no-op membership-wise: it must
    // surface type "already_member" so the gateway skips consuming a use.
    const again = handleRedeemTokenInvite({
      body: {
        token: rawToken,
        sourceChannel: "telegram",
        externalUserId: "user-1",
      },
    }) as { ok: boolean; type: string };

    expect(again.ok).toBe(true);
    expect(again.type).toBe("already_member");
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
  function createVoiceInvite(callerPhone = "+12025550100") {
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
    const phone = "+12025550100";
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
    const { code } = createVoiceInvite("+12025550100");

    expect(() =>
      handleRedeemVoiceInvite({
        body: { callerExternalUserId: "+12025550101", code },
      }),
    ).toThrow();
  });

  test("missing callerExternalUserId or code is rejected with a 400", () => {
    expect(() =>
      handleRedeemVoiceInvite({ body: { code: "123456" } }),
    ).toThrow();
    expect(() =>
      handleRedeemVoiceInvite({
        body: { callerExternalUserId: "+12025550100" },
      }),
    ).toThrow();
  });
});
