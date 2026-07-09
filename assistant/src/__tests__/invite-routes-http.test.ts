import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

// Legacy-shaped fixtures (llm.default-centric resolution): pinned to the
// flag-off cascade. Override-or-default (flag-on) semantics are pinned by
// llm-resolver-override-or-default.test.ts and its companion suites.
beforeAll(() => {
  setOverridesForTesting({ "override-or-default-resolution": false });
});

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
// Captures the last input so trigger-call tests can assert the gateway-supplied
// fields flow through to the provider call.
let mockStartInviteCallResult:
  | { ok: true; callSid: string }
  | { ok: false; error: string; status?: number } = {
  ok: true,
  callSid: "CA_test_sid_123",
};
let lastStartInviteCallInput: Record<string, unknown> | null = null;
mock.module("../calls/call-domain.js", () => ({
  startInviteCall: async (input: Record<string, unknown>) => {
    lastStartInviteCallInput = input;
    return mockStartInviteCallResult;
  },
}));

// Model the gateway `invites_redeem` IPC: the daemon redeem route is a thin
// relay (the gateway redemption engine owns validation, the atomic claim,
// and the ACL write), so the mock captures the relayed params and serves a
// scripted gateway response or a scripted relay failure.
import { IpcCallError } from "@vellumai/gateway-client/ipc-client";

const redeemRelay: {
  calls: Array<Record<string, unknown> | undefined>;
  result: unknown;
  error: Error | null;
} = { calls: [], result: undefined, error: null };
mock.module("../ipc/gateway-client.js", () => ({
  ipcCallPersistent: async (
    method: string,
    params?: Record<string, unknown>,
  ) => {
    if (method === "invites_redeem") {
      redeemRelay.calls.push(params);
      if (redeemRelay.error) {
        throw redeemRelay.error;
      }
      return redeemRelay.result;
    }
    return undefined;
  },
}));

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../config/loader.js";
import { upsertContact } from "../contacts/contact-store.js";
import { getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  composeInvitePresentation,
  triggerInviteCall,
} from "../runtime/invite-service.js";
import { handleRedeemInvite as _handleRedeemInvite } from "../runtime/routes/contact-routes.js";
import { RouteError } from "../runtime/routes/errors.js";

/**
 * Invite create/list/revoke/redeem are gateway-native (the daemon route
 * handlers relay; the gateway engine is exercised in
 * gateway/src/__tests__/invite-redemption-engine*.test.ts and the gateway
 * handlers in contacts-control-plane-proxy.test.ts +
 * ipc-invite-routes.test.ts). What stays daemon-local — the redeem relay
 * dispatch, the outbound call trigger, and the presentation composition
 * layered onto the gateway's create payload — is exercised here.
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

async function handleTriggerInviteCall(params: {
  phoneNumber?: string;
  friendName?: string | null;
  guardianName?: string | null;
}) {
  const result = await triggerInviteCall(params);
  if (!result.ok) {
    return fakeResponse({ ok: false, error: result.error }, 400);
  }
  return fakeResponse({ ok: true, callSid: result.data.callSid });
}

await initializeDb();

// Disable the catalog default so resolution lands on llm.default. Without the
// stub, the `inviteInstructionGenerator` call site resolves the catalog's
// `cost-optimized` profile, whose `vellum` provider_connection does not exist
// in this test workspace's DB — resolution would throw instead of falling back
// to the deterministic instruction copy.
{
  const raw = loadRawConfig();
  const llm = (raw.llm ?? {}) as Record<string, unknown>;
  llm.profiles = {
    ...((llm.profiles ?? {}) as Record<string, unknown>),
    "cost-optimized": { source: "managed", status: "disabled" },
  };
  raw.llm = llm;
  saveRawConfig(raw);
  invalidateConfigCache();
}

/** Create a throwaway contact and return its ID, for use as the invite's contactId. */
function createTargetContact(displayName = "Test Contact"): string {
  return upsertContact({ displayName }).id;
}

function resetTables() {
  getSqlite().run("DELETE FROM contact_channels");
  getSqlite().run("DELETE FROM contacts");
}

function resetRedeemRelay() {
  redeemRelay.calls.length = 0;
  redeemRelay.result = undefined;
  redeemRelay.error = null;
}

// ---------------------------------------------------------------------------
// Redeem relay (gateway-native redemption behind the daemon route)
// ---------------------------------------------------------------------------

