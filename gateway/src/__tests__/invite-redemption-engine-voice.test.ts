/**
 * Tests for the gateway engine's voice-invite surface
 * (verification/invite-redemption.ts): caller-scoped detection
 * (getActiveVoiceInviteForCaller) and spoken-code redemption
 * (redeemVoiceInvite) — candidate scoping, generic invalid_or_expired
 * failure, lazy expiry sweep, the membership gate, the atomic claim, and
 * the phone ACL side effect.
 *
 * The gateway DB is real (shared test preload); the assistant DB mirror is
 * mocked out — it is a best-effort info mirror and not under test here.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { hashInviteCode } from "@vellumai/gateway-client";

// The engine's ACL side effect (upsertVerifiedContactChannel) dual-writes an
// assistant-DB info mirror over IPC; stub it so tests never touch a socket.
// Spread the actual module so untouched exports (assistantDbExec,
// assistantDbTransaction) stay importable by later-loaded files when suites
// share a bun process.
const actualAssistantDbProxy = await import("../db/assistant-db-proxy.js");
mock.module("../db/assistant-db-proxy.js", () => ({
  ...actualAssistantDbProxy,
  assistantDbQuery: async () => [],
  assistantDbRun: async () => {},
}));

// Capture the best-effort invite_redeemed daemon event (fired by the engine
// on every real redeem) instead of dialing the assistant socket. Spread the
// actual module so the real IpcHandlerError/IpcTransportError classes (and
// untouched exports) stay importable by later-loaded files.
let ipcCallAssistantCalls: Array<{ method: string; body: unknown }> = [];
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: async (method: string, opts?: { body?: unknown }) => {
    ipcCallAssistantCalls.push({ method, body: opts?.body });
    return {};
  },
}));

await import("./test-preload.js");

const { initGatewayDb, getGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const { contacts, contactChannels, ingressInvites } =
  await import("../db/schema.js");
const { ContactStore } = await import("../db/contact-store.js");
const { getActiveVoiceInviteForCaller, redeemVoiceInvite } =
  await import("../verification/invite-redemption.js");

const CALLER = "+15555550100";
const OTHER_CALLER = "+15555550199";
const CODE = "123456";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(ingressInvites).run();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  ipcCallAssistantCalls = [];
});

afterAll(() => {
  resetGatewayDb();
});

function seedContact(id: string, displayName = `name-${id}`): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id,
      displayName,
      role: "contact",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedPhoneChannel(args: {
  id: string;
  contactId: string;
  address: string;
  status: string;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: args.id,
      contactId: args.contactId,
      type: "phone",
      address: args.address,
      externalChatId: args.address,
      status: args.status,
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
    })
    .run();
}

function seedVoiceInvite(
  overrides: Partial<
    Parameters<InstanceType<typeof ContactStore>["createInvite"]>[0]
  > = {},
): string {
  const store = new ContactStore();
  const id = overrides.id ?? crypto.randomUUID();
  store.createInvite({
    id,
    sourceChannel: "phone",
    voiceCodeHash: hashInviteCode(CODE),
    voiceCodeDigits: 6,
    expectedExternalUserId: CALLER,
    friendName: "Friend Name",
    guardianName: "Guardian Name",
    contactId: "c1",
    maxUses: 1,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  });
  return id;
}

function inviteRow(id: string) {
  return new ContactStore().getInviteById(id)!;
}

function gwPhoneChannel(address: string) {
  return getGatewayDb()
    .select()
    .from(contactChannels)
    .all()
    .find((ch) => ch.type === "phone" && ch.address === address);
}

describe("getActiveVoiceInviteForCaller", () => {
  test("active invite: curated contact displayName wins, metadata only", () => {
    seedContact("c1", "Curated Name");
    const inviteId = seedVoiceInvite({ voiceCodeDigits: 4 });

    const invite = getActiveVoiceInviteForCaller(CALLER);

    expect(invite).toEqual({
      inviteId,
      inviteeName: "Curated Name",
      guardianName: "Guardian Name",
      codeDigits: 4,
    });
  });

  test("falls back to friendName when the contact has no displayName; codeDigits defaults to 6", () => {
    seedContact("c1", "");
    const inviteId = seedVoiceInvite({
      voiceCodeDigits: null,
      guardianName: null,
    });

    const invite = getActiveVoiceInviteForCaller(CALLER);

    expect(invite).toEqual({
      inviteId,
      inviteeName: "Friend Name",
      guardianName: null,
      codeDigits: 6,
    });
  });

  test("no invite bound to the caller → null (another caller's invite is invisible)", () => {
    seedContact("c1");
    seedVoiceInvite({ expectedExternalUserId: OTHER_CALLER });

    expect(getActiveVoiceInviteForCaller(CALLER)).toBeNull();
  });

  test("expired invite → null and lazily marked expired", () => {
    seedContact("c1");
    const inviteId = seedVoiceInvite({ expiresAt: Date.now() - 1 });

    expect(getActiveVoiceInviteForCaller(CALLER)).toBeNull();
    expect(inviteRow(inviteId).status).toBe("expired");
  });
});

describe("redeemVoiceInvite", () => {
  test("valid code: claims atomically, activates the phone channel, returns the outcome", async () => {
    seedContact("c1", "Curated Name");
    const inviteId = seedVoiceInvite();

    const result = await redeemVoiceInvite({
      callerExternalUserId: CALLER,
      code: CODE,
    });

    expect(result.status).toBe("redeemed");
    if (result.status !== "redeemed") throw new Error("unreachable");
    expect(result.outcome).toMatchObject({
      inviteId,
      contactId: "c1",
      sourceChannel: "phone",
      memberExternalUserId: CALLER,
      memberExternalChatId: CALLER,
      displayName: "Curated Name",
      result: "redeemed",
    });

    const invite = inviteRow(inviteId);
    expect(invite.useCount).toBe(1);
    expect(invite.status).toBe("redeemed");
    expect(invite.redeemedByExternalUserId).toBe(CALLER);

    const channel = gwPhoneChannel(CALLER);
    expect(channel?.status).toBe("active");
    expect(channel?.verifiedVia).toBe("invite");
    expect(channel?.contactId).toBe("c1");

    // The engine fires the daemon info-mirror event with the outcome verbatim.
    const mirrored = ipcCallAssistantCalls.filter(
      (c) => c.method === "invite_redeemed",
    );
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0].body).toEqual(result.outcome);
  });

  test("falls back to friendName when the target contact has no curated displayName", async () => {
    seedContact("c1", "");
    seedVoiceInvite();

    const result = await redeemVoiceInvite({
      callerExternalUserId: CALLER,
      code: CODE,
    });

    expect(result.status).toBe("redeemed");
    if (result.status !== "redeemed") throw new Error("unreachable");
    expect(result.outcome.displayName).toBe("Friend Name");
  });

  test("wrong code → invalid_or_expired, no use consumed", async () => {
    seedContact("c1");
    const inviteId = seedVoiceInvite();

    const result = await redeemVoiceInvite({
      callerExternalUserId: CALLER,
      code: "999999",
    });

    expect(result).toEqual({ status: "failed", reason: "invalid_or_expired" });
    expect(inviteRow(inviteId).useCount).toBe(0);
  });

  test("code bound to a different caller → invalid_or_expired (candidate scoping)", async () => {
    seedContact("c1");
    const inviteId = seedVoiceInvite({ expectedExternalUserId: OTHER_CALLER });

    const result = await redeemVoiceInvite({
      callerExternalUserId: CALLER,
      code: CODE,
    });

    expect(result).toEqual({ status: "failed", reason: "invalid_or_expired" });
    expect(inviteRow(inviteId).useCount).toBe(0);
  });

  test("expired invite → invalid_or_expired and lazily marked expired", async () => {
    seedContact("c1");
    const inviteId = seedVoiceInvite({ expiresAt: Date.now() - 1 });

    const result = await redeemVoiceInvite({
      callerExternalUserId: CALLER,
      code: CODE,
    });

    expect(result).toEqual({ status: "failed", reason: "invalid_or_expired" });
    const invite = inviteRow(inviteId);
    expect(invite.status).toBe("expired");
    expect(invite.useCount).toBe(0);
  });

  test("already-active member: already_member, NO use consumed", async () => {
    seedContact("c1");
    seedPhoneChannel({
      id: "ch-1",
      contactId: "c1",
      address: CALLER,
      status: "active",
    });
    const inviteId = seedVoiceInvite();

    const result = await redeemVoiceInvite({
      callerExternalUserId: CALLER,
      code: CODE,
    });

    expect(result.status).toBe("already_member");
    if (result.status !== "already_member") throw new Error("unreachable");
    expect(result.outcome.result).toBe("already_member");
    expect(inviteRow(inviteId).useCount).toBe(0);
    expect(inviteRow(inviteId).status).toBe("active");
    // Nothing consumed → no daemon info-mirror event.
    expect(
      ipcCallAssistantCalls.filter((c) => c.method === "invite_redeemed"),
    ).toHaveLength(0);
  });

  test("blocked phone channel is NEVER reactivated: generic failure, no use consumed", async () => {
    seedContact("c1");
    seedPhoneChannel({
      id: "ch-1",
      contactId: "c1",
      address: CALLER,
      status: "blocked",
    });
    const inviteId = seedVoiceInvite();

    const result = await redeemVoiceInvite({
      callerExternalUserId: CALLER,
      code: CODE,
    });

    expect(result).toEqual({ status: "failed", reason: "invalid_or_expired" });
    expect(inviteRow(inviteId).useCount).toBe(0);
    expect(gwPhoneChannel(CALLER)?.status).toBe("blocked");
  });

  test("revoked phone channel IS reactivated by an invite", async () => {
    seedContact("c1");
    seedPhoneChannel({
      id: "ch-1",
      contactId: "c1",
      address: CALLER,
      status: "revoked",
    });
    const inviteId = seedVoiceInvite();

    const result = await redeemVoiceInvite({
      callerExternalUserId: CALLER,
      code: CODE,
    });

    expect(result.status).toBe("redeemed");
    expect(inviteRow(inviteId).useCount).toBe(1);
    expect(gwPhoneChannel(CALLER)?.status).toBe("active");
  });

  test("atomic double-redeem: two concurrent redemptions → exactly one consumes the use", async () => {
    seedContact("c1");
    const inviteId = seedVoiceInvite({ maxUses: 1 });

    const results = await Promise.all([
      redeemVoiceInvite({ callerExternalUserId: CALLER, code: CODE }),
      redeemVoiceInvite({ callerExternalUserId: CALLER, code: CODE }),
    ]);

    // Whichever interleaving occurs, at most one caller consumes the use; the
    // loser fails the atomic claim (or resolves already_member after the
    // winner's activation) — the row is never double-consumed.
    const redeemed = results.filter((r) => r.status === "redeemed");
    expect(redeemed.length).toBeLessThanOrEqual(1);
    expect(inviteRow(inviteId).useCount).toBe(1);
    expect(inviteRow(inviteId).status).toBe("redeemed");
  });

  test("sequential re-redemption of a consumed invite → invalid_or_expired", async () => {
    seedContact("c1");
    seedVoiceInvite({ maxUses: 1 });
    await redeemVoiceInvite({ callerExternalUserId: CALLER, code: CODE });
    // Reset the caller's channel so the retry isn't gated as already_member.
    getGatewayDb().delete(contactChannels).run();

    const result = await redeemVoiceInvite({
      callerExternalUserId: CALLER,
      code: CODE,
    });

    expect(result).toEqual({ status: "failed", reason: "invalid_or_expired" });
  });

  test("empty caller identity → invalid_or_expired", async () => {
    seedContact("c1");
    seedVoiceInvite();

    const result = await redeemVoiceInvite({
      callerExternalUserId: "",
      code: CODE,
    });

    expect(result).toEqual({ status: "failed", reason: "invalid_or_expired" });
  });
});
