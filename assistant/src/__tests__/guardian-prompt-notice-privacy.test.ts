/**
 * Where a guardian's own gated-tool prompt is delivered.
 *
 * The prompt is raised by a turn the guardian is having, and that turn can be
 * running in a shared room. The card carries the tool name, a preview of the
 * command and live Approve/Reject buttons, so addressing it to the room shows
 * all three to everyone in it and lets any of them press a button.
 *
 * Two things are asserted, and the second is the one a reader is likely to
 * drop. Redirecting the address without also moving the route sends a DM id
 * alongside the turn's channel coordinates, which the transport rejects; the
 * watcher retries a rejected send until the gated tool times out, so a broken
 * pairing reads as a hang rather than an error.
 */

import { describe, expect, test } from "bun:test";

import {
  resolveGuardianPromptDelivery,
  resolveRequesterDeliveryTarget,
} from "../approvals/guardian-channel-delivery.js";
import { channelForCallback } from "../messaging/providers/callback-routing.js";

import "./test-preload.js";

const SHARED_ROOM = "C0SHARED123";
const GUARDIAN_USER = "U0GUARDIAN1";
const TURN_CALLBACK = "/deliver/slack?threadTs=1787241637.779409";

describe("a guardian's prompt on a channel with a private route", () => {
  test("is addressed to the guardian, not to the room the turn is in", () => {
    const { chatId } = resolveGuardianPromptDelivery({
      channel: "slack",
      turnChatId: SHARED_ROOM,
      turnCallbackUrl: TURN_CALLBACK,
      guardianExternalUserId: GUARDIAN_USER,
    });

    expect(chatId).toBe(GUARDIAN_USER);
    // Stated on its own rather than left implied: an implementation that
    // returned the room would still satisfy a weaker "is a string" check.
    expect(chatId).not.toBe(SHARED_ROOM);
  });

  test("leaves the turn's channel coordinates behind with it", () => {
    const { callbackUrl } = resolveGuardianPromptDelivery({
      channel: "slack",
      turnChatId: SHARED_ROOM,
      turnCallbackUrl: TURN_CALLBACK,
      guardianExternalUserId: GUARDIAN_USER,
    });

    // A `threadTs` from the room, carried onto a DM send, asks Slack to
    // attach the message to a thread in a different channel.
    expect(callbackUrl).not.toContain("threadTs");
    expect(callbackUrl).toBe("/deliver/slack");
  });

  test("keeps Discord's dm marker, which is what makes a user id a person", () => {
    const { chatId, callbackUrl } = resolveGuardianPromptDelivery({
      channel: "discord",
      turnChatId: "guild-channel-1",
      turnCallbackUrl: "/deliver/discord",
      guardianExternalUserId: "snowflake-1",
    });

    expect(chatId).toBe("snowflake-1");
    expect(callbackUrl).toContain("dm=1");
    // The marked route must still resolve to the Discord transport; a failure
    // there is silent rather than loud.
    expect(channelForCallback(callbackUrl)).toBe("discord");
  });
});

describe("channels whose chat is already one-to-one", () => {
  test("keep both the address and the route the turn came in on", () => {
    for (const channel of ["telegram", "whatsapp"] as const) {
      expect(
        resolveGuardianPromptDelivery({
          channel,
          turnChatId: "chat-123",
          turnCallbackUrl: "/deliver/inbound-callback",
          guardianExternalUserId: GUARDIAN_USER,
        }),
      ).toEqual({
        chatId: "chat-123",
        callbackUrl: "/deliver/inbound-callback",
      });
    }
  });
});

describe("a turn with no resolved guardian identity", () => {
  test("falls back to the turn's own delivery rather than an empty address", () => {
    expect(
      resolveGuardianPromptDelivery({
        channel: "slack",
        turnChatId: SHARED_ROOM,
        turnCallbackUrl: TURN_CALLBACK,
        guardianExternalUserId: undefined,
      }),
    ).toEqual({ chatId: SHARED_ROOM, callbackUrl: TURN_CALLBACK });
  });
});

describe("the guardian prompt and the requester notice agree", () => {
  test("both address a user id on the channels that have one", () => {
    // One rule, two callers. If a channel is ever added to or removed from
    // `channelDeliversToUserId`, both move together or this fails.
    for (const channel of ["slack", "discord", "telegram", "whatsapp"]) {
      const { chatId } = resolveGuardianPromptDelivery({
        channel,
        turnChatId: "chat-1",
        turnCallbackUrl: "/deliver/inbound-callback",
        guardianExternalUserId: "user-1",
      });
      const requesterTarget = resolveRequesterDeliveryTarget({
        channel,
        requesterChatId: "chat-1",
        requesterExternalUserId: "user-1",
      });

      expect(chatId).toBe(requesterTarget);
    }
  });
});
