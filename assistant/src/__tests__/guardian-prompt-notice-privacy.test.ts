/**
 * Where a guardian's own gated-tool prompt is delivered.
 *
 * The prompt is raised by a turn the guardian is having, and that turn can be
 * running in a room: a shared Slack channel, a Telegram group. The card
 * carries the tool name and a preview of the command, so delivering it where
 * the turn is shows both to everyone there. It goes to the guardian's own
 * bound chat instead.
 *
 * The address is only half of it. A callback URL addresses the turn it came
 * from, and a param left on one either fails the send or wins over the new
 * address outright, which is indistinguishable from never having redirected.
 * The assertions below are written against params the transports read today
 * *and* against one nothing reads, because the guarantee is that everything is
 * dropped rather than that a known list is.
 */

import { describe, expect, test } from "bun:test";

import {
  resolveGuardianPromptDelivery,
  stripTurnDestination,
} from "../approvals/guardian-channel-delivery.js";

import "./test-preload.js";

const ROOM = "C0SHARED123";
const GUARDIAN_CHAT = "D0GUARDIANDM";

describe("a prompt raised where the guardian is not alone", () => {
  test("is addressed to the guardian's own chat", () => {
    expect(
      resolveGuardianPromptDelivery({
        turnChatId: ROOM,
        turnCallbackUrl: "https://gw.test/deliver/slack",
        guardianChatId: GUARDIAN_CHAT,
      }).chatId,
    ).toBe(GUARDIAN_CHAT);
  });

  test("applies to any channel, including ones not built yet", () => {
    // A Telegram group carries the same exposure as a shared Slack channel,
    // and so will whatever is added next. The rule names no channel, so there
    // is no per-channel list to keep in step with the transports.
    for (const [turnChatId, guardianChatId] of [
      ["-1001234567890", "555001"],
      ["guild-channel-1", "dm-channel-1"],
      ["room@some-future-channel", "direct@some-future-channel"],
    ]) {
      expect(
        resolveGuardianPromptDelivery({
          turnChatId,
          turnCallbackUrl: "https://gw.test/deliver/whatever",
          guardianChatId,
        }).chatId,
      ).toBe(guardianChatId);
    }
  });
});

describe("a prompt raised in the guardian's own chat", () => {
  const turnCallbackUrl = "https://gw.test/deliver/slack?threadTs=111.222";

  test("does not move, and keeps the turn's callback intact", () => {
    expect(
      resolveGuardianPromptDelivery({
        turnChatId: GUARDIAN_CHAT,
        turnCallbackUrl,
        guardianChatId: GUARDIAN_CHAT,
      }),
    ).toEqual({ chatId: GUARDIAN_CHAT, callbackUrl: turnCallbackUrl });
  });

  test("does not move when no binding resolved", () => {
    // The trust context falls back to the turn's own chat, so this is the same
    // comparison as above: delivery is left exactly as it is today rather than
    // dropped on the floor.
    expect(
      resolveGuardianPromptDelivery({
        turnChatId: ROOM,
        turnCallbackUrl,
        guardianChatId: undefined,
      }),
    ).toEqual({ chatId: ROOM, callbackUrl: turnCallbackUrl });
  });
});

describe("a redirected delivery leaves the turn behind entirely", () => {
  const redirected = (turnCallbackUrl: string) =>
    resolveGuardianPromptDelivery({
      turnChatId: ROOM,
      turnCallbackUrl,
      guardianChatId: GUARDIAN_CHAT,
    }).callbackUrl;

  test("drops params the transports read today", () => {
    // threadTs: Slack's thread, absent from the new chat.
    // threadId: a Telegram forum topic, and on Discord the destination itself
    // (`sendTarget` returns it in place of the chatId).
    // dm: changes how Discord reads the address.
    // channel: the turn's own chat, which the gateway hangs on every Slack
    // callback.
    expect(
      redirected(
        "https://gw.test/deliver/slack?channel=C1&threadTs=1.2&threadId=9&dm=1&messageTs=3.4",
      ),
    ).toBe("https://gw.test/deliver/slack");
  });

  test("drops a param nothing reads, which is the actual guarantee", () => {
    // If this only dropped a known list, a transport that starts reading a new
    // param would silently undo the redirect and no test would notice. The
    // contract is that the callback keeps its channel and nothing else.
    expect(redirected("https://gw.test/deliver/x?roomId=42")).toBe(
      "https://gw.test/deliver/x",
    );
  });

  test("keeps the channel, which is how the transport is resolved", () => {
    // `isDirectDelivery` picks a transport off the path, so the path has to
    // survive for the redirect to be deliverable at all.
    expect(redirected("https://gw.test/deliver/telegram?threadId=7")).toContain(
      "/deliver/telegram",
    );
  });
});

describe("stripTurnDestination", () => {
  test("returns relative or malformed urls untouched", () => {
    // They carry no params, and `new URL` throws on them.
    expect(stripTurnDestination("/deliver/slack")).toBe("/deliver/slack");
  });
});
