import { describe, expect, test } from "bun:test";

import {
  emojiCharacterForShortcode,
  resolveReactionEmoji,
  shortcodeForEmojiCharacter,
} from "./reaction-emoji.js";

describe("resolveReactionEmoji", () => {
  test("a unicode emoji is its own display and channel form", () => {
    expect(
      resolveReactionEmoji({
        emoji: "🎉",
        emojiKind: "unicode",
        emojiName: "🎉",
      }),
    ).toEqual({ display: "🎉", channelForm: "🎉" });
  });

  test("a shortcode in the table resolves to its character for both readers", () => {
    expect(
      resolveReactionEmoji({
        emoji: "tada",
        emojiKind: "shortcode",
        emojiName: "tada",
      }),
    ).toEqual({ display: "🎉", channelForm: "🎉" });
    expect(
      resolveReactionEmoji({
        emoji: "+1",
        emojiKind: "shortcode",
        emojiName: "+1",
      }),
    ).toEqual({ display: "👍", channelForm: "👍" });
  });

  test("a skin tone suffix resolves to the toned variant", () => {
    expect(
      resolveReactionEmoji({
        emoji: "thumbsup::skin-tone-3",
        emojiKind: "shortcode",
        emojiName: "thumbsup::skin-tone-3",
      }).display,
    ).toBe("👍🏼");
  });

  test("a shortcode the table lacks stays a colon-wrapped name", () => {
    expect(
      resolveReactionEmoji({
        emoji: "blob_wave",
        emojiKind: "shortcode",
        emojiName: "blob_wave",
      }),
    ).toEqual({ display: ":blob_wave:", channelForm: ":blob_wave:" });
  });

  test("a custom emoji shows its name and hands the model the mention form", () => {
    expect(
      resolveReactionEmoji({
        emoji: "<:vex:12345>",
        emojiKind: "custom",
        emojiName: "vex",
        emojiId: "12345",
      }),
    ).toEqual({ display: ":vex:", channelForm: "<:vex:12345>" });
    expect(
      resolveReactionEmoji({
        emoji: "<:vex:12345>",
        emojiKind: "custom",
        emojiName: "vex",
        emojiId: "12345",
        emojiAnimated: true,
      }).channelForm,
    ).toBe("<a:vex:12345>");
  });

  test("a row carrying only its spelling is classified before resolving", () => {
    expect(resolveReactionEmoji({ emoji: "tada" }).display).toBe("🎉");
    expect(resolveReactionEmoji({ emoji: "👍" }).display).toBe("👍");
    expect(resolveReactionEmoji({ emoji: "<:vex:12345>" })).toEqual({
      display: ":vex:",
      channelForm: "<:vex:12345>",
    });
    expect(resolveReactionEmoji({ emoji: "blob_wave" }).display).toBe(
      ":blob_wave:",
    );
  });
});

describe("emojiCharacterForShortcode", () => {
  test("every short name of an emoji resolves to the same character", () => {
    expect(emojiCharacterForShortcode("+1")).toBe("👍");
    expect(emojiCharacterForShortcode("thumbsup")).toBe("👍");
  });

  test("a skin tone on an emoji with no variants falls back to the base", () => {
    expect(emojiCharacterForShortcode("tada::skin-tone-4")).toBe("🎉");
  });

  test("an unknown name resolves to nothing", () => {
    expect(emojiCharacterForShortcode("blob_wave")).toBeUndefined();
    expect(
      emojiCharacterForShortcode("blob_wave::skin-tone-2"),
    ).toBeUndefined();
  });
});

describe("shortcodeForEmojiCharacter", () => {
  test("a character maps back to its primary name", () => {
    expect(shortcodeForEmojiCharacter("🎉")).toBe("tada");
    expect(shortcodeForEmojiCharacter("👍")).toBe("+1");
  });

  test("a toned variant maps back with Slack's suffix", () => {
    expect(shortcodeForEmojiCharacter("👍🏼")).toBe("+1::skin-tone-3");
  });

  test("a character without its variation selector still resolves", () => {
    expect(shortcodeForEmojiCharacter("☂️")).toBe("umbrella");
    expect(shortcodeForEmojiCharacter("☂")).toBe("umbrella");
  });

  test("a character outside the table resolves to nothing", () => {
    expect(shortcodeForEmojiCharacter("a")).toBeUndefined();
  });
});
