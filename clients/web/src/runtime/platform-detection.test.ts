/**
 * Unit tests for `detectInterfaceId`.
 *
 * The same `clients/web` bundle ships to a plain browser, the Capacitor iOS
 * shell, and the Electron macOS app, so the interface id the assistant sees
 * is decided entirely at runtime. These tests pin each host → interface id
 * mapping and the precedence between overlapping signals.
 *
 * `isElectron()` and `isNativePlatform()` are mocked (the flavor.test.ts
 * pattern); the UA-based `isIOSBrowser()` lives in the module under test, so
 * the iOS-browser case is driven by overriding `navigator.userAgent`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

let electron = false;
let nativePlatform = false;

mock.module("@/runtime/is-electron", () => ({ isElectron: () => electron }));
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => nativePlatform,
}));

const { detectInterfaceId } = await import("@/runtime/platform-detection");

const ORIGINAL_UA = navigator.userAgent;
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function setUserAgent(ua: string): void {
  Object.defineProperty(navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

afterEach(() => {
  electron = false;
  nativePlatform = false;
  setUserAgent(ORIGINAL_UA);
});

describe("detectInterfaceId", () => {
  test("returns 'macos' inside the Electron desktop shell", () => {
    electron = true;
    expect(detectInterfaceId()).toBe("macos");
  });

  test("returns 'ios' inside the Capacitor native shell", () => {
    nativePlatform = true;
    expect(detectInterfaceId()).toBe("ios");
  });

  test("returns 'ios' for a mobile iOS browser when Capacitor is absent", () => {
    setUserAgent(IPHONE_UA);
    expect(detectInterfaceId()).toBe("ios");
  });

  test("returns 'web' for a plain desktop browser", () => {
    expect(detectInterfaceId()).toBe("web");
  });

  test("prefers 'macos' when both the Electron and iOS signals are present", () => {
    // The Electron macOS shell also satisfies the iOS/native heuristics in
    // some configurations; `isElectron()` must win so macOS isn't reported
    // as iOS.
    electron = true;
    nativePlatform = true;
    setUserAgent(IPHONE_UA);
    expect(detectInterfaceId()).toBe("macos");
  });
});
