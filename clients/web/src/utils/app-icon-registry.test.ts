import { describe, expect, test } from "bun:test";

import { Calculator, Coffee, House, Rocket } from "lucide-react";

import {
  APP_ICON_NAMES,
  DEFAULT_APP_ICON,
  getAppIcon,
} from "@/utils/app-icon-registry";

describe("getAppIcon", () => {
  test("a registry name resolves to its Lucide component, any case", () => {
    expect(getAppIcon("calculator")).toBe(Calculator);
    expect(getAppIcon(" Calculator ")).toBe(Calculator);
  });

  test("the older `home` name still resolves", () => {
    expect(getAppIcon("home")).toBe(House);
  });

  test("a pre-registry emoji the bridge knows resolves to its glyph", () => {
    expect(getAppIcon("🔢")).toBe(Calculator);
    expect(getAppIcon("☕")).toBe(Coffee);
    // With the emoji variation selector the platform may append.
    expect(getAppIcon("☕️")).toBe(Coffee);
  });

  test("nothing usable resolves to undefined", () => {
    expect(getAppIcon(undefined)).toBeUndefined();
    expect(getAppIcon("")).toBeUndefined();
    expect(getAppIcon("not-an-icon")).toBeUndefined();
    expect(getAppIcon("1️⃣")).toBeUndefined();
    expect(getAppIcon("https://example.com/icon.png")).toBeUndefined();
    expect(getAppIcon("constructor")).toBeUndefined();
  });

  test("the default is the rocket, and the name list is non-empty", () => {
    expect(DEFAULT_APP_ICON).toBe(Rocket);
    expect(APP_ICON_NAMES.length).toBeGreaterThan(50);
    expect(APP_ICON_NAMES).toContain("calculator");
  });
});
