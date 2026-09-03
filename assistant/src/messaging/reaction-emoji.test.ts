import { describe, expect, test } from "bun:test";

import {
  emojiCharacterForShortcode,
  resolveReactionEmoji,
} from "./reaction-emoji.js";

describe("resolveReactionEmoji", () => {
  test("a unicode emoji is its own display and channel form", () => {
    expect(
      resolveReactionEmoji({
        emoji: "🎉",
        emojiKind: "unicode",
        emojiName: "🎉",
      }),
    ).toEqual({ display: "🎉" });
  });

  test("a shortcode in the table resolves to its character for both readers", () => {
    expect(
      resolveReactionEmoji({
        emoji: "tada",
        emojiKind: "shortcode",
        emojiName: "tada",
      }),
    ).toEqual({ display: "🎉" });
    expect(
      resolveReactionEmoji({
        emoji: "+1",
        emojiKind: "shortcode",
        emojiName: "+1",
      }),
    ).toEqual({ display: "👍" });
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
    ).toEqual({ display: ":blob_wave:" });
  });

  test("a custom emoji shows its name; its image is the channel's to serve", () => {
    expect(
      resolveReactionEmoji({
        emoji: "<:vex:12345>",
        emojiKind: "custom",
        emojiName: "vex",
        emojiId: "12345",
      }),
    ).toEqual({ display: ":vex:" });
  });

  test("a row carrying only its spelling is classified before resolving", () => {
    expect(resolveReactionEmoji({ emoji: "tada" }).display).toBe("🎉");
    expect(resolveReactionEmoji({ emoji: "👍" }).display).toBe("👍");
    expect(
      resolveReactionEmoji({ emoji: "thumbsup::skin-tone-3" }).display,
    ).toBe("👍🏼");
    expect(resolveReactionEmoji({ emoji: "<:vex:12345>" })).toEqual({
      display: ":vex:",
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
