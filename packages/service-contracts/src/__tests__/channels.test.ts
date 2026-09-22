import { describe, expect, test } from "bun:test";

import {
  botProviderForChannel,
  CHANNEL_BOT_PROVIDER,
  CHANNEL_IDS,
  channelForBotProvider,
  isChannelBotProvider,
  isChannelUserIntegration,
  isChannelId,
} from "../channels.js";

describe("isChannelId", () => {
  test("accepts every canonical channel id", () => {
    for (const id of CHANNEL_IDS) {
      expect(isChannelId(id)).toBe(true);
    }
  });

  test("includes the internal channels no external surface ingresses", () => {
    // `platform` (control plane) and `vellum` (native app) are part of the
    // canonical vocabulary even though the gateway never ingresses them. The
    // gateway's narrower list is a compile-time-asserted subset of this set,
    // so these must remain canonical for that assertion to mean anything.
    expect(isChannelId("platform")).toBe(true);
    expect(isChannelId("vellum")).toBe(true);
  });

  test("includes discord", () => {
    // Discord is canonical vocabulary ahead of its ingress implementation:
    // the gateway's inbound list and the admission-policy seed both derive
    // from CHANNEL_IDS, so it must be here for a Discord message to be
    // routable and to carry an admission floor at all.
    expect(isChannelId("discord")).toBe(true);
  });

  test("rejects unknown strings and non-string values", () => {
    expect(isChannelId("mastodon")).toBe(false);
    expect(isChannelId("")).toBe(false);
    expect(isChannelId(undefined)).toBe(false);
    expect(isChannelId(null)).toBe(false);
    expect(isChannelId(42)).toBe(false);
  });
});

describe("botProviderForChannel and channelForBotProvider", () => {
  test("are inverses over every entry of the map", () => {
    for (const [channelId, botProviderKey] of Object.entries(
      CHANNEL_BOT_PROVIDER,
    )) {
      expect(botProviderForChannel(channelId)).toBe(botProviderKey);
      expect(channelForBotProvider(botProviderKey)).toBe(
        channelId as keyof typeof CHANNEL_BOT_PROVIDER,
      );
    }
  });

  test("answer nothing for a channel without a bot, a person's grant, or an unknown key", () => {
    expect(botProviderForChannel("phone")).toBeUndefined();
    expect(botProviderForChannel("vellum")).toBeUndefined();
    expect(botProviderForChannel("not-a-channel")).toBeUndefined();
    // `slack` is the person's integration standing beside the bot's key.
    expect(channelForBotProvider("slack")).toBeUndefined();
    expect(channelForBotProvider("google")).toBeUndefined();
  });

  test("never resolve an inherited object property as a channel or a key", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(botProviderForChannel(name)).toBeUndefined();
      expect(channelForBotProvider(name)).toBeUndefined();
    }
  });
});

describe("isChannelUserIntegration", () => {
  test("names the grant standing beside a bot of the same brand", () => {
    expect(isChannelUserIntegration("slack")).toBe(true);
    expect(isChannelUserIntegration("discord")).toBe(true);
  });

  test("excludes a channel whose bot is its own key", () => {
    // `telegram` names the bot, so no second provider carries the brand and
    // there is nothing to mistake for it.
    expect(isChannelUserIntegration("telegram")).toBe(false);
  });

  test("excludes the bots themselves and unrelated providers", () => {
    expect(isChannelUserIntegration("slack_channel")).toBe(false);
    expect(isChannelUserIntegration("discord_channel")).toBe(false);
    expect(isChannelUserIntegration("google")).toBe(false);
  });

  test("is the complement of isChannelBotProvider over the map", () => {
    // The two questions partition the brands that have both halves: a key is
    // one or the other, never both, so a caller picking the wrong one gets an
    // empty answer rather than a plausible wrong one.
    for (const [channelId, botProviderKey] of Object.entries(
      CHANNEL_BOT_PROVIDER,
    )) {
      expect(isChannelUserIntegration(channelId)).toBe(
        channelId !== botProviderKey,
      );
      expect(isChannelBotProvider(botProviderKey)).toBe(true);
    }
  });
});
