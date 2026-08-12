/**
 * Nothing a Discord access-request decision sends may land in the guild
 * channel the request came from.
 *
 * Two things travel on this path and both are meant for exactly one person: a
 * decision notice, and a 6-digit verification code. Discord has no ephemeral
 * message outside an interaction response, so anything posted back into the
 * room is readable by every member of the server. That makes the code the
 * sharper case: it is a live secret, and a `mint_outbound_session` is bound to
 * the requester's account, so publishing it hands anyone watching a ten-minute
 * window to spend it before the requester does.
 *
 * The assertions below are written as the failure shape rather than as
 * expected addresses. A test that checks "the notice went to the user id"
 * keeps passing when a *second* delivery is added that also posts to the
 * channel; a test that checks no delivery anywhere carries the guild channel
 * or the secret on a non-DM route does not.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

const emitSignalCalls: Array<Record<string, unknown>> = [];
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitSignalCalls.push(params);
    return {
      signalId: "mock-signal-id",
      deduplicated: false,
      dispatched: true,
      reason: "mock",
      deliveryResults: [],
    };
  },
}));

const deliverReplyCalls: Array<{
  url: string;
  payload: Record<string, unknown>;
}> = [];
mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (
    url: string,
    payload: Record<string, unknown>,
  ) => {
    deliverReplyCalls.push({ url, payload });
  },
}));

const withdrawCalls: Array<Record<string, unknown>> = [];
mock.module("../approvals/guardian-card-withdrawal.js", () => ({
  withdrawGuardianRequestCards: async (params: Record<string, unknown>) => {
    withdrawCalls.push(params);
  },
}));

import { createGuardianGatewaySim } from "./guardian-gateway-sim.js";

const sim = createGuardianGatewaySim();
mock.module("../channels/gateway-guardian-requests.js", () => sim.module);

import { applyGuardianDecision } from "../approvals/guardian-decision-primitive.js";
import type { ActorContext } from "../approvals/guardian-request-resolvers.js";
import { initializeDb } from "../persistence/db-init.js";
import { serializeRequesterSignals } from "../runtime/introduction-policy.js";

await initializeDb();

const TEST_PRINCIPAL_ID = "guardian-principal";

/** The public guild channel the request came from. */
const GUILD_CHANNEL = "700000000000000001";
/** The requester's own user snowflake. */
const REQUESTER = "900000000000000042";
/** The guardian's own user snowflake, when they decide from Discord. */
const GUARDIAN = "900000000000000007";

/**
 * The reply callback a Discord inbound carries: it addresses the guild
 * channel, which is precisely why a decision must not use it.
 */
const GUILD_REPLY_CALLBACK =
  "http://127.0.0.1:7830/deliver/discord?threadId=700000000000000055";

function resetState(): void {
  sim.reset();
  emitSignalCalls.length = 0;
  deliverReplyCalls.length = 0;
  withdrawCalls.length = 0;
}

function desktopGuardian(): ActorContext {
  return {
    actorPrincipalId: TEST_PRINCIPAL_ID,
    actorExternalUserId: undefined,
    channel: "vellum",
    guardianPrincipalId: TEST_PRINCIPAL_ID,
  };
}

/** A guardian who decided from Telegram about a Discord requester. */
function telegramGuardian(): ActorContext {
  return {
    actorPrincipalId: TEST_PRINCIPAL_ID,
    actorExternalUserId: "telegram-guardian-1",
    channel: "telegram",
    guardianPrincipalId: TEST_PRINCIPAL_ID,
  };
}

/** A guardian who decided by replying in the Discord guild channel. */
function discordGuardian(): ActorContext {
  return {
    actorPrincipalId: TEST_PRINCIPAL_ID,
    actorExternalUserId: GUARDIAN,
    channel: "discord",
    guardianPrincipalId: TEST_PRINCIPAL_ID,
  };
}

function makeDiscordAccessRequest() {
  return sim.seedRequest({
    kind: "access_request",
    sourceChannel: "discord",
    sourceConversationId: "access-req-conv",
    requesterExternalUserId: REQUESTER,
    requesterChatId: GUILD_CHANNEL,
    guardianPrincipalId: TEST_PRINCIPAL_ID,
    toolName: "ingress_access_request",
    requesterSignals: serializeRequesterSignals({ isStranger: true }),
    expiresAt: Date.now() + 60_000,
  });
}

