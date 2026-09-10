import { describe, expect, test } from "bun:test";

import { Calculator, House, Rocket } from "lucide-react";

import {
  APP_ICON_NAMES,
  DEFAULT_APP_ICON,
  isEmojiIcon,
  resolveAppIcon,
} from "@/utils/app-icon-registry";

describe("resolveAppIcon", () => {
  test("a registry name resolves to its Lucide component, any case", () => {
    expect(resolveAppIcon("calculator")).toEqual({
      kind: "icon",
      Icon: Calculator,
    });
    expect(resolveAppIcon(" Calculator ")).toEqual({
      kind: "icon",
      Icon: Calculator,
    });
  });

  test("the older `home` name still resolves", () => {
    expect(resolveAppIcon("home")).toEqual({ kind: "icon", Icon: House });
  });

  test("a pre-registry emoji renders as itself", () => {
    expect(resolveAppIcon("☕")).toEqual({ kind: "emoji", emoji: "☕" });
    // A keycap sequence has no pictograph of its own.
    expect(resolveAppIcon("1️⃣")).toEqual({ kind: "emoji", emoji: "1️⃣" });
  });

  test("nothing usable resolves to null", () => {
    expect(resolveAppIcon(undefined)).toBeNull();
    expect(resolveAppIcon("")).toBeNull();
    expect(resolveAppIcon("not-an-icon")).toBeNull();
    expect(resolveAppIcon("https://example.com/icon.png")).toBeNull();
  });

  test("the default is the rocket, and the name list is non-empty", () => {
    expect(DEFAULT_APP_ICON).toBe(Rocket);
    expect(APP_ICON_NAMES.length).toBeGreaterThan(50);
    expect(APP_ICON_NAMES).toContain("calculator");
  });

  test("isEmojiIcon tells emoji from names", () => {
    expect(isEmojiIcon("🔢")).toBe(true);
    expect(isEmojiIcon("calculator")).toBe(false);
  });
});
