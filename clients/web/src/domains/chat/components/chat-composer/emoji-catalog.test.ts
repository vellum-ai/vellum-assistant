import { describe, expect, test } from "bun:test";

import {
  EMOJI_CATALOG,
  searchEmoji,
} from "@/domains/chat/components/chat-composer/emoji-catalog-data";

/** Presentation selectors do not change what a person sees. */
const glyph = (s: string | undefined) => s?.replace(/️/g, "");

describe("EMOJI_CATALOG", () => {
  test("contains a substantial number of entries", () => {
    expect(EMOJI_CATALOG.length).toBeGreaterThan(1000);
  });

  test("is sorted by shortcode", () => {
    for (let i = 1; i < EMOJI_CATALOG.length; i++) {
      expect(
        EMOJI_CATALOG[i - 1]!.shortcode <= EMOJI_CATALOG[i]!.shortcode,
      ).toBe(true);
    }
  });

  test("has no duplicate shortcodes", () => {
    const shortcodes = EMOJI_CATALOG.map((e) => e.shortcode);
    expect(new Set(shortcodes).size).toBe(shortcodes.length);
  });

  test("entry never lists its own shortcode in aliases, and aliases are unique", () => {
    for (const entry of EMOJI_CATALOG) {
      expect(entry.aliases).not.toContain(entry.shortcode);
      expect(new Set(entry.aliases).size).toBe(entry.aliases.length);
    }
  });

  test("uses Slack's names: every short name of an emoji is its own row", () => {
    const plusOne = EMOJI_CATALOG.find((e) => e.shortcode === "+1");
    const thumbsup = EMOJI_CATALOG.find((e) => e.shortcode === "thumbsup");
    expect(glyph(plusOne?.emoji)).toBe("👍");
    expect(thumbsup?.emoji).toBe(plusOne?.emoji);
  });

  test.each([
    ["flag-nz", "🇳🇿"],
    ["umbrella", "☂"],
    ["tada", "🎉"],
  ])("carries Slack's :%s", (shortcode, emoji) => {
    expect(
      glyph(EMOJI_CATALOG.find((e) => e.shortcode === shortcode)?.emoji),
    ).toBe(emoji);
  });
});

describe("searchEmoji", () => {
  test("surfaces 😤 by a tag from the dataset", () => {
    expect(searchEmoji("fuming").some((e) => glyph(e.emoji) === "😤")).toBe(
      true,
    );
  });

  test("returns 😤 first for its own :triumph shortcode", () => {
    expect(glyph(searchEmoji("triumph")[0]?.emoji)).toBe("😤");
  });

  test("ranks shortcode prefix matches above alias matches", () => {
    const results = searchEmoji("steam", 20);
    const locoIdx = results.findIndex(
      (e) => e.shortcode === "steam_locomotive",
    );
    const triumphIdx = results.findIndex((e) => e.shortcode === "triumph");
    expect(locoIdx).toBeGreaterThanOrEqual(0);
    expect(triumphIdx).toBeGreaterThanOrEqual(0);
    expect(locoIdx).toBeLessThan(triumphIdx);
  });

  test("is case insensitive", () => {
    expect(searchEmoji("FUMING")).toEqual(searchEmoji("fuming"));
  });

  test("respects the limit parameter", () => {
    expect(searchEmoji("e", 3).length).toBeLessThanOrEqual(3);
  });

  test("returns results without duplicate shortcodes", () => {
    const shortcodes = searchEmoji("heart", 50).map((e) => e.shortcode);
    expect(new Set(shortcodes).size).toBe(shortcodes.length);
  });

  test("empty query returns catalog prefix", () => {
    expect(searchEmoji("", 5)).toEqual(EMOJI_CATALOG.slice(0, 5));
  });

  test(":lol surfaces 😂 via its tags", () => {
    expect(searchEmoji("lol", 10).some((e) => e.shortcode === "joy")).toBe(
      true,
    );
  });
});
