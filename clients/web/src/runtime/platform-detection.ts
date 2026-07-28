import { Capacitor } from "@capacitor/core";
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
  return (
    /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium/.test(ua)
  );
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
 * Returns true when the current browser is running on Android.
 *
 * Android user agents always carry the literal "Android" token (Chrome,
 * Samsung Internet, Firefox, WebView, etc.), so a substring check is the
 * reliable signal. Used so Android phone-web gets the same mobile-first
 * treatment as iOS phone-web.
 *
 * Always returns `false` during SSR (no `navigator`).
 */
export function isAndroidBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

/**
 * The OS surfaces this web bundle can report as `clientOs`.
 *
 * The same `clients/web` bundle runs in a plain browser, the Capacitor iOS
 * shell, and the Electron macOS app, so the OS is decided at runtime, not by
 * which build is shipped. This is NOT the backend interface vocabulary —
 * `clientOs` describes the device OS (`android` has no transport), so it is a
 * deliberately separate set from `InterfaceId` (mirrors the daemon's
 * `ClientOs` in `assistant/src/channels/types.ts`).
 */
export type ClientOs = "macos" | "ios" | "android" | "web";

/**
 * Detect the client's OS surface ("web" | "ios" | "macos" | "android") at
 * runtime.
 *
 * This feeds the message body's `clientOs` field ONLY
 * (`domains/chat/api/messages.ts`), which the assistant renders as the
 * per-turn `client_os` context line
 * (`assistant/src/daemon/conversation-runtime-assembly.ts`).
 *
 * It must NOT drive the message body's `interface` field or the
 * `X-Vellum-Interface-Id` registration header — those are the *transport*
 * surface and are intentionally hardcoded to `"web"` (the web/iOS/macOS apps
 * all run this one renderer = one transport). The daemon keys host-proxy and
 * transport capabilities off that transport interface, so reporting the OS
 * there would mis-tag a renderer turn as a host-proxy transport. Keep OS
 * detection on `clientOs` only; do not re-couple it to interface/header
 * identity.
 *
 * Order matters: the Electron macOS shell also satisfies the desktop-browser
 * heuristics, so `isElectron()` is checked first or macOS would be misreported
 * as `web`. A native Capacitor shell (`isNativePlatform()`, true for iOS AND
 * Android) is resolved via `Capacitor.getPlatform()` so the wrapper reports
 * its real OS. The remaining browser surfaces fall to the UA-based
 * `isIOSBrowser()` / `isAndroidBrowser()` (so mobile-Safari → `ios`, Android
 * Chrome → `android`); everything else is `web`.
 *
 * Safe to call before hydration: each underlying helper falls through to
 * `false` when `window`/`navigator` are undefined, so SSR resolves to `web`.
 */
export function detectClientOs(): ClientOs {
  if (isElectron()) return "macos";
  if (isNativePlatform()) {
    // `isNativePlatform()` is true for the iOS AND Android Capacitor shells,
    // so distinguish them explicitly rather than assuming iOS.
    return Capacitor.getPlatform() === "android" ? "android" : "ios";
  }
  if (isIOSBrowser()) return "ios";
  if (isAndroidBrowser()) return "android";
  return "web";
}

/**
 * True only on the native Capacitor iOS runtime (the WKWebView shell) —
 * `Capacitor.isNativePlatform()` AND `Capacitor.getPlatform() === "ios"`.
 *
 * Distinct from `isIOSBrowser()` (iOS mobile Safari/Chrome, NOT the shell) and
 * from `isNativePlatform()` (true for the iOS AND Android shells). Use this to
 * gate iOS-shell-only behavior — most notably any pre-permission UI before an
 * OS permission alert (`getUserMedia`, `Notification.requestPermission`, etc.),
 * which per `docs/CAPACITOR.md` § OS permission requests must be skipped (or
 * carry zero exit affordances) so it leads directly to the system alert per
 * Apple HIG / App Store Review 5.1.1(iv). Android is excluded because no native
 * Capacitor Android shell ships today (mirrors `isRemotePushSupported`);
 * revisit if one does. Safe server-side — falls through to `false` before
 * hydration.
 */
export function isNativeIOS(): boolean {
  return isNativePlatform() && Capacitor.getPlatform() === "ios";
}

/**
 * Browser attribution for turn telemetry (`metadata.client.browser_family` /
 * `.browser_version`). Family is engine-level: Chromium derivatives without
 * their own brand entry (Opera, Brave, Arc) report as `"chrome"`.
 */
export type BrowserInfo = {
  family?: "chrome" | "edge" | "firefox" | "safari";
  version?: string;
};

type UADataBrand = { brand: string; version: string };

/**
 * Detect the browser from `navigator.userAgentData.brands` (Chromium-only
 * API). Brand names are full strings like "Microsoft Edge" / "Google Chrome"
 * / "Chromium"; GREASE entries ("Not_A Brand" and friends) match neither
 * pattern. The brand version is the (possibly reduced) major version.
 */
function browserFromBrands(
  brands: UADataBrand[] | undefined,
): BrowserInfo | null {
  if (!brands || brands.length === 0) {
    return null;
  }
  const families = [
    { family: "edge", pattern: /microsoft edge/i },
    { family: "chrome", pattern: /google chrome|chromium/i },
  ] as const;
  for (const { family, pattern } of families) {
    const match = brands.find((brand) => pattern.test(brand.brand));
    if (match) {
      const version = match.version.match(/^\d+/)?.[0];
      return { family, ...(version ? { version } : {}) };
    }
  }
  return null;
}

/**
 * Detect the browser from the UA string (Safari and Firefox never expose
 * `userAgentData`). Order matters: Edge UAs contain "Chrome/", Chrome and
 * Firefox UAs contain "Safari/", so Safari's `Version/` pattern goes last.
 * iOS third-party browsers use injected engine tokens (EdgiOS / CriOS /
 * FxiOS — same token set as `isSafariBrowser`).
 */
function browserFromUserAgent(ua: string): BrowserInfo | null {
  const patterns = [
    { family: "edge", pattern: /(?:Edg|EdgiOS|EdgA)\/(\d+)/ },
    { family: "chrome", pattern: /(?:Chrome|CriOS|Chromium)\/(\d+)/ },
    { family: "firefox", pattern: /(?:Firefox|FxiOS)\/(\d+)/ },
    { family: "safari", pattern: /Version\/(\d+).*Safari\// },
  ] as const;
  for (const { family, pattern } of patterns) {
    const match = ua.match(pattern);
    if (match) {
      return { family, version: match[1] };
    }
  }
  return null;
}

/**
 * Detect the current browser's family and major version for telemetry.
 * Prefers `userAgentData.brands` where available, falls back to UA-string
 * parsing. Returns `{}` when neither yields a match (or during SSR).
 */
export function detectBrowserInfo(): BrowserInfo {
  if (typeof navigator === "undefined") {
    return {};
  }
  const uaData = (
    navigator as Navigator & {
      userAgentData?: { brands?: UADataBrand[] };
    }
  ).userAgentData;
  return (
    browserFromBrands(uaData?.brands) ??
    browserFromUserAgent(navigator.userAgent) ??
    {}
  );
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
