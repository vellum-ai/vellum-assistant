import { describe, expect, test } from "bun:test";

import {
  EMOJI_CATALOG,
  searchEmoji,
} from "@/domains/chat/components/chat-composer/emoji-catalog-data";

describe("EMOJI_CATALOG", () => {
  test("contains a substantial number of entries", () => {
    expect(EMOJI_CATALOG.length).toBeGreaterThan(1000);
  });

  test("is sorted by shortcode", () => {
    for (let i = 1; i < EMOJI_CATALOG.length; i++) {
      const prev = EMOJI_CATALOG[i - 1]!.shortcode;
      const curr = EMOJI_CATALOG[i]!.shortcode;
      expect(prev <= curr).toBe(true);
    }
  });

  test("has no duplicate shortcodes", () => {
    const shortcodes = EMOJI_CATALOG.map((e) => e.shortcode);
    expect(new Set(shortcodes).size).toBe(shortcodes.length);
  });

  test("entry never lists its own shortcode in aliases", () => {
    for (const entry of EMOJI_CATALOG) {
      expect(entry.aliases).not.toContain(entry.shortcode);
    }
  });

  test("aliases are unique per entry", () => {
    for (const entry of EMOJI_CATALOG) {
      expect(new Set(entry.aliases).size).toBe(entry.aliases.length);
    }
  });

  test("contains the triumph emoji with huff-related aliases", () => {
    const triumph = EMOJI_CATALOG.find((e) => e.shortcode === "triumph");
    expect(triumph).toBeDefined();
    expect(triumph!.emoji).toBe("😤");
    expect(triumph!.aliases).toContain("huff");
    expect(triumph!.aliases).toContain("frustrated");
  });

  test.each([
    ["left_facing_fist", "🤛"],
    ["right_facing_fist", "🤜"],
    ["red_flag", "🚩"],
  ])("preserves legacy web shortcode :%s as a catalog row", (shortcode, emoji) => {
    const entry = EMOJI_CATALOG.find((e) => e.shortcode === shortcode);
    expect(entry).toBeDefined();
    expect(entry!.emoji).toBe(emoji);
  });
});

describe("searchEmoji", () => {
  test("surfaces 😤 when searching :huff (alias match)", () => {
    const results = searchEmoji("huff");
    expect(results.some((e) => e.emoji === "😤")).toBe(true);
  });

  test("surfaces 😤 when searching :frustrated (alias match)", () => {
    const results = searchEmoji("frustrated");
    expect(results.some((e) => e.emoji === "😤")).toBe(true);
  });

  test("still returns 😤 for the canonical :triumph shortcode", () => {
    const results = searchEmoji("triumph");
    expect(results[0]?.emoji).toBe("😤");
  });

  test("ranks shortcode prefix matches above alias matches", () => {
    // :steam → steam_locomotive (shortcode prefix) ranks above triumph (alias only).
    const results = searchEmoji("steam", 20);
    const locoIdx = results.findIndex((e) => e.shortcode === "steam_locomotive");
    const triumphIdx = results.findIndex((e) => e.shortcode === "triumph");
    expect(locoIdx).toBeGreaterThanOrEqual(0);
    expect(triumphIdx).toBeGreaterThanOrEqual(0);
    expect(locoIdx).toBeLessThan(triumphIdx);
  });

  test("is case insensitive", () => {
    expect(searchEmoji("HUFF")).toEqual(searchEmoji("huff"));
  });

  test("respects the limit parameter", () => {
    expect(searchEmoji("e", 3).length).toBeLessThanOrEqual(3);
  });

  test("returns results without duplicate shortcodes", () => {
    const results = searchEmoji("heart", 50);
    const shortcodes = results.map((e) => e.shortcode);
    expect(new Set(shortcodes).size).toBe(shortcodes.length);
  });

  test("empty query returns catalog prefix", () => {
    const results = searchEmoji("", 5);
    expect(results).toEqual(EMOJI_CATALOG.slice(0, 5));
  });

  test(":lol surfaces both joy and rofl via aliases", () => {
    const results = searchEmoji("lol", 10);
    expect(results.some((e) => e.shortcode === "joy")).toBe(true);
    expect(results.some((e) => e.shortcode === "rofl")).toBe(true);
  });
});
