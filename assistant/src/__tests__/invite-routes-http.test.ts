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

// Mock getTelegramBotUsername — the env var fallback was removed so we
// control the return value directly via a mutable variable.
let mockTelegramBotUsername: string | undefined;
mock.module("../telegram/bot-username.js", () => ({
  getTelegramBotId: () => undefined,
  getTelegramBotUsername: () => mockTelegramBotUsername,
}));

// Mock startInviteCall from call-domain — test env lacks Twilio credentials.
let mockStartInviteCallResult:
  | { ok: true; callSid: string }
  | { ok: false; error: string; status?: number } = {
  ok: true,
  callSid: "CA_test_sid_123",
};
mock.module("../calls/call-domain.js", () => ({
  startInviteCall: async () => mockStartInviteCallResult,
}));

// Model the gateway: the redemption claim (record_invite_redemption) and the
// gateway-owned activation (upsert_verified_channel) are both relayed. The
// activation write fails closed in production, so the mock must serve a
// verified upsert for the legitimate-success redemption paths.
const gatewayIpc = {
  claim: { ok: true, updated: true, mirrored: true },
  activationVerified: true,
};
mock.module("../ipc/gateway-client.js", () => ({
  ipcCallPersistent: async (
    method: string,
    params?: Record<string, unknown>,
  ) => {
    if (method === "record_invite_redemption") {
      return gatewayIpc.claim;
    }
    if (method === "upsert_verified_channel") {
      if (!gatewayIpc.activationVerified) {
        return { ok: true, verified: false };
      }
      return {
        ok: true,
        verified: true,
        channel: {
          id: "gw-channel-id",
          contactId: (params?.contactId as string) ?? "gw-contact",
          type: (params?.type as string) ?? "telegram",
          address: (params?.address as string) ?? "gw-addr",
          status: "active",
          verifiedAt: 1,
          verifiedVia: (params?.verifiedVia as string) ?? "invite",
        },
      };
    }
    return undefined;
  },
}));

import { upsertContact } from "../contacts/contact-store.js";
import { getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { createInvite, revokeInvite } from "../persistence/invite-store.js";
import {
  composeInvitePresentation,
  triggerInviteCall,
} from "../runtime/invite-service.js";
import { handleRedeemInvite as _handleRedeemInvite } from "../runtime/routes/contact-routes.js";
import { RouteError } from "../runtime/routes/errors.js";
import { generateVoiceCode, hashVoiceCode } from "../util/voice-code.js";

/**
 * Invite create/list/revoke are gateway-native (the daemon route handlers
 * relay — see invite-relay-routes.test.ts; the gateway mint is exercised in
 * gateway/src/__tests__/contacts-control-plane-proxy.test.ts). What stays
 * daemon-local — token/voice redemption against the local invite table, the
 * outbound call trigger, and the presentation composition layered onto the
 * gateway's create payload — is exercised here.
 */
function fakeResponse(body: unknown, status = 200) {
  return { status, json: async () => body };
}

async function handleRedeemInvite(req: Request) {
  const body = (await req.json()) as Record<string, unknown>;
  try {
    const result = await _handleRedeemInvite({ body });
    return fakeResponse(result);
  } catch (err) {
    if (err instanceof RouteError) {
      return fakeResponse({ ok: false, error: err.message }, err.statusCode);
    }
    throw err;
  }
}

async function handleTriggerInviteCall(inviteId: string) {
  const result = await triggerInviteCall(inviteId);
  if (!result.ok) {
    return fakeResponse({ ok: false, error: result.error }, 400);
  }
  return fakeResponse({ ok: true, callSid: result.data.callSid });
}

await initializeDb();

/** Create a throwaway contact and return its ID, for use as the invite's contactId. */
function createTargetContact(displayName = "Test Contact"): string {
  return upsertContact({ displayName, role: "contact" }).id;
}

/** Seed a local voice invite row (redemption still reads the local table). */
function seedVoiceInvite(
  callerPhone = "+15551234567",
  opts: { contactId?: string; maxUses?: number } = {},
) {
  const code = generateVoiceCode(6);
  const { invite } = createInvite({
    sourceChannel: "phone",
    contactId: opts.contactId ?? createTargetContact(),
    maxUses: opts.maxUses ?? 1,
    expectedExternalUserId: callerPhone,
    voiceCodeHash: hashVoiceCode(code),
    voiceCodeDigits: 6,
  });
  return { invite, code };
}

function resetTables() {
  getSqlite().run("DELETE FROM assistant_ingress_invites");
  getSqlite().run("DELETE FROM contact_channels");
  getSqlite().run("DELETE FROM contacts");
}

// ---------------------------------------------------------------------------
// Token redemption (daemon-local)
// ---------------------------------------------------------------------------

describe("ingress invite redemption routes", () => {
  beforeEach(resetTables);

  test("POST /v1/contacts/invites/redeem — redeems an invite", async () => {
    const { rawToken } = createInvite({
      sourceChannel: "telegram",
      contactId: createTargetContact(),
      maxUses: 1,
    });

    const req = new Request("http://localhost/v1/contacts/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: rawToken,
        externalUserId: "redeemer-1",
        sourceChannel: "telegram",
      }),
    });

    const res = await handleRedeemInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const invite = body.invite as Record<string, unknown>;
    expect(invite.useCount).toBe(1);
    // Single-use invite should be fully redeemed
    expect(invite.status).toBe("redeemed");
  });

  test("POST /v1/contacts/invites/redeem — missing token returns 400", async () => {
    const req = new Request("http://localhost/v1/contacts/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalUserId: "redeemer-1" }),
    });

    const res = await handleRedeemInvite(req);
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("token");
  });

  test("POST /v1/contacts/invites/redeem — invalid token returns 400", async () => {
    const req = new Request("http://localhost/v1/contacts/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invalid-token" }),
    });

    const res = await handleRedeemInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
  });

  test("create + revoke round-trip against the local store", async () => {
    const { invite } = createInvite({
      sourceChannel: "telegram",
      contactId: createTargetContact(),
    });
    expect(invite.status).toBe("active");

    const revoked = revokeInvite(invite.id);
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.id).toBe(invite.id);
  });
});

