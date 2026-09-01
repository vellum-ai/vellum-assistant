import type { ElectronHostOS } from "@vellumai/ipc-contract";
import { useSyncExternalStore } from "react";

import { isElectron } from "@/runtime/is-electron";

export type DesktopAppPlatform = ElectronHostOS;

export function getBrowserPlatform(): string {
  if (typeof navigator === "undefined") {
    return "";
  }
  const uaData = (
    navigator as Navigator & {
      userAgentData?: { platform?: string };
    }
  ).userAgentData;
  return uaData?.platform || navigator.platform;
}

/** Windows is the only positive match; every other signal defaults to macOS. */
export function detectDesktopAppPlatform(): DesktopAppPlatform {
  if (typeof navigator === "undefined") {
    return "macos";
  }
  if (isElectron() && window.vellum?.hostOS) {
    return window.vellum.hostOS;
  }

  return isWindowsBrowser() ? "windows" : "macos";
}

/** True when browser platform signals identify Windows. */
export function isWindowsBrowser(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return (
    /win/i.test(getBrowserPlatform()) || /Windows/i.test(navigator.userAgent)
  );
}

/** True when browser signals identify a desktop OS without a Vellum app. */
export function isKnownUnsupportedDesktopBrowser(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const platformSignals = `${getBrowserPlatform()} ${navigator.userAgent}`;
  return /\b(?:CrOS|Linux|X11|FreeBSD|OpenBSD|NetBSD)\b/i.test(
    platformSignals,
  );
}

const noop = () => () => {};

/** Hook form of `detectDesktopAppPlatform()`, safe in render bodies. */
export function useDesktopAppPlatform(): DesktopAppPlatform {
  return useSyncExternalStore(noop, detectDesktopAppPlatform, () => "macos");
}
