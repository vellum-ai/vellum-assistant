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

import { upsertContact } from "../contacts/contact-store.js";
import { getSqlite } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { revokeInvite } from "../memory/invite-store.js";
import {
  createIngressInvite,
  triggerInviteCall,
} from "../runtime/invite-service.js";
import { handleRedeemInvite as _handleRedeemInvite } from "../runtime/routes/contact-routes.js";
import { RouteError } from "../runtime/routes/errors.js";

/**
 * The CLI/HTTP create/list/revoke/trigger route handlers relay to the gateway
 * (see invite-relay-routes.test.ts). The assistant-native invite logic the
 * gateway invokes via `invites_mint` + its native handlers is exercised here
 * against the assistant DB through the `invite-service` functions. Redemption
 * stays daemon-local and is driven through the route handler.
 */
function fakeResponse(body: unknown, status = 200) {
  return { status, json: async () => body };
}

async function handleCreateInvite(req: Request) {
  const body = (await req.json()) as Record<string, string | number>;
  const result = await createIngressInvite({
    sourceChannel: body.sourceChannel as string | undefined,
    note: body.note as string | undefined,
    maxUses: body.maxUses as number | undefined,
    expiresInMs: body.expiresInMs as number | undefined,
    expectedExternalUserId: body.expectedExternalUserId as string | undefined,
    contactId: body.contactId as string,
  });
  if (!result.ok) return fakeResponse({ ok: false, error: result.error }, 400);
  return fakeResponse({ ok: true, invite: result.data }, 201);
}

async function handleRedeemInvite(req: Request) {
  const body = (await req.json()) as Record<string, unknown>;
  try {
    const result = await _handleRedeemInvite({ body });
    return fakeResponse(result);
  } catch (err) {
    if (err instanceof RouteError)
      return fakeResponse({ ok: false, error: err.message }, err.statusCode);
    throw err;
  }
}

async function handleTriggerInviteCall(inviteId: string) {
  const result = await triggerInviteCall(inviteId);
  if (!result.ok) return fakeResponse({ ok: false, error: result.error }, 400);
  return fakeResponse({ ok: true, callSid: result.data.callSid });
}

await initializeDb();

/** Create a throwaway contact and return its ID, for use as the invite's contactId. */
function createTargetContact(displayName = "Test Contact"): string {
  return upsertContact({ displayName, role: "contact" }).id;
}

function resetTables() {
  getSqlite().run("DELETE FROM assistant_ingress_invites");
  getSqlite().run("DELETE FROM contact_channels");
  getSqlite().run("DELETE FROM contacts");
}

// ---------------------------------------------------------------------------
// Invite routes
// ---------------------------------------------------------------------------

describe("ingress invite HTTP routes", () => {
  beforeEach(resetTables);

  test("POST /v1/contacts/invites — creates an invite", async () => {
    const req = new Request("http://localhost/v1/contacts/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "telegram",
        contactId: createTargetContact(),
        note: "Test invite",
        maxUses: 5,
      }),
    });

    const res = await handleCreateInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    const invite = body.invite as Record<string, unknown>;
    expect(invite.sourceChannel).toBe("telegram");
    expect(invite.note).toBe("Test invite");
    expect(invite.maxUses).toBe(5);
    expect(invite.status).toBe("active");
    // Raw token should be returned on create
    expect(typeof invite.token).toBe("string");
    expect((invite.token as string).length).toBeGreaterThan(0);
  });

  test("POST /v1/contacts/invites — includes canonical share URL when bot username is configured", async () => {
    mockTelegramBotUsername = "test_invite_bot";

    try {
      const req = new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannel: "telegram",
          contactId: createTargetContact(),
          note: "Share link test",
        }),
      });

      const res = await handleCreateInvite(req);
      const body = (await res.json()) as Record<string, unknown>;
      const invite = body.invite as Record<string, unknown>;
      const token = invite.token as string;
      const share = invite.share as Record<string, unknown>;

      expect(res.status).toBe(201);
      expect(body.ok).toBe(true);
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);
      expect(share).toBeDefined();
      expect(share.url).toBe(`https://t.me/test_invite_bot?start=iv_${token}`);
      expect(typeof share.displayText).toBe("string");
    } finally {
      mockTelegramBotUsername = undefined;
    }
  });

  test("POST /v1/contacts/invites — missing sourceChannel returns 400", async () => {
    const req = new Request("http://localhost/v1/contacts/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "No channel" }),
    });

    const res = await handleCreateInvite(req);
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("sourceChannel");
  });

  test("POST /v1/contacts/invites/redeem — redeems an invite", async () => {
    // Create an invite first
    const createRes = await handleCreateInvite(
      new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannel: "telegram",
          contactId: createTargetContact(),
          maxUses: 1,
        }),
      }),
    );
    const created = (await createRes.json()) as { invite: { token: string } };

    const req = new Request("http://localhost/v1/contacts/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: created.invite.token,
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
});

// ---------------------------------------------------------------------------
// Shared logic round-trip
// ---------------------------------------------------------------------------

describe("ingress service shared logic", () => {
  beforeEach(resetTables);

  test("invite create + revoke round-trip through shared service", async () => {
    const createRes = await handleCreateInvite(
      new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannel: "telegram",
          contactId: createTargetContact(),
        }),
      }),
    );
    const created = (await createRes.json()) as {
      invite: { id: string; status: string };
    };
    expect(created.invite.status).toBe("active");

    const revoked = revokeInvite(created.invite.id);
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.id).toBe(created.invite.id);
  });
});

