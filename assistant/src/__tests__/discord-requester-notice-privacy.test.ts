/**
 * The two things about Discord's requester-notice addressing that a
 * behavioural test cannot reach.
 *
 * Whether a Discord notice actually stays out of the guild channel is asserted
 * end to end against the real resolver in `discord-access-request-privacy.test.ts`.
 * What that test cannot see is (a) whether the marked route still resolves to
 * the Discord transport at all, since a failure there is silent rather than
 * loud, and (b) whether adding Discord changed the answer for every other
 * channel that shares the helper.
 */

import { describe, expect, test } from "bun:test";

import {
  resolveDeliverCallbackUrlForChannel,
  resolveRequesterDeliveryTarget,
} from "../approvals/guardian-channel-delivery.js";
import { channelForCallback } from "../messaging/providers/callback-routing.js";

import "./test-preload.js";

describe("the dm-marked Discord route", () => {
  test("still resolves to the Discord transport", () => {
    // `channelForCallback` parses a pathname, and this URL is base-less, so
    // `new URL` throws and it takes the query-stripped fallback. If that
    // regressed, the notice would fall through to the HTTP proxy, which cannot
    // fetch a base-less URL: the delivery would vanish rather than error, and
    // every behavioural assertion about where it landed would still pass.
    expect(
      channelForCallback(resolveDeliverCallbackUrlForChannel("discord")!),
    ).toBe("discord");
  });
});

describe("adding Discord leaves the other channels alone", () => {
  test("their deliver routes are unchanged", () => {
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

  test("Slack still targets the requester's user id", () => {
    expect(
      resolveRequesterDeliveryTarget({
        channel: "slack",
        requesterChatId: "C0123456789",
        requesterExternalUserId: "U0123456789",
      }),
    ).toBe("U0123456789");
  });

  test("Telegram and WhatsApp still target the chat id", () => {
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
});

describe("a request with no actor identity", () => {
  test("falls back to the chat id rather than addressing an empty user", () => {
    // Nobody to open a DM with. Falling back keeps the other channels working;
    // on Discord the transport reports the failure instead of posting to the
    // room, which is the safe direction.
    expect(
      resolveRequesterDeliveryTarget({
        channel: "discord",
        requesterChatId: "700000000000000001",
        requesterExternalUserId: "",
      }),
    ).toBe("700000000000000001");
  });
});
