/**
 * Tests for the gateway-native invite redemption engine
 * (verification/invite-redemption.ts): code + token resolution, lifecycle
 * validation (expiry lazy-marking, use counts, channel match), the
 * already-member no-consume gate, blocked-row refusal, revoked reactivation,
 * atomic double-redeem, and the ACL side effect on the gateway DB.
 *
 * The gateway DB is real (shared test preload); the assistant DB mirror is
 * mocked out — it is a best-effort info mirror and not under test here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { hashInviteCode, hashInviteToken } from "@vellumai/gateway-client";

// The engine's ACL side effect (upsertVerifiedContactChannel) dual-writes an
// assistant-DB info mirror over IPC; stub it so tests never touch a socket.
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: async () => [],
  assistantDbRun: async () => {},
}));

await import("./test-preload.js");

const { initGatewayDb, getGatewayDb, resetGatewayDb } = await import(
  "../db/connection.js"
);
const { contacts, contactChannels, ingressInvites } = await import(
  "../db/schema.js"
);
const { ContactStore } = await import("../db/contact-store.js");
const { redeemInviteByCode, redeemInviteByToken } = await import(
  "../verification/invite-redemption.js"
);

const CHANNEL = "telegram";
const CODE = "123456";
const TOKEN = "tok_raw_abc123";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(ingressInvites).run();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
});

afterAll(() => {
  resetGatewayDb();
});

function seedContact(id: string, displayName = `name-${id}`): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({ id, displayName, role: "contact", createdAt: now, updatedAt: now })
    .run();
}

function seedChannel(args: {
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
      type: CHANNEL,
      address: args.address,
      externalChatId: "chat-1",
      status: args.status,
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
    })
    .run();
}

function seedInvite(
  overrides: Partial<
    Parameters<InstanceType<typeof ContactStore>["createInvite"]>[0]
  > = {},
): string {
  const store = new ContactStore();
  const id = overrides.id ?? crypto.randomUUID();
  store.createInvite({
    id,
    sourceChannel: CHANNEL,
    inviteCodeHash: hashInviteCode(CODE),
    tokenHash: hashInviteToken(TOKEN),
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

function gwChannel(address: string) {
  return getGatewayDb()
    .select()
    .from(contactChannels)
    .all()
    .find(
      (ch) =>
        ch.type === CHANNEL &&
        ch.address.toLowerCase() === address.toLowerCase(),
    );
}

const IDENTITY = {
  sourceChannel: CHANNEL,
  externalUserId: "U_SENDER",
  externalChatId: "chat-sender",
  displayName: "Sender Name",
  username: "sender",
};

describe("redeemInviteByCode", () => {
  test("valid code: claims atomically, activates the gateway channel, returns the outcome", async () => {
    seedContact("c1");
    const inviteId = seedInvite();

    const result = await redeemInviteByCode({ code: CODE, ...IDENTITY });

    expect(result.status).toBe("redeemed");
    if (result.status !== "redeemed") throw new Error("unreachable");
    expect(result.replyText).toBe("Welcome! You've been granted access.");
    expect(result.outcome).toMatchObject({
      inviteId,
      contactId: "c1",
      sourceChannel: CHANNEL,
      memberExternalUserId: "U_SENDER",
      memberExternalChatId: "chat-sender",
      result: "redeemed",
    });

    const invite = inviteRow(inviteId);
    expect(invite.useCount).toBe(1);
    expect(invite.status).toBe("redeemed");
    expect(invite.redeemedByExternalUserId).toBe("U_SENDER");

    const channel = gwChannel("U_SENDER");
    expect(channel?.status).toBe("active");
    expect(channel?.verifiedVia).toBe("invite");
    expect(channel?.contactId).toBe("c1");
  });

  test("preserves the target contact's curated displayName in the outcome", async () => {
    seedContact("c1", "Curated Name");
    seedInvite();

    const result = await redeemInviteByCode({ code: CODE, ...IDENTITY });

    expect(result.status).toBe("redeemed");
    if (result.status !== "redeemed") throw new Error("unreachable");
    expect(result.outcome.displayName).toBe("Curated Name");
  });

  test("passes sourceConversationId through opaquely", async () => {
    seedContact("c1");
    seedInvite({ sourceConversationId: "conv-xyz" });

    const result = await redeemInviteByCode({ code: CODE, ...IDENTITY });

    expect(result.status).toBe("redeemed");
    if (result.status !== "redeemed") throw new Error("unreachable");
    expect(result.outcome.sourceConversationId).toBe("conv-xyz");
  });

  test("code matching no invite anywhere → no_match (fall through)", async () => {
    seedContact("c1");
    seedInvite();

    const result = await redeemInviteByCode({ code: "999999", ...IDENTITY });

    expect(result.status).toBe("no_match");
  });

  test("code active on another channel → channel_mismatch, no use consumed", async () => {
    seedContact("c1");
    const inviteId = seedInvite({ sourceChannel: "whatsapp" });

    const result = await redeemInviteByCode({ code: CODE, ...IDENTITY });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.reason).toBe("channel_mismatch");
    expect(result.replyText).toBe("This invite is not valid for this channel.");
    expect(inviteRow(inviteId).useCount).toBe(0);
  });

  test("expired invite is lazily marked expired, no use consumed", async () => {
    seedContact("c1");
    const inviteId = seedInvite({ expiresAt: Date.now() - 1 });

    const result = await redeemInviteByCode({ code: CODE, ...IDENTITY });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.reason).toBe("expired");
    expect(result.replyText).toBe("This invite is no longer valid.");
    const invite = inviteRow(inviteId);
    expect(invite.status).toBe("expired");
    expect(invite.useCount).toBe(0);
  });

  test("exhausted invite → max_uses_reached", async () => {
    seedContact("c1");
    const inviteId = seedInvite();
    // Exhaust the single use with a first redemption, then reset the sender's
    // gateway channel so the second attempt isn't gated as already_member.
    await redeemInviteByCode({ code: CODE, ...IDENTITY });
    getGatewayDb().delete(contactChannels).run();

    const result = await redeemInviteByCode({ code: CODE, ...IDENTITY });

    // The channel-scoped lookup only returns active invites, and the
    // exhausted row is status "redeemed" — the code no longer resolves.
    expect(result.status).toBe("no_match");
    expect(inviteRow(inviteId).useCount).toBe(1);
  });

  test("already-active member: already_member, NO use consumed", async () => {
    seedContact("c1");
    seedChannel({
      id: "ch-1",
      contactId: "c1",
      address: "U_SENDER",
      status: "active",
    });
    const inviteId = seedInvite();

    const result = await redeemInviteByCode({ code: CODE, ...IDENTITY });

    expect(result.status).toBe("already_member");
    if (result.status !== "already_member") throw new Error("unreachable");
    expect(result.replyText).toBe("You already have access.");
    expect(result.outcome.result).toBe("already_member");
    expect(inviteRow(inviteId).useCount).toBe(0);
    expect(inviteRow(inviteId).status).toBe("active");
  });

  test("blocked gateway channel is NEVER reactivated: generic failure, no use consumed", async () => {
    seedContact("c1");
    seedChannel({
      id: "ch-1",
      contactId: "c1",
      address: "U_SENDER",
      status: "blocked",
    });
    const inviteId = seedInvite();

    const result = await redeemInviteByCode({ code: CODE, ...IDENTITY });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.reason).toBe("invalid_token");
    expect(result.replyText).toBe("This invite is no longer valid.");
    expect(inviteRow(inviteId).useCount).toBe(0);
    expect(gwChannel("U_SENDER")?.status).toBe("blocked");
  });

  test("revoked gateway channel IS reactivated by an invite (allowRevokedReactivation)", async () => {
    seedContact("c1");
    seedChannel({
      id: "ch-1",
      contactId: "c1",
      address: "U_SENDER",
      status: "revoked",
    });
    const inviteId = seedInvite();

    const result = await redeemInviteByCode({ code: CODE, ...IDENTITY });

    expect(result.status).toBe("redeemed");
    expect(inviteRow(inviteId).useCount).toBe(1);
    expect(gwChannel("U_SENDER")?.status).toBe("active");
    expect(gwChannel("U_SENDER")?.verifiedVia).toBe("invite");
  });

  test("atomic double-redeem: two concurrent redemptions → exactly one success", async () => {
    seedContact("c1");
    const inviteId = seedInvite({ maxUses: 1 });

    const results = await Promise.all([
      redeemInviteByCode({ code: CODE, ...IDENTITY }),
      redeemInviteByCode({
        code: CODE,
        sourceChannel: CHANNEL,
        externalUserId: "U_OTHER",
        externalChatId: "chat-other",
      }),
    ]);

    // Whichever interleaving occurs, exactly one caller redeems; the loser
    // either loses the atomic claim (failed) or no longer resolves the
    // consumed code (no_match). Never two redemptions.
    const redeemed = results.filter((r) => r.status === "redeemed");
    expect(redeemed).toHaveLength(1);
    expect(inviteRow(inviteId).useCount).toBe(1);
  });

  test("atomic claim: the second of two claims on the same resolved invite is gated out", () => {
    seedContact("c1");
    const inviteId = seedInvite({ maxUses: 1 });
    const store = new ContactStore();

    // Both callers resolved the same active row (pre-claim state), then race
    // the status="active"-gated claim: only the first consumes it.
    const first = store.recordInviteRedemption({
      inviteId,
      redeemedByExternalUserId: "U_SENDER",
    });
    const second = store.recordInviteRedemption({
      inviteId,
      redeemedByExternalUserId: "U_OTHER",
    });

    expect(first.updated).toBe(true);
    expect(second.updated).toBe(false);
    expect(inviteRow(inviteId).useCount).toBe(1);
    expect(inviteRow(inviteId).redeemedByExternalUserId).toBe("U_SENDER");
  });

  test("no identity at all → missing_identity", async () => {
    seedContact("c1");
    seedInvite();

    const result = await redeemInviteByCode({
      code: CODE,
      sourceChannel: CHANNEL,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.reason).toBe("missing_identity");
  });
});

describe("redeemInviteByToken", () => {
  test("valid token redeems and activates the gateway channel", async () => {
    seedContact("c1");
    const inviteId = seedInvite();

    const result = await redeemInviteByToken({ rawToken: TOKEN, ...IDENTITY });

    expect(result.status).toBe("redeemed");
    expect(inviteRow(inviteId).useCount).toBe(1);
    expect(gwChannel("U_SENDER")?.status).toBe("active");
  });

  test("unknown token is a definitive invalid invite (no fall-through)", async () => {
    seedContact("c1");
    seedInvite();

    const result = await redeemInviteByToken({
      rawToken: "not-a-token",
      ...IDENTITY,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.reason).toBe("invalid_token");
    expect(result.replyText).toBe("This invite is no longer valid.");
  });

  test("revoked invite → revoked reason with the generic invalid reply", async () => {
    seedContact("c1");
    const inviteId = seedInvite();
    new ContactStore().revokeInvite(inviteId);

    const result = await redeemInviteByToken({ rawToken: TOKEN, ...IDENTITY });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.reason).toBe("revoked");
    expect(result.replyText).toBe("This invite is no longer valid.");
  });

  test("token minted for another channel → channel_mismatch, no use consumed", async () => {
    seedContact("c1");
    const inviteId = seedInvite({ sourceChannel: "whatsapp" });

    const result = await redeemInviteByToken({ rawToken: TOKEN, ...IDENTITY });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.reason).toBe("channel_mismatch");
    expect(inviteRow(inviteId).useCount).toBe(0);
  });
});
