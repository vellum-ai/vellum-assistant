/**
 * Tests for ios-app-nudge/platform.
 *
 * Verifies `isIOSBrowser()` detection across iPhone, iPad (including
 * iPadOS 13+ desktop mode), iPod, Android, desktop, and SSR.
 * Each test mocks `navigator` at the global level and restores it afterward.
 */

import { afterEach, describe, expect, test } from "bun:test";

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

import { isIOSBrowser, isSafariBrowser } from "@/lib/ios-app-nudge/platform.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isIOSBrowser", () => {
  afterEach(() => {
    removeNavigator();
  });

  // --- SSR (no navigator) ---

  test("returns false during SSR (navigator undefined)", () => {
    delete (globalThis as { navigator?: unknown }).navigator;
    expect(isIOSBrowser()).toBe(false);
  });

  // --- iPhone ---

  test("returns true for iPhone user agent", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    expect(isIOSBrowser()).toBe(true);
  });

  // --- iPod ---

  test("returns true for iPod user agent", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPod",
      maxTouchPoints: 5,
    });
    expect(isIOSBrowser()).toBe(true);
  });

  // --- iPad (classic user agent) ---

  test("returns true for iPad with iPad user agent", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPad",
      maxTouchPoints: 5,
    });
    expect(isIOSBrowser()).toBe(true);
  });

  // --- iPad in desktop mode (iPadOS 13+) ---

  test("returns true for iPad in desktop mode (Mac platform + maxTouchPoints > 1)", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    expect(isIOSBrowser()).toBe(true);
  });

  test("returns true for iPad in desktop mode with userAgentData", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      userAgentData: { platform: "macOS" },
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    expect(isIOSBrowser()).toBe(true);
  });

  // --- Non-iOS devices ---

  test("returns false for actual macOS (maxTouchPoints = 0)", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    expect(isIOSBrowser()).toBe(false);
  });

  test("returns false for macOS with Magic Trackpad (maxTouchPoints = 1)", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 1,
    });
    expect(isIOSBrowser()).toBe(false);
  });

  test("returns false for Windows", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      platform: "Win32",
      maxTouchPoints: 0,
    });
    expect(isIOSBrowser()).toBe(false);
  });

  test("returns false for Android phone", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    });
    expect(isIOSBrowser()).toBe(false);
  });

  test("returns false for Linux desktop", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      platform: "Linux x86_64",
      maxTouchPoints: 0,
    });
    expect(isIOSBrowser()).toBe(false);
  });

  // --- Edge cases ---

  test("returns false for Chrome on macOS with userAgentData (no multitouch)", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0",
      userAgentData: { platform: "macOS" },
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    expect(isIOSBrowser()).toBe(false);
  });
});

describe("isSafariBrowser", () => {
  afterEach(() => {
    removeNavigator();
  });

  test("returns false during SSR (navigator undefined)", () => {
    delete (globalThis as { navigator?: unknown }).navigator;
    expect(isSafariBrowser()).toBe(false);
  });

  test("returns true for Safari on iOS", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    expect(isSafariBrowser()).toBe(true);
  });

  test("returns true for Safari on macOS", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    });
    expect(isSafariBrowser()).toBe(true);
  });

  test("returns false for Chrome on iOS (CriOS)", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1",
    });
    expect(isSafariBrowser()).toBe(false);
  });

  test("returns false for Firefox on iOS (FxiOS)", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/604.1",
    });
    expect(isSafariBrowser()).toBe(false);
  });

  test("returns false for Edge on iOS (EdgiOS)", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/120.0 Mobile/15E148 Safari/604.1",
    });
    expect(isSafariBrowser()).toBe(false);
  });

  test("returns false for Opera on iOS (OPiOS)", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) OPiOS/120.0 Mobile/15E148 Safari/604.1",
    });
    expect(isSafariBrowser()).toBe(false);
  });

  test("returns false for Chrome on desktop (UA contains Chrome + Safari/537.36)", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    expect(isSafariBrowser()).toBe(false);
  });

  test("returns false for Edge on desktop (UA contains Chrome + Edg/)", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    });
    expect(isSafariBrowser()).toBe(false);
  });

  test("returns false for Opera on desktop (UA contains Chrome + OPR/)", () => {
    setNavigator({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
    });
    expect(isSafariBrowser()).toBe(false);
  });
});
