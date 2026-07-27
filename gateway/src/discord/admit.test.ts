import { describe, expect, test } from "bun:test";

import {
  admitDiscordMessage,
  parseAllowedChannelIds,
  type AdmissionCandidate,
  type AdmissionPolicy,
} from "./admit.js";
import "../__tests__/test-preload.js";

const BOT = "900000000000000001";
const HUMAN = "900000000000000002";
const ALLOWED_CHANNEL = "800000000000000001";
const OTHER_CHANNEL = "800000000000000002";
const GUILD = "700000000000000001";

const policy: AdmissionPolicy = {
  botUserId: BOT,
  allowedChannelIds: new Set([ALLOWED_CHANNEL]),
};

/** A message that would be admitted; individual tests spoil one field. */
function candidate(over: Partial<AdmissionCandidate> = {}): AdmissionCandidate {
  return {
    channelId: ALLOWED_CHANNEL,
    guildId: GUILD,
    authorId: HUMAN,
    mentionedUserIds: [BOT],
    ...over,
  };
}

describe("admitDiscordMessage", () => {
  test("admits a direct mention from a human in an allow-listed channel", () => {
    expect(admitDiscordMessage(candidate(), policy)).toEqual({
      admitted: true,
    });
  });

  test("drops the bot's own messages before anything else", () => {
    // Self-authored messages arrive back over the same socket; forwarding one
    // is how a reply loop starts.
    const verdict = admitDiscordMessage(
      candidate({ authorId: BOT, mentionedUserIds: [BOT] }),
      policy,
    );
    expect(verdict).toEqual({ admitted: false, reason: "self_authored" });
  });

  test("drops other bots and webhooks", () => {
    const verdict = admitDiscordMessage(
      candidate({ authorIsBot: true }),
      policy,
    );
    expect(verdict).toEqual({ admitted: false, reason: "bot_authored" });
  });

  test("drops DMs — they match no entry on a guild-channel allow-list", () => {
    const verdict = admitDiscordMessage(
      candidate({ guildId: undefined }),
      policy,
    );
    expect(verdict).toEqual({ admitted: false, reason: "not_a_guild_message" });
  });

  test("drops a mention in a channel that is not allow-listed", () => {
    const verdict = admitDiscordMessage(
      candidate({ channelId: OTHER_CHANNEL }),
      policy,
    );
    expect(verdict).toEqual({ admitted: false, reason: "channel_not_allowed" });
  });

  test("drops an un-mentioned message in an allow-listed channel", () => {
    // The ordinary case in a busy community channel, and the one that decides
    // whether the assistant processes a firehose or a handful of requests.
    const verdict = admitDiscordMessage(
      candidate({ mentionedUserIds: [] }),
      policy,
    );
    expect(verdict).toEqual({ admitted: false, reason: "bot_not_mentioned" });
  });

  test("drops a message with no mentions field at all", () => {
    const verdict = admitDiscordMessage(
      candidate({ mentionedUserIds: undefined }),
      policy,
    );
    expect(verdict).toEqual({ admitted: false, reason: "bot_not_mentioned" });
  });

  test("does not treat @everyone as a mention of the bot", () => {
    // The highest-cost false admit: every announcement in an allow-listed
    // channel would reach the assistant.
    const verdict = admitDiscordMessage(
      candidate({ mentionedUserIds: [], mentionsEveryone: true }),
      policy,
    );
    expect(verdict).toEqual({ admitted: false, reason: "bot_not_mentioned" });
  });

  test("does not treat a mention of someone else as a mention of the bot", () => {
    const verdict = admitDiscordMessage(
      candidate({ mentionedUserIds: ["900000000000000003"] }),
      policy,
    );
    expect(verdict).toEqual({ admitted: false, reason: "bot_not_mentioned" });
  });

  test("an empty allow-list admits nothing", () => {
    // Fail-closed: being invited to a guild is not consent to every channel
    // in it, so an unconfigured list must not read as "all channels".
    const verdict = admitDiscordMessage(candidate(), {
      botUserId: BOT,
      allowedChannelIds: new Set(),
    });
    expect(verdict).toEqual({ admitted: false, reason: "channel_not_allowed" });
  });
});

describe("parseAllowedChannelIds", () => {
  test("parses a comma-separated list, trimming entries", () => {
    expect(
      parseAllowedChannelIds(` ${ALLOWED_CHANNEL} , ${OTHER_CHANNEL} `),
    ).toEqual(new Set([ALLOWED_CHANNEL, OTHER_CHANNEL]));
  });

  test("yields an empty set for undefined, blank, and comma-only values", () => {
    expect(parseAllowedChannelIds(undefined)).toEqual(new Set());
    expect(parseAllowedChannelIds("")).toEqual(new Set());
    expect(parseAllowedChannelIds("   ")).toEqual(new Set());
    expect(parseAllowedChannelIds(",,")).toEqual(new Set());
  });

  test("drops blanks rather than admitting an empty-string channel", () => {
    expect(parseAllowedChannelIds(`${ALLOWED_CHANNEL},,`)).toEqual(
      new Set([ALLOWED_CHANNEL]),
    );
  });
});
