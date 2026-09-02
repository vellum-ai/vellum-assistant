/**
 * Pins the mobile leg of the nudge cascade: which device resolves which
 * promotion, and the one device that must resolve none.
 *
 * Driven through `navigator.userAgent` rather than a module mock, so the real
 * detection helpers are what decide. The rest of the cascade (turn counting,
 * GitHub, Discord) runs against an empty transcript, which leaves it inert.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useAppNudges } from "@/domains/chat/hooks/use-app-nudges";

const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
// A phone whose OS neither the iOS nor the Android check can name, caught
// only by the `Mobi` token.
const UNIDENTIFIED_PHONE_UA =
  "Mozilla/5.0 (Mobile; rv:109.0) Gecko/109.0 Firefox/115.0";
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAC_SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const ORIGINAL_UA = navigator.userAgent;
const ORIGINAL_PLATFORM = navigator.platform;

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

function renderNudges() {
  return renderHook(() => useAppNudges([], 0, null, null)).result;
}

beforeEach(() => {
  localStorage.clear();
  setUserAgent(DESKTOP_CHROME_UA);
  setPlatform("Win32");
});

afterEach(() => {
  cleanup();
  setUserAgent(ORIGINAL_UA);
  setPlatform(ORIGINAL_PLATFORM);
});

describe("useAppNudges mobile promotion", () => {
  test("suppresses the promotion on iOS Safari", () => {
    // Apple's Smart App Banner already offers the app there. `useIsIOSWeb`
    // opts Safari out, but `useIsMobileWeb` does not, so the generic fallback
    // would double-nudge without the explicit Safari guard.
    setUserAgent(IPHONE_SAFARI_UA);

    const result = renderNudges();
    expect(result.current.mobilePromotion).toBeNull();
    expect(result.current.isOnNudgePlatform).toBe(false);
    expect(result.current.showBanner).toBe(false);
  });

  test("names the iOS app off Safari", () => {
    setUserAgent(IPHONE_CHROME_UA);

    expect(renderNudges().current.mobilePromotion).toMatchObject({
      target: "ios",
      appName: "iOS",
    });
  });

  test("promotes on Android even with no Play Store URL configured", () => {
    // The unconfigured deployment used to resolve nothing here, which left
    // every Android reader with no banner at all.
    setUserAgent(ANDROID_UA);

    expect(renderNudges().current.mobilePromotion).toMatchObject({
      target: "generic",
      appName: null,
    });
  });

  test("falls back to the generic promotion on an unidentified phone", () => {
    setUserAgent(UNIDENTIFIED_PHONE_UA);

    expect(renderNudges().current.mobilePromotion).toMatchObject({
      target: "generic",
      appName: null,
    });
  });

  test("leaves macOS to its own nudge", () => {
    setUserAgent(MAC_SAFARI_UA);
    setPlatform("MacIntel");

    const result = renderNudges();
    expect(result.current.mobilePromotion).toBeNull();
    expect(result.current.isOnMacOS).toBe(true);
    expect(result.current.isOnNudgePlatform).toBe(true);
  });

  test("resolves nothing on a plain desktop browser", () => {
    const result = renderNudges();
    expect(result.current.mobilePromotion).toBeNull();
    expect(result.current.isOnNudgePlatform).toBe(false);
    expect(result.current.showBanner).toBe(false);
  });
});
