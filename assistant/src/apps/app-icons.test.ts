import { describe, expect, test } from "bun:test";

import { APP_ICON_NAMES, normalizeAppIcon } from "./app-icons.js";

describe("normalizeAppIcon", () => {
  test("keeps a registry name, normalised to its kebab-case key", () => {
    expect(normalizeAppIcon("calculator")).toBe("calculator");
    expect(normalizeAppIcon(" Calculator ")).toBe("calculator");
    expect(normalizeAppIcon("List-Todo")).toBe("list-todo");
  });

  test("keeps an emoji as is", () => {
    expect(normalizeAppIcon("☕")).toBe("☕");
    expect(normalizeAppIcon("1️⃣")).toBe("1️⃣");
  });

  test("drops URLs, unknown names, empties, and non-strings", () => {
    expect(normalizeAppIcon("https://example.com/icon.png")).toBeUndefined();
    expect(normalizeAppIcon("http://x/y.svg")).toBeUndefined();
    expect(normalizeAppIcon("not-an-icon")).toBeUndefined();
    expect(normalizeAppIcon("")).toBeUndefined();
    expect(normalizeAppIcon("   ")).toBeUndefined();
    expect(normalizeAppIcon(42)).toBeUndefined();
    expect(normalizeAppIcon(undefined)).toBeUndefined();
  });

  test("the list is kebab-case and free of duplicates", () => {
    expect(new Set(APP_ICON_NAMES).size).toBe(APP_ICON_NAMES.length);
    for (const name of APP_ICON_NAMES) {
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});