/** Every chatId any delivery was addressed to. */
function deliveredChatIds(): string[] {
  return deliverReplyCalls.map((c) => String(c.payload.chatId ?? ""));
}

/**
 * Whether a delivery went out on a route that resolves to a DM.
 *
 * `dm=1` is the marker the Discord transport reads to treat `chatId` as a
 * recipient to open a DM with rather than a channel to post in, so a delivery
 * without it is a delivery into a room.
 */
function isDmRoute(url: string): boolean {
  return url.includes("dm=1");
}

describe("Discord access-request decisions stay out of the guild channel", () => {
  beforeEach(() => resetState());

  test("an on-channel approval never posts the code or the notice to the room", async () => {
    const req = makeDiscordAccessRequest();

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "verify_code",
      actorContext: discordGuardian(),
      channelDeliveryContext: {
        replyCallbackUrl: GUILD_REPLY_CALLBACK,
        guardianChatId: GUILD_CHANNEL,
        assistantId: "asst-test",
      },
    });

    expect(result.applied).toBe(true);
    const secret = sim.state.mintedSecret;
    expect(secret).toBeTruthy();

    // Nothing was addressed to the room.
    expect(deliveredChatIds()).not.toContain(GUILD_CHANNEL);

    // Nothing carrying the secret travelled on a non-DM route. This is the
    // assertion that fails if the in-band reply context is ever used again:
    // the guild callback carries no `dm=1`.
    for (const call of deliverReplyCalls) {
      const text = String(call.payload.text ?? "");
      if (text.includes(secret)) {
        expect(isDmRoute(call.url)).toBe(true);
      }
    }

    // The guardian who approved still gets their copy of the code. Without
    // this they would approve and never receive the thing they approved.
    const guardianCode = deliverReplyCalls.find(
      (c) =>
        c.payload.chatId === GUARDIAN &&
        String(c.payload.text ?? "").includes(secret),
    );
    expect(guardianCode).toBeDefined();
    expect(isDmRoute(guardianCode?.url ?? "")).toBe(true);

    // And the requester is told, on a DM route.
    const requesterNotice = deliverReplyCalls.find(
      (c) => c.payload.chatId === REQUESTER,
    );
    expect(requesterNotice).toBeDefined();
    expect(isDmRoute(requesterNotice?.url ?? "")).toBe(true);
  });

  test("a desktop approval reaches the requester rather than failing silently", async () => {
    // The regression the DM route introduced: the deliver URL says `dm=1`, so
    // passing the guild channel as chatId asks Discord to open a DM with a
    // channel. That call fails and the requester is never told.
    const req = makeDiscordAccessRequest();

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "verify_code",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    expect(deliveredChatIds()).not.toContain(GUILD_CHANNEL);

    const requesterDelivery = deliverReplyCalls.find(
      (c) => c.payload.chatId === REQUESTER,
    );
    expect(requesterDelivery).toBeDefined();
    expect(isDmRoute(requesterDelivery?.url ?? "")).toBe(true);
  });

  test("an on-channel denial never posts to the room", async () => {
    const req = makeDiscordAccessRequest();

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "block",
      actorContext: discordGuardian(),
      channelDeliveryContext: {
        replyCallbackUrl: GUILD_REPLY_CALLBACK,
        guardianChatId: GUILD_CHANNEL,
        assistantId: "asst-test",
      },
    });

    expect(result.applied).toBe(true);
    expect(deliveredChatIds()).not.toContain(GUILD_CHANNEL);

    const requesterNotice = deliverReplyCalls.find(
      (c) => c.payload.chatId === REQUESTER,
    );
    expect(requesterNotice).toBeDefined();
    expect(isDmRoute(requesterNotice?.url ?? "")).toBe(true);
  });

  test("a guardian on another channel still gets their copy of the code", async () => {
    // The requester's route is suppressed because a Discord guild channel has
    // no one reader; the guardian's is not, because theirs is a private
    // Telegram chat. Suppressing both would leave the guardian with no
    // confirmation and no code, so the approval would read as a no-op.
    const req = makeDiscordAccessRequest();
    const TELEGRAM_CALLBACK = "http://127.0.0.1:7830/deliver/telegram";

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "verify_code",
      actorContext: telegramGuardian(),
      channelDeliveryContext: {
        replyCallbackUrl: TELEGRAM_CALLBACK,
        guardianChatId: "telegram-chat-1",
        assistantId: "asst-test",
      },
    });

    expect(result.applied).toBe(true);
    const secret = sim.state.mintedSecret;

    const guardianCode = deliverReplyCalls.find(
      (c) =>
        c.payload.chatId === "telegram-chat-1" &&
        String(c.payload.text ?? "").includes(secret),
    );
    expect(guardianCode).toBeDefined();
    // Their code goes to their own channel, never the requester's transport.
    expect(guardianCode?.url).toBe(TELEGRAM_CALLBACK);

    // The requester is still reached privately, on Discord's own route.
    const requesterDelivery = deliverReplyCalls.find(
      (c) => c.payload.chatId === REQUESTER,
    );
    expect(requesterDelivery).toBeDefined();
    expect(isDmRoute(requesterDelivery?.url ?? "")).toBe(true);
    expect(deliveredChatIds()).not.toContain(GUILD_CHANNEL);
  });

  test("the requester gets the code itself, now that a DM reply is heard", async () => {
    // The DM ingress lane lands with this change, so a code sent with "reply
    // with it here" can actually be answered. Before the lane existed the
    // requester got a courier notice instead, because a code they could not
    // spend is worse than one the guardian relays.
    const req = makeDiscordAccessRequest();

    const result = await applyGuardianDecision({
      requestId: req.id,
      action: "verify_code",
      actorContext: desktopGuardian(),
    });

    expect(result.applied).toBe(true);
    const secret = sim.state.mintedSecret;

    const codeToRequester = deliverReplyCalls.find(
      (c) =>
        c.payload.chatId === REQUESTER &&
        String(c.payload.text ?? "").includes(secret),
    );
    expect(codeToRequester).toBeDefined();
    // Still only ever on the DM route.
    expect(isDmRoute(codeToRequester?.url ?? "")).toBe(true);
    expect(deliveredChatIds()).not.toContain(GUILD_CHANNEL);
  });

  test("a denial still records the guardian-facing lifecycle signal", async () => {
    // The signal used to be gated on the in-band reply context, which the
    // per-reader suppression removes for Discord. Losing it would mean a
    // Discord denial left no record for the guardian at all.
    const req = makeDiscordAccessRequest();

    await applyGuardianDecision({
      requestId: req.id,
      action: "block",
      actorContext: discordGuardian(),
      channelDeliveryContext: {
        replyCallbackUrl: GUILD_REPLY_CALLBACK,
        guardianChatId: GUILD_CHANNEL,
        assistantId: "asst-test",
      },
    });

    const decisionSignals = emitSignalCalls.filter(
      (c) => c.sourceEventName === "ingress.trusted_contact.guardian_decision",
    );
    expect(decisionSignals).toHaveLength(1);
  });

  test("no Discord delivery is ever addressed to the originating conversation", async () => {
    // The umbrella invariant, swept across every decision this resolver takes,
    // so a newly added action cannot quietly reintroduce the leak.
    for (const action of [
      "verify_code",
      "block",
      "leave_unverified",
    ] as const) {
      resetState();
      const req = makeDiscordAccessRequest();

      await applyGuardianDecision({
        requestId: req.id,
        action,
        actorContext: discordGuardian(),
        channelDeliveryContext: {
          replyCallbackUrl: GUILD_REPLY_CALLBACK,
          guardianChatId: GUILD_CHANNEL,
          assistantId: "asst-test",
        },
      });

      expect(deliveredChatIds()).not.toContain(GUILD_CHANNEL);
      for (const call of deliverReplyCalls) {
        expect(isDmRoute(call.url)).toBe(true);
      }
    }
  });
});
