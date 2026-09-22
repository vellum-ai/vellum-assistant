import { describe, expect, test } from "bun:test";

import {
  APP_ICON_NAMES,
  bridgeEmojiAppIcon,
  EMOJI_ICON_NAMES,
  isAppIconName,
  isEmojiAppIcon,
  normalizeAppIcon,
} from "./index.js";

describe("APP_ICON_NAMES", () => {
  test("is kebab-case and free of duplicates", () => {
    expect(new Set(APP_ICON_NAMES).size).toBe(APP_ICON_NAMES.length);
    for (const name of APP_ICON_NAMES) {
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
    expect(isAppIconName("calculator")).toBe(true);
    expect(isAppIconName("not-an-icon")).toBe(false);
  });

  test("every emoji maps to a registry name", () => {
    for (const name of Object.values(EMOJI_ICON_NAMES)) {
      expect(isAppIconName(name)).toBe(true);
    }
  });
});

describe("isEmojiAppIcon", () => {
  test("accepts an emoji, a sequence, and a keycap", () => {
    expect(isEmojiAppIcon("☕")).toBe(true);
    expect(isEmojiAppIcon("☕️")).toBe(true);
    expect(isEmojiAppIcon("👨‍💻")).toBe(true);
    expect(isEmojiAppIcon("1️⃣")).toBe(true);
    expect(isEmojiAppIcon("👍🏽")).toBe(true);
  });

  test("rejects text, text around an emoji, and bare marks", () => {
    expect(isEmojiAppIcon("coffee")).toBe(false);
    expect(isEmojiAppIcon("coffee ☕")).toBe(false);
    expect(isEmojiAppIcon("☕ coffee")).toBe(false);
    expect(isEmojiAppIcon("\u200D")).toBe(false);
    expect(isEmojiAppIcon("")).toBe(false);
  });
});

describe("bridgeEmojiAppIcon", () => {
  test("maps a known emoji to its name, with or without the selector", () => {
    expect(bridgeEmojiAppIcon("🔢")).toBe("calculator");
    expect(bridgeEmojiAppIcon("☕️")).toBe("coffee");
  });

  test("passes everything else through, prototype names included", () => {
    expect(bridgeEmojiAppIcon("calculator")).toBe("calculator");
    expect(bridgeEmojiAppIcon("1️⃣")).toBe("1️⃣");
    expect(bridgeEmojiAppIcon("constructor")).toBe("constructor");
    expect(bridgeEmojiAppIcon(undefined)).toBeUndefined();
  });
});

describe("normalizeAppIcon", () => {
  test("keeps a registry name, normalised to its kebab-case key", () => {
    expect(normalizeAppIcon("calculator")).toBe("calculator");
    expect(normalizeAppIcon(" Calculator ")).toBe("calculator");
    expect(normalizeAppIcon("List-Todo")).toBe("list-todo");
  });

  test("maps a known emoji and keeps an unknown one", () => {
    expect(normalizeAppIcon("☕")).toBe("coffee");
    expect(normalizeAppIcon("🔢")).toBe("calculator");
    expect(normalizeAppIcon("1️⃣")).toBe("1️⃣");
  });

  test("drops URLs, text around an emoji, unknown names, empties, non-strings", () => {
    expect(normalizeAppIcon("https://example.com/icon.png")).toBeUndefined();
    expect(normalizeAppIcon("http://x/y.svg")).toBeUndefined();
    expect(normalizeAppIcon("coffee ☕")).toBeUndefined();
    expect(normalizeAppIcon("not-an-icon")).toBeUndefined();
    expect(normalizeAppIcon("constructor")).toBeUndefined();
    expect(normalizeAppIcon("")).toBeUndefined();
    expect(normalizeAppIcon("   ")).toBeUndefined();
    expect(normalizeAppIcon(42)).toBeUndefined();
    expect(normalizeAppIcon(undefined)).toBeUndefined();
  });
});
