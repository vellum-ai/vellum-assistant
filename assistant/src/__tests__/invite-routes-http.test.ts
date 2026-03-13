import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "invite-routes-http-test-"));

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

// Prevent ensureTelegramBotUsernameResolved() from reading real credentials
// and calling the Telegram API.
mock.module("../security/secure-keys.js", () => ({
  getSecureKey: () => undefined,
  setSecureKey: () => {},
  deleteSecureKey: () => {},
  getSecureKeyAsync: async () => undefined,
  setSecureKeyAsync: async () => {},
  deleteSecureKeyAsync: async () => {},
}));

// Mock getTelegramBotUsername — the env var fallback was removed so we
// control the return value directly via a mutable variable.
let mockTelegramBotUsername: string | undefined;
mock.module("../telegram/bot-username.js", () => ({
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

import { getSqlite, initializeDb, resetDb } from "../memory/db.js";
import {
  handleCreateInvite,
  handleListInvites,
  handleRedeemInvite,
  handleRevokeInvite,
  handleTriggerInviteCall,
} from "../runtime/routes/invite-routes.js";

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

  test("GET /v1/contacts/invites — lists invites", async () => {
    // Create two invites
    await handleCreateInvite(
      new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceChannel: "telegram" }),
      }),
    );
    await handleCreateInvite(
      new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceChannel: "telegram" }),
      }),
    );

    const url = new URL("http://localhost/v1/contacts/invites");
    const res = handleListInvites(url);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.invites)).toBe(true);
    expect((body.invites as unknown[]).length).toBe(2);
  });

  test("DELETE /v1/contacts/invites/:id — revokes an invite", async () => {
    const createRes = await handleCreateInvite(
      new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceChannel: "telegram" }),
      }),
    );
    const created = (await createRes.json()) as { invite: { id: string } };

    const res = handleRevokeInvite(created.invite.id);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const invite = body.invite as Record<string, unknown>;
    expect(invite.status).toBe("revoked");
  });

  test("DELETE /v1/contacts/invites/:id — not found returns 404", () => {
    const res = handleRevokeInvite("nonexistent-id");
    expect(res.status).toBe(404);
  });

  test("POST /v1/contacts/invites/redeem — redeems an invite", async () => {
    // Create an invite first
    const createRes = await handleCreateInvite(
      new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceChannel: "telegram", maxUses: 1 }),
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
        body: JSON.stringify({ sourceChannel: "telegram" }),
      }),
    );
    const created = (await createRes.json()) as {
      invite: { id: string; status: string };
    };
    expect(created.invite.status).toBe("active");

    const revokeRes = handleRevokeInvite(created.invite.id);
    const revoked = (await revokeRes.json()) as {
      invite: { id: string; status: string };
    };
    expect(revoked.invite.status).toBe("revoked");
    expect(revoked.invite.id).toBe(created.invite.id);
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
        expectedExternalUserId: "+15551234567",
        friendName: "Alice",
        guardianName: "Bob",
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
    // friendName and guardianName should be recorded
    expect(invite.friendName).toBe("Alice");
    expect(invite.guardianName).toBe("Bob");
  });

  test("voice invite creation requires expectedExternalUserId", async () => {
    const req = new Request("http://localhost/v1/contacts/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "phone",
        friendName: "Alice",
        guardianName: "Bob",
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
        expectedExternalUserId: "not-a-phone-number",
        friendName: "Alice",
        guardianName: "Bob",
      }),
    });

    const res = await handleCreateInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("E.164");
  });

  test("voice invite creation requires friendName", async () => {
    const req = new Request("http://localhost/v1/contacts/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "phone",
        expectedExternalUserId: "+15551234567",
        guardianName: "Bob",
      }),
    });

    const res = await handleCreateInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("friendName");
  });

  test("voice invite creation requires guardianName", async () => {
    const req = new Request("http://localhost/v1/contacts/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "phone",
        expectedExternalUserId: "+15551234567",
        friendName: "Alice",
      }),
    });

    const res = await handleCreateInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("guardianName");
  });

  test("voiceCodeDigits is always 6 — custom values are ignored", async () => {
    const req = new Request("http://localhost/v1/contacts/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "phone",
        expectedExternalUserId: "+15551234567",
        friendName: "Alice",
        guardianName: "Bob",
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
        expectedExternalUserId: "+15551234567",
        friendName: "Alice",
        guardianName: "Bob",
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
          expectedExternalUserId: "+15551234567",
          friendName: "Alice",
          guardianName: "Bob",
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
          expectedExternalUserId: "+15551234567",
          friendName: "Alice",
          guardianName: "Bob",
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

  test("voice invite creation returns guardianInstruction with friend name", async () => {
    const req = new Request("http://localhost/v1/contacts/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "phone",
        expectedExternalUserId: "+15551234567",
        friendName: "Alice",
        guardianName: "Bob",
      }),
    });

    const res = await handleCreateInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    const invite = body.invite as Record<string, unknown>;
    expect(invite.guardianInstruction).toBe(
      "Alice will need this code when they answer. Share it with them first.",
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
          expectedExternalUserId: "+15551234567",
          friendName: "Alice",
          guardianName: "Bob",
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
          expectedExternalUserId: "+15551234567",
          friendName: "Alice",
          guardianName: "Bob",
        }),
      }),
    );
    const created = (await createRes.json()) as { invite: { id: string } };

    // Revoke the invite
    handleRevokeInvite(created.invite.id);

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