// ---------------------------------------------------------------------------
// Voice invite redemption (daemon-local)
// ---------------------------------------------------------------------------

describe("voice invite redemption routes", () => {
  beforeEach(resetTables);

  test("POST /v1/contacts/invites/redeem — redeems a voice invite code via unified endpoint", async () => {
    const { code } = seedVoiceInvite("+15551234567");

    // Redeem the voice code via the unified /redeem endpoint
    const redeemReq = new Request(
      "http://localhost/v1/contacts/invites/redeem",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callerExternalUserId: "+15551234567",
          code,
        }),
      },
    );

    const res = await handleRedeemInvite(redeemReq);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.type).toBe("redeemed");
    expect(typeof body.memberId).toBe("string");
    expect(typeof body.inviteId).toBe("string");
  });

  test("POST /v1/contacts/invites/redeem — voice code missing fields returns 400", async () => {
    const req = new Request("http://localhost/v1/contacts/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callerExternalUserId: "+15551234567" }),
    });

    const res = await handleRedeemInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    // No `code` and no `token` → falls through to token-based path which requires token
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
  });

  test("POST /v1/contacts/invites/redeem — wrong voice code returns 400", async () => {
    seedVoiceInvite("+15551234567");

    const req = new Request("http://localhost/v1/contacts/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callerExternalUserId: "+15551234567",
        code: "000000",
      }),
    });

    const res = await handleRedeemInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Presentation composition (daemon-owned layer over the gateway mint payload)
// ---------------------------------------------------------------------------

describe("composeInvitePresentation", () => {
  beforeEach(resetTables);

  test("voice invites get a guardianInstruction with the contact's first name", async () => {
    const contactId = createTargetContact("Carolina Example");

    const invite = await composeInvitePresentation({
      contactId,
      invite: {
        id: "inv-voice-1",
        sourceChannel: "phone",
        voiceCode: "123456",
        voiceCodeDigits: 6,
      },
    });

    expect(invite.guardianInstruction).toBe(
      "Carolina will need this code when they answer. Share it with them first.",
    );
    // Voice invites never gain a share payload (no raw token exists).
    expect(invite.share).toBeUndefined();
  });

  test("voice invites fall back to the generic instruction when no contact name resolves", async () => {
    const invite = await composeInvitePresentation({
      contactId: "missing-contact",
      invite: { id: "inv-voice-2", sourceChannel: "phone" },
    });

    expect(invite.guardianInstruction).toBe(
      "Share this code with them — they'll need it when they answer the call.",
    );
  });

  test("telegram invites gain share URL + guardianInstruction when bot username is configured", async () => {
    mockTelegramBotUsername = "test_invite_bot";

    try {
      const rawToken = "raw-token-abc";
      const invite = await composeInvitePresentation({
        contactId: createTargetContact("Alice"),
        invite: {
          id: "inv-tg-1",
          sourceChannel: "telegram",
          token: rawToken,
          inviteCode: "654321",
        },
        rawToken,
      });

      const share = invite.share as Record<string, unknown>;
      expect(share).toBeDefined();
      expect(share.url).toBe(`https://t.me/test_invite_bot?start=iv_${rawToken}`);
      expect(typeof share.displayText).toBe("string");
      expect(typeof invite.guardianInstruction).toBe("string");
      expect((invite.guardianInstruction as string).length).toBeGreaterThan(0);
      // One-time secrets from the gateway payload pass through untouched.
      expect(invite.token).toBe(rawToken);
      expect(invite.inviteCode).toBe("654321");
    } finally {
      mockTelegramBotUsername = undefined;
    }
  });

  test("non-voice payloads without an inviteCode pass through unchanged", async () => {
    const payload = { id: "inv-x", sourceChannel: "telegram", status: "active" };
    const invite = await composeInvitePresentation({
      contactId: createTargetContact(),
      invite: payload,
    });
    expect(invite).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Trigger invite call endpoint
// ---------------------------------------------------------------------------

describe("POST /v1/contacts/invites/:id/call", () => {
  beforeEach(() => {
    resetTables();
    mockStartInviteCallResult = { ok: true, callSid: "CA_test_sid_123" };
  });

  test("triggers a call for an active phone invite", async () => {
    const { invite } = seedVoiceInvite("+15551234567");

    const res = await handleTriggerInviteCall(invite.id);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.callSid).toBe("CA_test_sid_123");
  });

  test("returns 400 for non-existent invite", async () => {
    const res = await handleTriggerInviteCall("nonexistent-id");
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invite not found");
  });

  test("returns 400 for a revoked (non-active) invite", async () => {
    const { invite } = seedVoiceInvite("+15551234567");

    // Revoke the invite
    revokeInvite(invite.id);

    const res = await handleTriggerInviteCall(invite.id);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invite is not active");
  });

  test("returns 400 for a non-phone invite", async () => {
    const { invite } = createInvite({
      sourceChannel: "telegram",
      contactId: createTargetContact(),
    });

    const res = await handleTriggerInviteCall(invite.id);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Only phone invites support call triggering");
  });
});
