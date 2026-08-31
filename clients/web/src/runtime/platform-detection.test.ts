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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
  isMobileBrowser,
  isNativeAndroid,
  isNativeIOS,
  isNativeMobile,
  useIsAndroidWeb,
  useIsIOSSafariWeb,
  useIsIOSWeb,
  useIsMobileWeb,
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
const IPHONE_CHROME_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1";
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
// Chrome on an Android tablet carries neither "Mobi" nor "Tablet", so it is
// only caught by the media-query layer.
const ANDROID_TABLET_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DESKTOP_SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const WINDOWS_TOUCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CHROMEOS_TOUCH_UA =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const LINUX_TOUCH_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const ORIGINAL_MATCH_MEDIA = window.matchMedia;

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

function setUserAgentData(uaData: { mobile?: boolean } | undefined): void {
  Object.defineProperty(navigator, "userAgentData", {
    value: uaData,
    configurable: true,
  });
}

/** Stub `matchMedia` so only the listed queries match. */
function setMediaMatches(matches: Record<string, boolean>): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matches[query] ?? false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
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
  setUserAgentData(undefined);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: ORIGINAL_MATCH_MEDIA,
  });
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

describe("isMobileBrowser", () => {
  beforeEach(() => {
    setMediaMatches({});
  });

  test("is true on an iPhone", () => {
    setUserAgent(IPHONE_UA);
    expect(isMobileBrowser()).toBe(true);
  });

  test("is true on an iPad", () => {
    setUserAgent(IPAD_UA);
    expect(isMobileBrowser()).toBe(true);
  });

  test("is true on an Android phone", () => {
    setUserAgent(ANDROID_UA);
    expect(isMobileBrowser()).toBe(true);
  });

  test("is true on an Android tablet via the media-query fallback", () => {
    setUserAgent(ANDROID_TABLET_UA);
    setMediaMatches({ "(pointer: coarse)": true, "(hover: none)": true });
    expect(isMobileBrowser()).toBe(true);
  });

  test("trusts userAgentData.mobile over the user agent string", () => {
    setUserAgent(DESKTOP_CHROME_UA);
    setUserAgentData({ mobile: true });
    expect(isMobileBrowser()).toBe(true);
  });

  test("is false in desktop Chrome", () => {
    setUserAgent(DESKTOP_CHROME_UA);
    setUserAgentData({ mobile: false });
    expect(isMobileBrowser()).toBe(false);
  });

  test("is false in desktop Safari", () => {
    setUserAgent(DESKTOP_SAFARI_UA);
    expect(isMobileBrowser()).toBe(false);
  });

  test("is false on a touchscreen desktop that still reports hover", () => {
    // A touchscreen laptop is `pointer: coarse` but `hover: hover`, so the
    // hover half of the fallback is what keeps it out.
    setUserAgent(WINDOWS_TOUCH_UA);
    setUserAgentData({ mobile: false });
    setMediaMatches({ "(pointer: coarse)": true, "(hover: none)": false });
    expect(isMobileBrowser()).toBe(false);
  });

  test("is false on a hoverless Windows tablet", () => {
    // Coarse and hoverless input is an input signal, not a platform one. A
    // Windows tablet reports both and is still a desktop.
    setUserAgent(WINDOWS_TOUCH_UA);
    setUserAgentData({ mobile: false });
    setMediaMatches({ "(pointer: coarse)": true, "(hover: none)": true });
    expect(isMobileBrowser()).toBe(false);
  });

  test("is false on a hoverless ChromeOS tablet", () => {
    setUserAgent(CHROMEOS_TOUCH_UA);
    setUserAgentData({ mobile: false });
    setMediaMatches({ "(pointer: coarse)": true, "(hover: none)": true });
    expect(isMobileBrowser()).toBe(false);
  });

  test("is false on a hoverless Linux touch device", () => {
    setUserAgent(LINUX_TOUCH_UA);
    setUserAgentData({ mobile: false });
    setMediaMatches({ "(pointer: coarse)": true, "(hover: none)": true });
    expect(isMobileBrowser()).toBe(false);
  });

  test("is still true for iPadOS in desktop mode", () => {
    // A Mac user agent with coarse hoverless input is an iPad requesting the
    // desktop site, so `Macintosh` must stay out of the desktop exclusion.
    setUserAgent(DESKTOP_SAFARI_UA);
    setMediaMatches({ "(pointer: coarse)": true, "(hover: none)": true });
    expect(isMobileBrowser()).toBe(true);
  });

  test("is false without a navigator", () => {
    const originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
    });
    try {
      expect(isMobileBrowser()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
      });
    }
  });

  test("is false without matchMedia", () => {
    setUserAgent(ANDROID_TABLET_UA);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    expect(isMobileBrowser()).toBe(false);
  });
});

describe("useIsIOSSafariWeb", () => {
  beforeEach(() => {
    setMediaMatches({});
  });

  test("is true in iOS Safari", () => {
    setUserAgent(IPHONE_UA);
    expect(renderHook(() => useIsIOSSafariWeb()).result.current).toBe(true);
  });

  test("is false in iOS Chrome", () => {
    setUserAgent(IPHONE_CHROME_UA);
    expect(renderHook(() => useIsIOSSafariWeb()).result.current).toBe(false);
  });

  test("is false in desktop Safari", () => {
    setUserAgent(DESKTOP_SAFARI_UA);
    expect(renderHook(() => useIsIOSSafariWeb()).result.current).toBe(false);
  });

  test("is false inside the Capacitor iOS shell", () => {
    setUserAgent(IPHONE_UA);
    nativePlatform = true;
    nativeOsPlatform = "ios";
    expect(renderHook(() => useIsIOSSafariWeb()).result.current).toBe(false);
  });

  test("suppresses the mobile nudge that useIsIOSWeb alone would miss", () => {
    // Apple's Smart App Banner already covers iOS Safari, so `useIsIOSWeb`
    // opts it out. `useIsMobileWeb` does not, and a cascade that falls back
    // to it would double-nudge; this hook is what closes that gap.
    setUserAgent(IPHONE_UA);

    expect(renderHook(() => useIsIOSWeb()).result.current).toBe(false);
    expect(renderHook(() => useIsMobileWeb()).result.current).toBe(true);
    expect(renderHook(() => useIsIOSSafariWeb()).result.current).toBe(true);
  });
});

describe("useIsMobileWeb", () => {
  beforeEach(() => {
    setMediaMatches({});
  });

  test("is true in a mobile browser", () => {
    setUserAgent(ANDROID_UA);
    expect(renderHook(() => useIsMobileWeb()).result.current).toBe(true);
  });

  test("does not exclude iOS Safari", () => {
    setUserAgent(IPHONE_UA);
    expect(renderHook(() => useIsMobileWeb()).result.current).toBe(true);
  });

  test("is false inside the Capacitor shell", () => {
    setUserAgent(IPHONE_UA);
    nativePlatform = true;
    nativeOsPlatform = "ios";
    expect(renderHook(() => useIsMobileWeb()).result.current).toBe(false);
  });

  test("is false inside the Electron shell", () => {
    setUserAgent(IPAD_UA);
    setElectronHost("macos");
    expect(renderHook(() => useIsMobileWeb()).result.current).toBe(false);
  });

  test("is false in a desktop browser", () => {
    setUserAgent(DESKTOP_CHROME_UA);
    setUserAgentData({ mobile: false });
    expect(renderHook(() => useIsMobileWeb()).result.current).toBe(false);
  });
});
