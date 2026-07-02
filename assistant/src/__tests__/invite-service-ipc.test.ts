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

// The redemption service now claims the gateway-canonical row over IPC before
// mutating. Default the claim to consumed (updated:true) so these assistant-side
// handler tests exercise the happy redemption path.
mock.module("../ipc/gateway-client.js", () => ({
  ipcCallPersistent: async (
    method: string,
    params?: Record<string, unknown>,
  ) => {
    if (method === "contacts_get_rich") {
      return richContactForId(params?.contactId as string);
    }
    if (method === "record_invite_redemption") {
      return { ok: true, updated: true, mirrored: true };
    }
    if (method === "upsert_verified_channel") {
      // Gateway-as-SoT activation: return a verified channel so the gateway-first
      // relay lands its write before mirroring identity locally.
      return {
        ok: true,
        verified: true,
        channel: {
          id: "gw-channel-1",
          contactId: (params?.contactId as string) ?? "gw-contact-1",
          type: (params?.type as string) ?? "telegram",
          address: (params?.address as string) ?? "",
          status: "active",
          verifiedAt: Date.now(),
          verifiedVia: (params?.verifiedVia as string) ?? "invite",
        },
      };
    }
    return undefined;
  },
}));

// Serves contacts_get_rich (the gateway ACL read backing the gate-status
// fallback) from the seeded local contact identity. Channel ACL state is
// gateway-owned, so a contact with a mirrored channel reports "active" here —
// the local status column is drained and never consulted.
function richContactForId(contactId: string | undefined) {
  if (!contactId) return undefined;
  const contact = getContact(contactId);
  if (!contact) return undefined;
  // ACL columns are gateway-owned; the projection reports "active" and no longer
  // mirrors the drained local ACL fields off the typed contact/channel.
  return {
    ok: true,
    contact: {
      id: contact.id,
      displayName: contact.displayName,
      role: "contact",
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
        status: "active",
        policy: "allow",
        verifiedAt: null,
        verifiedVia: null,
        lastSeenAt: null,
        interactionCount: 0,
        lastInteraction: null,
        revokedReason: null,
        blockedReason: null,
      })),
    },
  };
}

import { getContact, upsertContact } from "../contacts/contact-store.js";
import { getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { createInvite } from "../persistence/invite-store.js";
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

describe("handleRedeemTokenInvite (invites_redeem_token)", () => {
  beforeEach(resetTables);

  test("redeems a valid token and returns the invite shape", async () => {
    const contactId = createTargetContact();
    const { rawToken, invite } = createInvite({
      sourceChannel: "telegram",
      contactId,
      maxUses: 1,
    });

    const result = (await handleRedeemTokenInvite({
      body: {
        token: rawToken,
        sourceChannel: "telegram",
        externalUserId: "user-1",
      },
    })) as { ok: boolean; invite: { id: string }; type: string };

    expect(result.ok).toBe(true);
    expect(result.invite.id).toBe(invite.id);
    expect(result.type).toBe("redeemed");
  });

  test("surfaces type 'already_member' when an existing contact reopens the link", async () => {
    const contactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId,
      maxUses: 2,
    });

    // First redeem makes the caller an active contact.
    await handleRedeemTokenInvite({
      body: {
        token: rawToken,
        sourceChannel: "telegram",
        externalUserId: "user-1",
      },
    });

    // Second redeem by the SAME caller is a no-op membership-wise: it must
    // surface type "already_member" so the gateway skips consuming a use.
    const again = (await handleRedeemTokenInvite({
      body: {
        token: rawToken,
        sourceChannel: "telegram",
        externalUserId: "user-1",
      },
    })) as { ok: boolean; type: string };

    expect(again.ok).toBe(true);
    expect(again.type).toBe("already_member");
  });

  test("rejects a bogus token with a 400", async () => {
    await expect(
      handleRedeemTokenInvite({
        body: {
          token: "totally-bogus-token",
          sourceChannel: "telegram",
          externalUserId: "user-1",
        },
      }),
    ).rejects.toThrow();
  });

  test("rejects redemption on the wrong channel", async () => {
    const contactId = createTargetContact();
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId,
      maxUses: 1,
    });

    await expect(
      handleRedeemTokenInvite({
        body: {
          token: rawToken,
          sourceChannel: "phone",
          externalUserId: "user-1",
        },
      }),
    ).rejects.toThrow();
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

  test("redeems a valid voice code and returns the documented shape", async () => {
    const phone = "+12025550100";
    const { invite, code } = createVoiceInvite(phone);

    const result = (await handleRedeemVoiceInvite({
      body: { callerExternalUserId: phone, code },
    })) as {
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

  test("wrong caller identity is rejected with a 400", async () => {
    const { code } = createVoiceInvite("+12025550100");

    await expect(
      handleRedeemVoiceInvite({
        body: { callerExternalUserId: "+12025550101", code },
      }),
    ).rejects.toThrow();
  });

  test("missing callerExternalUserId or code is rejected with a 400", async () => {
    await expect(
      handleRedeemVoiceInvite({ body: { code: "123456" } }),
    ).rejects.toThrow();
    await expect(
      handleRedeemVoiceInvite({
        body: { callerExternalUserId: "+12025550100" },
      }),
    ).rejects.toThrow();
  });
});
