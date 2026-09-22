import { describe, expect, test } from "bun:test";

import { APP_ICON_NAMES } from "@vellumai/app-icons";
import { Calculator, Coffee, House, Rocket } from "lucide-react";

import { DEFAULT_APP_ICON, getAppIcon } from "@/utils/app-icon-registry";

describe("getAppIcon", () => {
  test("every name the assistant may choose has a glyph", () => {
    for (const name of APP_ICON_NAMES) {
      expect(getAppIcon(name)).toBeDefined();
    }
  });

  test("a registry name resolves to its Lucide component, any case", () => {
    expect(getAppIcon("calculator")).toBe(Calculator);
    expect(getAppIcon(" Calculator ")).toBe(Calculator);
    expect(getAppIcon("home")).toBe(House);
  });

  test("an emoji the package maps resolves to that glyph", () => {
    expect(getAppIcon("🔢")).toBe(Calculator);
    expect(getAppIcon("☕")).toBe(Coffee);
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

  test("the default is the rocket", () => {
    expect(DEFAULT_APP_ICON).toBe(Rocket);
  });
});
