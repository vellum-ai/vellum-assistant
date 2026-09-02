import { describe, expect, test } from "bun:test";

import {
  admitDiscordMessage,
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
  test("admits a direct mention from a human in a guild channel", () => {
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

  test("admits a DM without a mention", () => {
    // A DM is already addressed to the bot alone, so neither guild check
    // applies: it sits in no listable channel and needs no mention to be
    // meant for the bot. This is the lane a verification code answers on.
    const verdict = admitDiscordMessage(
      candidate({
        guildId: undefined,
        channelId: "800000000000000009",
        mentionedUserIds: [],
      }),
      policy,
    );
    expect(verdict).toEqual({ admitted: true });
  });

  test("drops the bot's own DM echo", () => {
    // The DM lane runs after the self and bot checks, not around them.
    const verdict = admitDiscordMessage(
      candidate({ guildId: undefined, authorId: BOT }),
      policy,
    );
    expect(verdict).toEqual({ admitted: false, reason: "self_authored" });
  });

  test("drops another bot's DM", () => {
    const verdict = admitDiscordMessage(
      candidate({ guildId: undefined, authorIsBot: true }),
      policy,
    );
    expect(verdict).toEqual({ admitted: false, reason: "bot_authored" });
  });

  test("drops an un-mentioned message in a guild channel", () => {
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

  test("does not admit an @everyone announcement", () => {
    // The highest-cost false admit: every announcement in a
    // channel would reach the assistant. Discord omits `@everyone` / `@here`
    // and role pings from the mentions array — it reports them on separate
    // fields — so an announcement arrives shaped exactly like this, with the
    // bot absent from `mentionedUserIds`, and the mention check drops it.
    const verdict = admitDiscordMessage(
      candidate({ mentionedUserIds: [] }),
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

  test("a thread is admitted like any other channel", () => {
    // Discord keys thread messages on the thread's own id and auto-subscribes
    // the bot to visible threads, so a thread is simply another channel it can
    // or cannot see. Nothing here has to know it is one.
    const verdict = admitDiscordMessage(
      candidate({ channelId: "800000000000000099" }),
      policy,
    );
    expect(verdict).toEqual({ admitted: true });
  });

  test("a thread still has to clear every other check", () => {
    const verdict = admitDiscordMessage(
      candidate({ channelId: "800000000000000099", mentionedUserIds: [] }),
      policy,
    );
    expect(verdict).toEqual({ admitted: false, reason: "bot_not_mentioned" });
  });

  test("a guild message the bot is not mentioned in is dropped", () => {
    // The gate that remains. Which rooms the bot sees at all is Discord's
    // decision, made with channel permissions; this decides which of the
    // messages it does see are meant for it.
    const verdict = admitDiscordMessage(
      candidate({ mentionedUserIds: ["999999999999999999"] }),
      policy,
    );
    expect(verdict).toEqual({ admitted: false, reason: "bot_not_mentioned" });
  });
});

describe("the legacy allow-list fence", () => {
  // A non-empty persisted list is operator intent from the old model, and an
  // upgrade must not widen that scope before they clear it. Nothing writes
  // the list anymore, so new installs never enter this describe.
  const legacyPolicy: AdmissionPolicy = {
    botUserId: BOT,
    legacyAllowedChannelIds: new Set([ALLOWED_CHANNEL]),
  };

  test("a listed channel still admits a mention", () => {
    expect(admitDiscordMessage(candidate(), legacyPolicy)).toEqual({
      admitted: true,
    });
  });

  test("an unlisted channel stays out, exactly as configured", () => {
    const verdict = admitDiscordMessage(
      candidate({ channelId: OTHER_CHANNEL }),
      legacyPolicy,
    );
    expect(verdict).toEqual({ admitted: false, reason: "channel_not_allowed" });
  });

  test("a thread inherits its parent's listing", () => {
    const verdict = admitDiscordMessage(
      candidate({
        channelId: "800000000000000099",
        parentChannelId: ALLOWED_CHANNEL,
      }),
      legacyPolicy,
    );
    expect(verdict).toEqual({ admitted: true });
  });

  test("a DM is unaffected by the list", () => {
    const verdict = admitDiscordMessage(
      candidate({
        guildId: undefined,
        channelId: "800000000000000009",
        mentionedUserIds: [],
      }),
      legacyPolicy,
    );
    expect(verdict).toEqual({ admitted: true });
  });

  test("without a list, an unlisted room admits a mention", () => {
    const verdict = admitDiscordMessage(
      candidate({ channelId: OTHER_CHANNEL }),
      policy,
    );
    expect(verdict).toEqual({ admitted: true });
  });
});
