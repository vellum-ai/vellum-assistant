/**
 * Unit tests for `detectClientOs`.
 *
 * The same `clients/web` bundle ships to a plain browser, the Capacitor mobile
 * shells, and the Electron desktop apps, so the OS surface is decided at
 * runtime. These tests pin each host → OS mapping and the
 * precedence between overlapping signals.
 *
 * `isElectron()` and `isNativePlatform()` are mocked (the flavor.test.ts
 * pattern); the UA-based `isIOSBrowser()` / `isAndroidBrowser()` live in the
 * module under test, so the browser cases are driven by overriding
 * `navigator.userAgent`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { ElectronHostOS } from "@/runtime/platform-detection";

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

const {
  detectClientOs,
  isNativeAndroid,
  isNativeIOS,
  isNativeMobile,
  useIsAndroidWeb,
  useIsNativeIOS,
  useIsNativeMobile,
} = await import("@/runtime/platform-detection");

const ORIGINAL_UA = navigator.userAgent;
const ORIGINAL_PLATFORM = navigator.platform;
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

function setPlatform(platform: string): void {
  Object.defineProperty(navigator, "platform", {
    value: platform,
    configurable: true,
  });
}

function setElectronHost(hostOS?: ElectronHostOS): void {
  electron = true;
  (
    window as unknown as {
      vellum?: { platform: "electron"; hostOS?: ElectronHostOS };
    }
  ).vellum = {
    platform: "electron",
    ...(hostOS ? { hostOS } : {}),
  };
}

afterEach(() => {
  cleanup();
  electron = false;
  nativePlatform = false;
  nativeOsPlatform = "web";
  delete (window as unknown as { vellum?: unknown }).vellum;
  setUserAgent(ORIGINAL_UA);
  setPlatform(ORIGINAL_PLATFORM);
});

describe("detectClientOs", () => {
  test("returns 'windows' inside the Windows Electron shell", () => {
    setElectronHost("windows");
    expect(detectClientOs()).toBe("windows");
  });

  test("returns 'macos' inside the macOS Electron shell", () => {
    setElectronHost("macos");
    expect(detectClientOs()).toBe("macos");
  });

  test("uses the renderer platform for legacy Electron bridges", () => {
    setElectronHost();
    setPlatform("MacIntel");
    expect(detectClientOs()).toBe("macos");

    setPlatform("Win32");
    expect(detectClientOs()).toBe("windows");
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
    setElectronHost("macos");
    nativePlatform = true;
    setUserAgent(IPHONE_UA);
    expect(detectClientOs()).toBe("macos");
  });
});

describe("useIsNativeIOS", () => {
  test("is true inside the Capacitor iOS native shell", () => {
    nativePlatform = true;
    nativeOsPlatform = "ios";
    expect(renderHook(() => useIsNativeIOS()).result.current).toBe(true);
  });

  test("is false outside a native shell", () => {
    expect(renderHook(() => useIsNativeIOS()).result.current).toBe(false);
  });
});

describe("useIsAndroidWeb", () => {
  test("is true in an Android browser", () => {
    setUserAgent(ANDROID_UA);
    expect(renderHook(() => useIsAndroidWeb()).result.current).toBe(true);
  });

  test("is false inside the native Android shell", () => {
    setUserAgent(ANDROID_UA);
    nativePlatform = true;
    nativeOsPlatform = "android";
    expect(renderHook(() => useIsAndroidWeb()).result.current).toBe(false);
  });

  test("is false in a desktop browser", () => {
    expect(renderHook(() => useIsAndroidWeb()).result.current).toBe(false);
  });
});

describe("native mobile shell detection", () => {
  test("distinguishes the native iOS shell", () => {
    nativePlatform = true;
    nativeOsPlatform = "ios";

    expect(isNativeIOS()).toBe(true);
    expect(isNativeAndroid()).toBe(false);
    expect(isNativeMobile()).toBe(true);
    expect(renderHook(() => useIsNativeMobile()).result.current).toBe(true);
  });

  test("distinguishes the native Android shell", () => {
    nativePlatform = true;
    nativeOsPlatform = "android";

    expect(isNativeIOS()).toBe(false);
    expect(isNativeAndroid()).toBe(true);
    expect(isNativeMobile()).toBe(true);
    expect(renderHook(() => useIsNativeMobile()).result.current).toBe(true);
  });

  test("excludes other native platforms", () => {
    nativePlatform = true;
    nativeOsPlatform = "macos";

    expect(isNativeMobile()).toBe(false);
    expect(renderHook(() => useIsNativeMobile()).result.current).toBe(false);
  });

  test("does not treat mobile browsers as native shells", () => {
    setUserAgent(ANDROID_UA);

    expect(isNativeAndroid()).toBe(false);
    expect(isNativeMobile()).toBe(false);
  });
});
