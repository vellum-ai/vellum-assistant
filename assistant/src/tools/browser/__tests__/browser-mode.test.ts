import { describe, expect, test } from "bun:test";

import type { BrowserMode } from "../browser-mode.js";
import { normalizeBrowserMode } from "../browser-mode.js";

describe("normalizeBrowserMode", () => {
  // ── Defaults ──────────────────────────────────────────────────────────

  test("undefined defaults to auto", () => {
    const result = normalizeBrowserMode(undefined);
    expect(result).toEqual({ mode: "auto" });
  });

  test("null defaults to auto", () => {
    const result = normalizeBrowserMode(null);
    expect(result).toEqual({ mode: "auto" });
  });

  test("empty string defaults to auto", () => {
    const result = normalizeBrowserMode("");
    expect(result).toEqual({ mode: "auto" });
  });

  // ── Canonical values ──────────────────────────────────────────────────

  const canonicalValues: BrowserMode[] = [
    "auto",
    "extension",
    "cdp-inspect",
    "local",
  ];

  for (const value of canonicalValues) {
    test(`canonical value "${value}" normalizes to itself`, () => {
      const result = normalizeBrowserMode(value);
      expect(result).toEqual({ mode: value });
    });
  }

  // ── Aliases ───────────────────────────────────────────────────────────

  test('alias "cdp-debugger" normalizes to "cdp-inspect"', () => {
    const result = normalizeBrowserMode("cdp-debugger");
    expect(result).toEqual({ mode: "cdp-inspect" });
  });

  test('alias "playwright" normalizes to "local"', () => {
    const result = normalizeBrowserMode("playwright");
    expect(result).toEqual({ mode: "local" });
  });

  // ── Case insensitivity ────────────────────────────────────────────────

  test("uppercase input is normalized", () => {
    const result = normalizeBrowserMode("AUTO");
    expect(result).toEqual({ mode: "auto" });
  });

  test("mixed-case alias is normalized", () => {
    const result = normalizeBrowserMode("Playwright");
    expect(result).toEqual({ mode: "local" });
  });

  test("mixed-case cdp-debugger alias is normalized", () => {
    const result = normalizeBrowserMode("CDP-Debugger");
    expect(result).toEqual({ mode: "cdp-inspect" });
  });

  // ── Whitespace trimming ───────────────────────────────────────────────

  test("leading/trailing whitespace is trimmed", () => {
    const result = normalizeBrowserMode("  local  ");
    expect(result).toEqual({ mode: "local" });
  });

  // ── Invalid values ────────────────────────────────────────────────────

  test("unknown string returns error with accepted values", () => {
    const result = normalizeBrowserMode("headless");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain('Invalid browser_mode "headless"');
      expect(result.error).toContain("Accepted values:");
      expect(result.error).toContain("auto");
      expect(result.error).toContain("extension");
      expect(result.error).toContain("cdp-inspect");
      expect(result.error).toContain("cdp-debugger");
      expect(result.error).toContain("local");
      expect(result.error).toContain("playwright");
      expect(result.error).toContain("Aliases:");
      expect(result.error).toContain("cdp-debugger->cdp-inspect");
      expect(result.error).toContain("playwright->local");
    }
  });

  test("non-string input returns error", () => {
    const result = normalizeBrowserMode(42);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain('Invalid browser_mode "42"');
    }
  });

  test("boolean input returns error", () => {
    const result = normalizeBrowserMode(true);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain('Invalid browser_mode "true"');
    }
  });

  // ── Error message determinism ─────────────────────────────────────────

  test("error message is deterministic across calls", () => {
    const r1 = normalizeBrowserMode("bogus");
    const r2 = normalizeBrowserMode("bogus");
    expect(r1).toEqual(r2);
  });
});