// ---------------------------------------------------------------------------
// Voice invite routes
// ---------------------------------------------------------------------------

describe("voice invite HTTP routes", () => {
  beforeEach(resetTables);

  test("POST /v1/contacts/invites with sourceChannel voice — creates invite with voiceCode, stores hash only", async () => {
    const req = new Request("http://localhost/v1/contacts/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "phone",
        contactId: createTargetContact("Alice"),
        expectedExternalUserId: "+15551234567",
        maxUses: 3,
      }),
    });

    const res = await handleCreateInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    const invite = body.invite as Record<string, unknown>;
    expect(invite.sourceChannel).toBe("phone");
    // Voice code should be returned (6 digits by default)
    expect(typeof invite.voiceCode).toBe("string");
    expect((invite.voiceCode as string).length).toBe(6);
    expect(/^\d{6}$/.test(invite.voiceCode as string)).toBe(true);
    // Hash should be stored
    expect(typeof invite.tokenHash).toBe("string");
    expect((invite.tokenHash as string).length).toBeGreaterThan(0);
    // voiceCodeDigits should be recorded
    expect(invite.voiceCodeDigits).toBe(6);
    // expectedExternalUserId should be recorded
    expect(invite.expectedExternalUserId).toBe("+15551234567");
    // friendName is mirrored from the bound contact's displayName, not a flag
    expect(invite.friendName).toBe("Alice");
  });

  test("voice invite creation requires expectedExternalUserId", async () => {
    const req = new Request("http://localhost/v1/contacts/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "phone",
        contactId: createTargetContact(),
      }),
    });

    const res = await handleCreateInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("expectedExternalUserId");
  });

  test("voice invite creation validates E.164 format", async () => {
    const req = new Request("http://localhost/v1/contacts/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "phone",
        contactId: createTargetContact(),
        expectedExternalUserId: "not-a-phone-number",
      }),
    });

    const res = await handleCreateInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("E.164");
  });

  test("voiceCodeDigits is always 6 — custom values are ignored", async () => {
    const req = new Request("http://localhost/v1/contacts/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "phone",
        contactId: createTargetContact(),
        expectedExternalUserId: "+15551234567",
        voiceCodeDigits: 8,
      }),
    });

    const res = await handleCreateInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    const invite = body.invite as Record<string, unknown>;
    expect((invite.voiceCode as string).length).toBe(6);
    expect(invite.voiceCodeDigits).toBe(6);
  });

  test("voice invites do NOT return token in response", async () => {
    const req = new Request("http://localhost/v1/contacts/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "phone",
        contactId: createTargetContact(),
        expectedExternalUserId: "+15551234567",
      }),
    });

    const res = await handleCreateInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(201);
    const invite = body.invite as Record<string, unknown>;
    // Voice invites must not expose the raw token — callers redeem via
    // the identity-bound voice code flow
    expect(invite.token).toBeUndefined();
  });

  test("POST /v1/contacts/invites/redeem — redeems a voice invite code via unified endpoint", async () => {
    // Create a voice invite
    const createRes = await handleCreateInvite(
      new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannel: "phone",
          contactId: createTargetContact(),
          expectedExternalUserId: "+15551234567",
          maxUses: 1,
        }),
      }),
    );
    const created = (await createRes.json()) as {
      invite: { voiceCode: string };
    };

    // Redeem the voice code via the unified /redeem endpoint
    const redeemReq = new Request(
      "http://localhost/v1/contacts/invites/redeem",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callerExternalUserId: "+15551234567",
          code: created.invite.voiceCode,
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
    // Create a voice invite
    await handleCreateInvite(
      new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannel: "phone",
          contactId: createTargetContact(),
          expectedExternalUserId: "+15551234567",
          maxUses: 1,
        }),
      }),
    );

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

  test("voice invite creation returns guardianInstruction with the contact's first name", async () => {
    const req = new Request("http://localhost/v1/contacts/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "phone",
        contactId: createTargetContact("Carolina Flaherty"),
        expectedExternalUserId: "+15551234567",
      }),
    });

    const res = await handleCreateInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    const invite = body.invite as Record<string, unknown>;
    // First-token of the contact's displayName is used in the instruction
    expect(invite.guardianInstruction).toBe(
      "Carolina will need this code when they answer. Share it with them first.",
    );
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
    const createRes = await handleCreateInvite(
      new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannel: "phone",
          contactId: createTargetContact(),
          expectedExternalUserId: "+15551234567",
        }),
      }),
    );
    const created = (await createRes.json()) as { invite: { id: string } };

    const res = await handleTriggerInviteCall(created.invite.id);
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
    const createRes = await handleCreateInvite(
      new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannel: "phone",
          contactId: createTargetContact(),
          expectedExternalUserId: "+15551234567",
        }),
      }),
    );
    const created = (await createRes.json()) as { invite: { id: string } };

    // Revoke the invite
    revokeInvite(created.invite.id);

    const res = await handleTriggerInviteCall(created.invite.id);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invite is not active");
  });

  test("returns 400 for a non-phone invite", async () => {
    const createRes = await handleCreateInvite(
      new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannel: "telegram",
          contactId: createTargetContact(),
        }),
      }),
    );
    const created = (await createRes.json()) as { invite: { id: string } };

    const res = await handleTriggerInviteCall(created.invite.id);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Only phone invites support call triggering");
  });
});
