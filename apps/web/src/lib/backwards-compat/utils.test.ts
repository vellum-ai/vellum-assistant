import { describe, expect, test } from "bun:test";

import { assistantSupports } from "@/lib/backwards-compat/utils.js";

describe("assistantSupports", () => {
  test("returns false when the version is unknown", () => {
    expect(assistantSupports(null, "0.8.5")).toBe(false);
    expect(assistantSupports("", "0.8.5")).toBe(false);
  });

  test("returns false for unparseable versions", () => {
    expect(assistantSupports("not-a-version", "0.8.5")).toBe(false);
    expect(assistantSupports("0.8", "0.8.5")).toBe(false);
  });

  test("returns false when the minVersion is unparseable", () => {
    expect(assistantSupports("0.8.5", "garbage")).toBe(false);
  });

  test("returns true when version >= minVersion", () => {
    expect(assistantSupports("0.8.5", "0.8.5")).toBe(true);
    expect(assistantSupports("0.8.6", "0.8.5")).toBe(true);
    expect(assistantSupports("0.9.0", "0.8.5")).toBe(true);
    expect(assistantSupports("1.0.0", "0.8.5")).toBe(true);
  });

  test("returns false when version < minVersion", () => {
    expect(assistantSupports("0.8.4", "0.8.5")).toBe(false);
    expect(assistantSupports("0.7.99", "0.8.5")).toBe(false);
    expect(assistantSupports("0.0.1", "0.8.5")).toBe(false);
  });

  test("treats pre-release suffixes as the full patch version", () => {
    // 0.8.5-rc.1 counts as >= 0.8.5, not the strict-semver "less than"
    // it would normally be. Testers on RCs get the new path.
    expect(assistantSupports("0.8.5-rc.1", "0.8.5")).toBe(true);
    expect(assistantSupports("0.8.5-alpha", "0.8.5")).toBe(true);
    expect(assistantSupports("0.9.0-beta.3", "0.8.5")).toBe(true);
  });

  test("strips leading 'v' prefix on the version", () => {
    expect(assistantSupports("v0.8.5", "0.8.5")).toBe(true);
    expect(assistantSupports("v0.8.4", "0.8.5")).toBe(false);
  });
});
