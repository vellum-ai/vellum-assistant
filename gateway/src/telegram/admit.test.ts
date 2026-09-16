import { describe, expect, test } from "bun:test";

import {
  admitTelegramMessage,
  type TelegramAdmissionCandidate,
  type TelegramAdmissionPolicy,
} from "./admit.js";
import "../__tests__/test-preload.js";

const BOT_ID = "123456789";
const HUMAN = "42";

const policy: TelegramAdmissionPolicy = {
  botUserId: BOT_ID,
  botUsername: "Vellum_Bot",
};

/** A supergroup message that would be admitted; tests spoil one field. */
function candidate(
  over: Partial<TelegramAdmissionCandidate> = {},
): TelegramAdmissionCandidate {
  return {
    chatType: "supergroup",
    authorId: HUMAN,
    authorIsBot: false,
    mentionedUsernames: ["vellum_bot"],
    mentionedUserIds: [],
    repliedToAuthorId: undefined,
    ...over,
  };
}

describe("admitTelegramMessage", () => {
  test("admits a room message that mentions the bot by username", () => {
    expect(admitTelegramMessage(candidate(), policy)).toEqual({
      admitted: true,
      botMentioned: true,
    });
  });

  test("username matching ignores the casing getMe reports", () => {
    // Telegram usernames are case-insensitive. The candidate's names arrive
    // lowercased by the normalizer; the policy carries whatever casing
    // `getMe` reported.
    expect(
      admitTelegramMessage(candidate(), {
        botUserId: BOT_ID,
        botUsername: "VELLUM_BOT",
      }).admitted,
    ).toBe(true);
  });

  test("admits a room message that names the bot with a text_mention", () => {
    expect(
      admitTelegramMessage(
        candidate({ mentionedUsernames: [], mentionedUserIds: [BOT_ID] }),
        policy,
      ),
    ).toEqual({ admitted: true, botMentioned: true });
  });

  test("admits a room reply to one of the bot's own posts", () => {
    expect(
      admitTelegramMessage(
        candidate({ mentionedUsernames: [], repliedToAuthorId: BOT_ID }),
        policy,
      ),
    ).toEqual({ admitted: true, botMentioned: true });
  });

  test("drops a room message that does not address the bot", () => {
    // This is the privacy-mode-off and admin-bot case: Telegram delivers
    // every message, and the gate is what keeps the assistant from answering
    // all of them.
    expect(
      admitTelegramMessage(candidate({ mentionedUsernames: [] }), policy),
    ).toEqual({ admitted: false, reason: "bot_not_mentioned" });
  });

  test("a mention of someone else is not a mention of the bot", () => {
    expect(
      admitTelegramMessage(
        candidate({
          mentionedUsernames: ["someone_else"],
          mentionedUserIds: ["99"],
          repliedToAuthorId: "99",
        }),
        policy,
      ),
    ).toEqual({ admitted: false, reason: "bot_not_mentioned" });
  });

  test("admits a private chat without a mention and states it was not named", () => {
    expect(
      admitTelegramMessage(
        candidate({ chatType: "private", mentionedUsernames: [] }),
        policy,
      ),
    ).toEqual({ admitted: true, botMentioned: false });
  });

  test("admits a plain group the same as a supergroup", () => {
    expect(
      admitTelegramMessage(candidate({ chatType: "group" }), policy).admitted,
    ).toBe(true);
  });

  test("refuses a channel post and an unknown chat type", () => {
    // A channel is a broadcast feed, not a room; nothing addresses one.
    expect(
      admitTelegramMessage(candidate({ chatType: "channel" }), policy),
    ).toEqual({ admitted: false, reason: "chat_not_supported" });
    expect(
      admitTelegramMessage(candidate({ chatType: undefined }), policy),
    ).toEqual({ admitted: false, reason: "chat_not_supported" });
  });

  test("drops every room message when the bot does not know who it is", () => {
    // Admitting on a guess would be admitting everything.
    expect(admitTelegramMessage(candidate(), {})).toEqual({
      admitted: false,
      reason: "bot_identity_unknown",
    });
  });

  test("with only the user id known, replies and text mentions still admit", () => {
    // The `getMe` fallback: the token names the id, not the username.
    const idOnly: TelegramAdmissionPolicy = { botUserId: BOT_ID };
    expect(admitTelegramMessage(candidate(), idOnly)).toEqual({
      admitted: false,
      reason: "bot_not_mentioned",
    });
    expect(
      admitTelegramMessage(
        candidate({ mentionedUsernames: [], repliedToAuthorId: BOT_ID }),
        idOnly,
      ).admitted,
    ).toBe(true);
  });

  test("drops the bot's own messages before anything else", () => {
    expect(
      admitTelegramMessage(
        candidate({ authorId: BOT_ID, chatType: "private" }),
        policy,
      ),
    ).toEqual({ admitted: false, reason: "self_authored" });
  });

  test("drops other bots even when they mention this one", () => {
    expect(
      admitTelegramMessage(candidate({ authorIsBot: true }), policy),
    ).toEqual({ admitted: false, reason: "bot_authored" });
  });
});
