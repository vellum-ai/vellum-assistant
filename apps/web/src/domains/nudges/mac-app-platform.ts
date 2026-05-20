import { useSyncExternalStore } from "react";

import { isNativePlatform } from "@/runtime/native-auth.js";
import { isIOSBrowser } from "@/domains/nudges/ios-app-platform.js";

/**
 * Returns true when the current browser is running on macOS (not iOS).
 * Uses `navigator.userAgentData` where available (Chrome/Edge), falls back
 * to `navigator.platform` for Safari and Firefox.
 *
 * iPadOS 13+ sends a macOS user agent by default, so this function
 * explicitly excludes iOS devices (detected via `isIOSBrowser()`) to
 * prevent iPads from seeing the macOS download nudge.
 *
 * Always returns `false` during SSR (no `navigator`).
 */
export function isMacOSBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  if (isIOSBrowser()) return false;
  const uaData = (
    navigator as Navigator & {
      userAgentData?: { platform?: string };
    }
  ).userAgentData;
  if (uaData?.platform) {
    return uaData.platform.toLowerCase().includes("mac");
  }
  return navigator.platform.toLowerCase().includes("mac");
}

function isMacOSWeb(): boolean {
  return isMacOSBrowser() && !isNativePlatform();
}

const noop = () => () => {};

export function useIsMacOSWeb(): boolean {
  return useSyncExternalStore(noop, isMacOSWeb, () => false);
}
