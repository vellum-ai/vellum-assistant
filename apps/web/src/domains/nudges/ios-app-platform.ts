import { useSyncExternalStore } from "react";

import { isNativePlatform } from "@/runtime/native-auth.js";

/**
 * Returns true when the current browser is running on iOS (iPhone, iPod, or iPad).
 *
 * iPadOS 13+ sends a macOS user agent by default ("Request Desktop Website"),
 * so `navigator.userAgent` alone misses iPads. We detect them via
 * `navigator.maxTouchPoints > 1` combined with a Mac platform string —
 * real Macs report 0 or 1 touch points.
 *
 * Ref: https://developer.apple.com/forums/thread/119186
 *
 * Always returns `false` during SSR (no `navigator`).
 */
export function isIOSBrowser(): boolean {
  if (typeof navigator === "undefined") return false;

  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return true;
  if (/iPad/.test(ua)) return true;

  // iPadOS 13+ in desktop mode: reports as Mac but has multitouch
  const uaData = (
    navigator as Navigator & {
      userAgentData?: { platform?: string };
    }
  ).userAgentData;
  const isMacPlatform = uaData?.platform
    ? uaData.platform.toLowerCase().includes("mac")
    : navigator.platform.toLowerCase().includes("mac");

  return isMacPlatform && navigator.maxTouchPoints > 1;
}

/**
 * Returns true when the browser is Safari (desktop or iOS).
 *
 * Chromium-based browsers (Chrome, Edge, Opera, Brave, etc.) include
 * "Safari/537.36" in their UA for compatibility, but also include "Chrome".
 * On iOS, third-party browsers inject engine tokens: CriOS (Chrome),
 * FxiOS (Firefox), EdgiOS (Edge), OPiOS (Opera). Real Safari has none of
 * these markers.
 *
 * Ref: https://developer.chrome.com/docs/multidevice/user-agent/#chrome_for_ios_user_agent
 */
export function isSafariBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium/.test(ua);
}

/**
 * iOS web user who should see our custom nudge surfaces.
 *
 * Excludes Safari because Safari users already see the native Smart App Banner
 * (via the <meta name="apple-itunes-app"> tag in layout.tsx), which provides a
 * better, Apple-native download experience. Our custom nudge surfaces only
 * target non-Safari iOS browsers (Chrome, Firefox, Edge, etc.) that don't
 * support the Smart App Banner.
 */
function isIOSWeb(): boolean {
  return isIOSBrowser() && !isNativePlatform() && !isSafariBrowser();
}

const noop = () => () => {};

export function useIsIOSWeb(): boolean {
  return useSyncExternalStore(noop, isIOSWeb, () => false);
}
