import { describe, expect, test } from "bun:test";

import {
  admitRoomMessage,
  type RoomAdmissionCandidate,
} from "./room-admission.js";
import "../__tests__/test-preload.js";

/** A room message that would be admitted; tests spoil one field. */
function candidate(
  over: Partial<RoomAdmissionCandidate> = {},
): RoomAdmissionCandidate {
  return {
    authorIsSelf: false,
    authorIsBot: false,
    isDirectChat: false,
    chatSupported: true,
    roomAllowed: true,
    addressesBot: true,
    ...over,
  };
}

describe("admitRoomMessage", () => {
  test("admits a room message that addresses the bot", () => {
    expect(admitRoomMessage(candidate())).toEqual({
      admitted: true,
      botMentioned: true,
    });
  });

  test("drops the bot's own messages before anything else", () => {
    // Even in a direct chat: the DM lane runs after the self and bot checks,
    // not around them.
    expect(
      admitRoomMessage(candidate({ authorIsSelf: true, isDirectChat: true })),
    ).toEqual({ admitted: false, reason: "self_authored" });
  });

  test("drops other bots even when they address this one", () => {
    expect(admitRoomMessage(candidate({ authorIsBot: true }))).toEqual({
      admitted: false,
      reason: "bot_authored",
    });
  });

  test("admits a direct chat without a mention and says whether one was typed", () => {
    expect(
      admitRoomMessage(candidate({ isDirectChat: true, addressesBot: false })),
    ).toEqual({ admitted: true, botMentioned: false });
    expect(
      admitRoomMessage(candidate({ isDirectChat: true, addressesBot: true })),
    ).toEqual({ admitted: true, botMentioned: true });
  });

  test("a direct chat is admitted even when the bot's identity is unknown", () => {
    // Nothing to recognise: the chat is addressed to the bot by construction.
    expect(
      admitRoomMessage(
        candidate({ isDirectChat: true, addressesBot: undefined }),
      ),
    ).toEqual({ admitted: true, botMentioned: false });
  });

  test("refuses a chat kind the product does not serve", () => {
    expect(admitRoomMessage(candidate({ chatSupported: false }))).toEqual({
      admitted: false,
      reason: "chat_not_supported",
    });
  });

  test("drops a room the operator fenced off, before the mention check", () => {
    expect(admitRoomMessage(candidate({ roomAllowed: false }))).toEqual({
      admitted: false,
      reason: "room_not_allowed",
    });
  });

  test("drops every room message when the bot does not know who it is", () => {
    // Admitting on a guess would be admitting everything.
    expect(admitRoomMessage(candidate({ addressesBot: undefined }))).toEqual({
      admitted: false,
      reason: "bot_identity_unknown",
    });
  });

  test("drops a room message that does not address the bot", () => {
    // The ordinary case in a busy room, and the one that decides whether the
    // assistant processes a firehose or a handful of requests.
    expect(admitRoomMessage(candidate({ addressesBot: false }))).toEqual({
      admitted: false,
      reason: "bot_not_mentioned",
    });
  });
});
