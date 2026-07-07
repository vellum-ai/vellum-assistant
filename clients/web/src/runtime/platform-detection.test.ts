/**
 * Unit tests for `detectClientOs`.
 *
 * The same `clients/web` bundle ships to a plain browser, the Capacitor iOS
 * shell, and the Electron macOS app, so the OS surface the assistant sees is
 * decided entirely at runtime. These tests pin each host → OS mapping and the
 * precedence between overlapping signals.
 *
 * `isElectron()` and `isNativePlatform()` are mocked (the flavor.test.ts
 * pattern); the UA-based `isIOSBrowser()` / `isAndroidBrowser()` live in the
 * module under test, so the browser cases are driven by overriding
 * `navigator.userAgent`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

let electron = false;
let nativePlatform = false;
// What `Capacitor.getPlatform()` reports inside a native shell ("ios" |
// "android"). Only consulted when `nativePlatform` is true.
let nativeOsPlatform = "web";

mock.module("@/runtime/is-electron", () => ({ isElectron: () => electron }));
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => nativePlatform,
}));
mock.module("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => nativeOsPlatform },
}));

const { detectClientOs, detectClientShell } = await import(
  "@/runtime/platform-detection"
);

const ORIGINAL_UA = navigator.userAgent;
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

function setUserAgent(ua: string): void {
  Object.defineProperty(navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

afterEach(() => {
  electron = false;
  nativePlatform = false;
  nativeOsPlatform = "web";
  setUserAgent(ORIGINAL_UA);
});

describe("detectClientOs", () => {
  test("returns 'macos' inside the Electron desktop shell", () => {
    electron = true;
    expect(detectClientOs()).toBe("macos");
  });

  test("returns 'ios' inside the Capacitor iOS native shell", () => {
    nativePlatform = true;
    nativeOsPlatform = "ios";
    expect(detectClientOs()).toBe("ios");
  });

  test("returns 'android' inside the Capacitor Android native shell", () => {
    // `isNativePlatform()` is true for both shells, so the native branch must
    // read `Capacitor.getPlatform()` to avoid mislabeling Android as iOS.
    nativePlatform = true;
    nativeOsPlatform = "android";
    expect(detectClientOs()).toBe("android");
  });

  test("returns 'ios' for a mobile iOS browser when Capacitor is absent", () => {
    setUserAgent(IPHONE_UA);
    expect(detectClientOs()).toBe("ios");
  });

  test("returns 'android' for an Android phone browser", () => {
    setUserAgent(ANDROID_UA);
    expect(detectClientOs()).toBe("android");
  });

  test("returns 'web' for a plain desktop browser", () => {
    expect(detectClientOs()).toBe("web");
  });

  test("prefers 'macos' when both the Electron and iOS signals are present", () => {
    // The Electron macOS shell also satisfies the iOS/native heuristics in
    // some configurations; `isElectron()` must win so macOS isn't reported
    // as iOS.
    electron = true;
    nativePlatform = true;
    setUserAgent(IPHONE_UA);
    expect(detectClientOs()).toBe("macos");
  });
});

describe("detectClientShell", () => {
  test("returns 'electron' inside the Electron desktop shell", () => {
    electron = true;
    expect(detectClientShell()).toBe("electron");
  });

  test("returns 'capacitor' inside the Capacitor native shell", () => {
    nativePlatform = true;
    expect(detectClientShell()).toBe("capacitor");
  });

  test("returns 'browser' in a plain browser", () => {
    expect(detectClientShell()).toBe("browser");
  });

  test("prefers 'electron' when both the Electron and native signals are present", () => {
    // The Electron macOS shell also satisfies the native heuristics;
    // `isElectron()` must win so it isn't reported as 'capacitor'.
    electron = true;
    nativePlatform = true;
    expect(detectClientShell()).toBe("electron");
  });
});
