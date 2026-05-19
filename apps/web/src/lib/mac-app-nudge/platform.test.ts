/**
 * Tests for mac-app-nudge/platform.
 *
 * Verifies `isMacOSBrowser()` detection across macOS, Windows, Linux, and SSR.
 * Each test mocks `navigator` at the global level and restores it afterward.
 */

import { afterEach, _beforeEach, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Save / restore navigator
// ---------------------------------------------------------------------------

const ORIGINAL_NAVIGATOR_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
}

function removeNavigator(): void {
  if (ORIGINAL_NAVIGATOR_DESCRIPTOR) {
    Object.defineProperty(
      globalThis,
      "navigator",
      ORIGINAL_NAVIGATOR_DESCRIPTOR,
    );
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
}

// ---------------------------------------------------------------------------
// Import subject
// ---------------------------------------------------------------------------

import { isMacOSBrowser } from "@/lib/mac-app-nudge/platform.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isMacOSBrowser", () => {
  afterEach(() => {
    removeNavigator();
  });

  // --- SSR (no navigator) ---

  test("returns false during SSR (navigator undefined)", () => {
    // Remove navigator entirely to simulate SSR.
    delete (globalThis as { navigator?: unknown }).navigator;
    expect(isMacOSBrowser()).toBe(false);
  });

  // --- userAgentData path (Chrome/Edge on macOS) ---

  test("returns true when userAgentData.platform is 'macOS'", () => {
    setNavigator({
      userAgentData: { platform: "macOS" },
      platform: "MacIntel",
    });
    expect(isMacOSBrowser()).toBe(true);
  });

  test("returns true when userAgentData.platform is 'macos' (case-insensitive)", () => {
    setNavigator({
      userAgentData: { platform: "macos" },
      platform: "MacIntel",
    });
    expect(isMacOSBrowser()).toBe(true);
  });

  // --- userAgentData path (non-macOS) ---

  test("returns false when userAgentData.platform is 'Windows'", () => {
    setNavigator({
      userAgentData: { platform: "Windows" },
      platform: "Win32",
    });
    expect(isMacOSBrowser()).toBe(false);
  });

  test("returns false when userAgentData.platform is 'Linux'", () => {
    setNavigator({
      userAgentData: { platform: "Linux" },
      platform: "Linux x86_64",
    });
    expect(isMacOSBrowser()).toBe(false);
  });

  // --- navigator.platform fallback (Safari/Firefox on macOS) ---

  test("returns true when navigator.platform is 'MacIntel' (no userAgentData)", () => {
    setNavigator({ platform: "MacIntel" });
    expect(isMacOSBrowser()).toBe(true);
  });

  test("returns true when navigator.platform is 'Macintosh'", () => {
    setNavigator({ platform: "Macintosh" });
    expect(isMacOSBrowser()).toBe(true);
  });

  // --- navigator.platform fallback (non-macOS) ---

  test("returns false when navigator.platform is 'Win32'", () => {
    setNavigator({ platform: "Win32" });
    expect(isMacOSBrowser()).toBe(false);
  });

  test("returns false when navigator.platform is 'Linux x86_64'", () => {
    setNavigator({ platform: "Linux x86_64" });
    expect(isMacOSBrowser()).toBe(false);
  });

  // --- Edge cases ---

  test("returns false when userAgentData exists but platform is undefined", () => {
    setNavigator({ userAgentData: {}, platform: "Win32" });
    expect(isMacOSBrowser()).toBe(false);
  });

  test("returns false when userAgentData.platform is empty string", () => {
    setNavigator({ userAgentData: { platform: "" }, platform: "Win32" });
    expect(isMacOSBrowser()).toBe(false);
  });
});
