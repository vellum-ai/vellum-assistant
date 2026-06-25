import { useSyncExternalStore } from "react";

import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";

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

/**
 * The canonical `InterfaceId` values this web bundle can report.
 *
 * The same `clients/web` bundle is loaded by three hosts — a plain browser,
 * the Capacitor iOS shell, and the Electron macOS app — so the platform the
 * assistant sees is decided at runtime, not by which build is shipped. The
 * other backend interface ids (`cli`, `telegram`, `phone`, …) originate from
 * non-browser channels and are never produced here. Mirrors the backend
 * `InterfaceId` union in `gateway/src/channels/types.ts`.
 */
export type ClientInterfaceId = "macos" | "ios" | "web";

/**
 * Resolve the interface id for this client at runtime.
 *
 * This single helper is the source of truth for both the message body's
 * `interface` field (`domains/chat/api/messages.ts`) and the
 * `X-Vellum-Interface-Id` registration header
 * (`lib/telemetry/client-identity.ts`) so the two can never disagree. The
 * assistant turns the body value into the per-turn `client_os` context
 * (`assistant/src/daemon/conversation-runtime-assembly.ts`) and uses the
 * header to route interface-scoped SSE events.
 *
 * Order matters: the Electron macOS shell also satisfies the desktop-browser
 * heuristics, so `isElectron()` is checked first or macOS would be
 * misreported as `web`. The Capacitor iOS shell (`isNativePlatform()`) is
 * checked alongside the UA-based `isIOSBrowser()` so both the native wrapper
 * and a mobile-Safari tab report `ios`. Everything else is `web`.
 *
 * Safe to call before hydration: each underlying helper falls through to
 * `false` when `window`/`navigator` are undefined, so SSR resolves to `web`.
 */
export function detectInterfaceId(): ClientInterfaceId {
  if (isElectron()) return "macos";
  if (isNativePlatform() || isIOSBrowser()) return "ios";
  return "web";
}

// ---------------------------------------------------------------------------
// React hooks — safe thin wrappers for use in component render bodies
// ---------------------------------------------------------------------------

const noop = () => () => {};

/**
 * iOS web user who should see custom nudge surfaces.
 *
 * Excludes Safari because Safari users already see the native Smart App Banner
 * (via the `<meta name="apple-itunes-app">` tag), which provides a better,
 * Apple-native download experience. Custom nudge surfaces only target
 * non-Safari iOS browsers (Chrome, Firefox, Edge, etc.).
 */
export function useIsIOSWeb(): boolean {
  return useSyncExternalStore(
    noop,
    () => isIOSBrowser() && !isNativePlatform() && !isSafariBrowser(),
    () => false,
  );
}

/**
 * macOS web user who should see custom nudge surfaces.
 *
 * Excludes Electron because the user is already inside the macOS desktop
 * app — showing a "download the macOS app" nudge would be nonsensical.
 * Also excludes Capacitor (via `isNativePlatform()`) for symmetry with
 * the iOS hook above.
 */
export function useIsMacOSWeb(): boolean {
  return useSyncExternalStore(
    noop,
    () => isMacOSBrowser() && !isNativePlatform() && !isElectron(),
    () => false,
  );
}