describe("invite redeem relay routes", () => {
  beforeEach(() => {
    resetTables();
    resetRedeemRelay();
  });

  test("POST /v1/contacts/invites/redeem — token body relays to the gateway and returns its payload", async () => {
    redeemRelay.result = {
      ok: true,
      invite: {
        id: "inv-gw-1",
        sourceChannel: "telegram",
        status: "redeemed",
        useCount: 1,
      },
      type: "redeemed",
    };

    const req = new Request("http://localhost/v1/contacts/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "raw-token-1",
        externalUserId: "redeemer-1",
        externalChatId: "chat-9",
        sourceChannel: "telegram",
        displayName: "Alice Example",
        username: "alice",
        notAContractField: "dropped",
      }),
    });

    const res = await handleRedeemInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect((body.invite as Record<string, unknown>).id).toBe("inv-gw-1");
    expect(body.type).toBe("redeemed");
    // The relay forwards every shared-contract field — including the sender
    // identity fields (displayName/username) the gateway engine stamps onto
    // the new member — and nothing voice-shaped or off-contract.
    expect(redeemRelay.calls).toEqual([
      {
        token: "raw-token-1",
        sourceChannel: "telegram",
        externalUserId: "redeemer-1",
        externalChatId: "chat-9",
        displayName: "Alice Example",
        username: "alice",
      },
    ]);
  });

  test("POST /v1/contacts/invites/redeem — voice body relays code + caller and returns the voice shape", async () => {
    redeemRelay.result = {
      ok: true,
      type: "redeemed",
      memberId: "ct-target",
      inviteId: "inv-gw-2",
    };
    const code = "123456";

    const req = new Request("http://localhost/v1/contacts/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callerExternalUserId: "+15551234567",
        code,
        assistantId: "asst-1",
      }),
    });

    const res = await handleRedeemInvite(req);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      type: "redeemed",
      memberId: "ct-target",
      inviteId: "inv-gw-2",
    });
    expect(redeemRelay.calls).toEqual([
      { code, callerExternalUserId: "+15551234567", assistantId: "asst-1" },
    ]);
  });

  test("POST /v1/contacts/invites/redeem — gateway 400 (engine reason) surfaces as 400", async () => {
    redeemRelay.error = new IpcCallError("invalid_or_expired", {
      statusCode: 400,
      errorCode: "BAD_REQUEST",
    });

    const req = new Request("http://localhost/v1/contacts/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callerExternalUserId: "+15551234567",
        code: "000000",
      }),
    });

    const res = await handleRedeemInvite(req);
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid_or_expired");
  });

  test("POST /v1/contacts/invites/redeem — gateway unreachable fails CLOSED (500)", async () => {
    // The gateway is the single redemption authority; a relay failure must
    // surface as an error, never a locally-decided redemption.
    redeemRelay.error = new IpcCallError("gateway unreachable");

    const req = new Request("http://localhost/v1/contacts/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callerExternalUserId: "+15551234567",
        code: "123456",
      }),
    });

    const res = await handleRedeemInvite(req);
    expect(res.status).toBe(500);
  });

  test("POST /v1/contacts/invites/redeem — missing token returns 400 without relaying", async () => {
    const req = new Request("http://localhost/v1/contacts/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalUserId: "redeemer-1" }),
    });

    const res = await handleRedeemInvite(req);
    const body = (await res.json()) as { ok: boolean; error: string };

    // No `code` and no `token` → token path; the shared contract schema
    // rejects daemon-side before any gateway round-trip.
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("token");
    expect(redeemRelay.calls.length).toBe(0);
  });

  test("POST /v1/contacts/invites/redeem — voice code without caller identity is rejected daemon-side", async () => {
    const req = new Request("http://localhost/v1/contacts/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });

    const res = await handleRedeemInvite(req);
    const body = (await res.json()) as { ok: boolean; error: string };

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("callerExternalUserId");
    // Rejected before any gateway round-trip.
    expect(redeemRelay.calls.length).toBe(0);
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
      expect(share.url).toBe(
        `https://t.me/test_invite_bot?start=iv_${rawToken}`,
      );
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
    const payload = {
      id: "inv-x",
      sourceChannel: "telegram",
      status: "active",
    };
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

// Invite lifecycle validation (existence/active/expiry/phone) lives in the
// gateway's triggerInviteCallNative — see the gateway proxy tests. The daemon
// only performs the provider call from the gateway-supplied fields.
describe("POST /v1/contacts/invites/:id/call", () => {
  beforeEach(() => {
    resetTables();
    mockStartInviteCallResult = { ok: true, callSid: "CA_test_sid_123" };
    lastStartInviteCallInput = null;
  });

  test("places the call from the gateway-supplied fields", async () => {
    const res = await handleTriggerInviteCall({
      phoneNumber: "+15551234567",
      friendName: "Alice",
      guardianName: "Guardian Label",
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.callSid).toBe("CA_test_sid_123");
    expect(lastStartInviteCallInput).toEqual({
      phoneNumber: "+15551234567",
      friendName: "Alice",
      guardianName: "Guardian Label",
    });
  });

  test("returns 400 when phoneNumber is missing (no local invite fallback)", async () => {
    // The gateway row is the lifecycle authority and supplies the call fields;
    // the daemon has no invite store to fall back on.
    const res = await handleTriggerInviteCall({});
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("phoneNumber is required");
    expect(lastStartInviteCallInput).toBeNull();
  });

  test("empty friendName falls through to the neutral-greeting contract", async () => {
    const res = await handleTriggerInviteCall({
      phoneNumber: "+15551234567",
      friendName: "   ",
      guardianName: "Guardian Label",
    });

    expect(res.status).toBe(200);
    expect(lastStartInviteCallInput).toMatchObject({ friendName: "" });
  });

  test("null guardianName falls back to the resolved guardian name", async () => {
    const res = await handleTriggerInviteCall({
      phoneNumber: "+15551234567",
      friendName: "Alice",
      guardianName: null,
    });

    expect(res.status).toBe(200);
    // resolveGuardianName() has no persona in this env, so the fallback
    // resolves to the empty-string default rather than the null passthrough.
    expect(typeof lastStartInviteCallInput?.guardianName).toBe("string");
  });

  test("surfaces a failed provider call as 400", async () => {
    mockStartInviteCallResult = {
      ok: false,
      error: "phone_number must be in E.164 format",
    };

    const res = await handleTriggerInviteCall({ phoneNumber: "+15551234567" });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.error).toBe("phone_number must be in E.164 format");
  });
});
