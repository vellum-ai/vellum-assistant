/**
 * Where a guardian's own gated-tool prompt is delivered.
 *
 * The prompt is raised by a turn the guardian is having, and on Slack that
 * turn can be running in a shared room. The card carries the tool name, a
 * preview of the command and live Approve/Reject buttons, so posting it there
 * shows all three to everyone in the room and lets any of them decide.
 *
 * Three things are asserted, and the last two are the ones easy to drop:
 *
 * - the address is the guardian's DM, not the room;
 * - it is the DM's *chat id*, because that address is written to the delivery
 *   row and read back to match reactions, scope plain-text replies and edit
 *   the decided card, and those readers compare against the DM the guardian's
 *   replies arrive on;
 * - the turn's `threadTs` does not travel with it, since a thread in the room
 *   does not exist in the DM.
 */

import { describe, expect, test } from "bun:test";

import { resolveGuardianPromptDelivery } from "../approvals/guardian-channel-delivery.js";
import { isSlackDmChatId } from "../messaging/providers/slack/conversation-utils.js";

import "./test-preload.js";

const SHARED_ROOM = "C0SHARED123";
const GUARDIAN_DM = "D0GUARDIANDM";
const TURN_CALLBACK =
  "https://gw.test/deliver/slack?threadTs=1787241637.779409";

describe("a guardian's prompt raised in a shared Slack channel", () => {
  const delivery = resolveGuardianPromptDelivery({
    channel: "slack",
    turnChatId: SHARED_ROOM,
    turnCallbackUrl: TURN_CALLBACK,
    guardianChatId: GUARDIAN_DM,
  });

  test("is addressed to the guardian's DM, not the room", () => {
    expect(delivery?.chatId).toBe(GUARDIAN_DM);
    expect(delivery?.chatId).not.toBe(SHARED_ROOM);
  });

  test("is addressed by chat id, the form the delivery row is read back as", () => {
    // A user id would also open the DM on send, and would then fail every
    // reader that compares this value against the DM the guardian replies
    // from. Asserting the shape catches that substitution.
    expect(isSlackDmChatId(delivery!.chatId)).toBe(true);
  });

  test("leaves the room's thread behind", () => {
    expect(delivery?.callbackUrl).not.toContain("threadTs");
  });
});

describe("a guardian's prompt raised in their own DM", () => {
  test("stays exactly where the turn is, thread and all", () => {
    const turnCallback = "https://gw.test/deliver/slack?threadTs=111.222";
    expect(
      resolveGuardianPromptDelivery({
        channel: "slack",
        turnChatId: GUARDIAN_DM,
        turnCallbackUrl: turnCallback,
        guardianChatId: GUARDIAN_DM,
      }),
    ).toEqual({ chatId: GUARDIAN_DM, callbackUrl: turnCallback });
  });
});

describe("a guardian with no DM to reach", () => {
  test("gets nothing on the channel rather than a prompt in the room", () => {
    // An `app_mention` binding names a shared channel, so a bound chat is not
    // private by construction. Falling back to the turn's chat here would
    // reinstate exactly the disclosure this addressing exists to prevent.
    for (const guardianChatId of [undefined, SHARED_ROOM, "G0LEGACYGROUP"]) {
      expect(
        resolveGuardianPromptDelivery({
          channel: "slack",
          turnChatId: SHARED_ROOM,
          turnCallbackUrl: TURN_CALLBACK,
          guardianChatId,
        }),
      ).toBeNull();
    }
  });
});

describe("channels other than Slack", () => {
  test("are unchanged, including the Telegram group case this does not cover", () => {
    for (const channel of ["telegram", "whatsapp", "discord"] as const) {
      expect(
        resolveGuardianPromptDelivery({
          channel,
          turnChatId: "group-chat-1",
          turnCallbackUrl: "https://gw.test/deliver/x?threadTs=9",
          guardianChatId: "guardian-chat-1",
        }),
      ).toEqual({
        chatId: "group-chat-1",
        callbackUrl: "https://gw.test/deliver/x?threadTs=9",
      });
    }
  });
});
