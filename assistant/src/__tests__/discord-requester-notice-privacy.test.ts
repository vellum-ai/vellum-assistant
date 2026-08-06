/**
 * A Discord requester's guardian outcome notice must reach a DM, never the
 * guild channel the request came from.
 *
 * Discord's `conversationExternalId` is the parent channel snowflake, so a
 * request's `requesterChatId` *is* a public room. Addressing a notice there
 * publishes "your access request was declined" to everyone in the server,
 * which is worse than the silence the channel had before it could deliver at
 * all. Slack keeps the same notice private with `chat.postEphemeral`; Discord
 * has no equivalent outside an interaction response, so its only private route
 * is a DM and both notice paths must take it.
 */

import { describe, expect, test } from "bun:test";

import {
  resolveDeliverCallbackUrlForChannel,
  resolveRequesterDeliveryTarget,
} from "../approvals/guardian-channel-delivery.js";
import { channelForCallback } from "../messaging/providers/callback-routing.js";

import "./test-preload.js";

/** The public guild channel a request originated in. */
const GUILD_CHANNEL = "700000000000000001";
/** The requester's own user snowflake. */
const REQUESTER = "900000000000000042";

describe("resolveRequesterDeliveryTarget", () => {
  test("Discord addresses the requester, not the room they asked in", () => {
    expect(
      resolveRequesterDeliveryTarget({
        channel: "discord",
        requesterChatId: GUILD_CHANNEL,
        requesterExternalUserId: REQUESTER,
      }),
    ).toBe(REQUESTER);
  });

  test("the resolved target is never the originating conversation", () => {
    // The invariant stated as the failure shape rather than as an equality:
    // any future change that lets the guild channel through fails here.
    const target = resolveRequesterDeliveryTarget({
      channel: "discord",
      requesterChatId: GUILD_CHANNEL,
      requesterExternalUserId: REQUESTER,
    });
    expect(target).not.toBe(GUILD_CHANNEL);
  });

  test("Slack keeps its existing user-id targeting", () => {
    expect(
      resolveRequesterDeliveryTarget({
        channel: "slack",
        requesterChatId: "C0123456789",
        requesterExternalUserId: "U0123456789",
      }),
    ).toBe("U0123456789");
  });

  test("Telegram and WhatsApp still deliver to the chat id", () => {
    // Their conversation address already is the private one-to-one chat, so
    // redirecting them to a user id would break delivery rather than fix it.
    for (const channel of ["telegram", "whatsapp"]) {
      expect(
        resolveRequesterDeliveryTarget({
          channel,
          requesterChatId: "555001",
          requesterExternalUserId: "555001-user",
        }),
      ).toBe("555001");
    }
  });

  test("falls back to the chat id when no requester user id is known", () => {
    // A request with no actor identity has nobody to open a DM with. Falling
    // back keeps the other channels working; Discord's own route is unusable
    // in that state and the transport surfaces it as a delivery failure.
    expect(
      resolveRequesterDeliveryTarget({
        channel: "discord",
        requesterChatId: GUILD_CHANNEL,
        requesterExternalUserId: "",
      }),
    ).toBe(GUILD_CHANNEL);
  });
});

describe("resolveDeliverCallbackUrlForChannel", () => {
  test("Discord's route carries the dm marker", () => {
    // Without it the transport reads chatId as a channel snowflake and posts
    // the notice to whatever channel shares that id.
    expect(resolveDeliverCallbackUrlForChannel("discord")).toBe(
      "/deliver/discord?dm=1",
    );
  });

  test("the marked route still resolves to the Discord transport", () => {
    // `channelForCallback` parses a pathname, and this URL is base-less, so it
    // takes the query-stripped fallback. If that ever regressed, the notice
    // would fall through to the HTTP proxy, which cannot fetch a base-less
    // URL, and the delivery would vanish rather than error.
    expect(channelForCallback("/deliver/discord?dm=1")).toBe("discord");
  });

  test("other channels' routes are unchanged", () => {
    expect(resolveDeliverCallbackUrlForChannel("slack")).toBe("/deliver/slack");
    expect(resolveDeliverCallbackUrlForChannel("telegram")).toBe(
      "/deliver/telegram",
    );
    expect(resolveDeliverCallbackUrlForChannel("whatsapp")).toBe(
      "/deliver/whatsapp",
    );
    expect(resolveDeliverCallbackUrlForChannel("email")).toBeNull();
    expect(resolveDeliverCallbackUrlForChannel("vellum")).toBeNull();
  });
});
