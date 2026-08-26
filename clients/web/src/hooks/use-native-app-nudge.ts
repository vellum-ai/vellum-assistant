import { useCallback, useEffect, useMemo, useState } from "react";

import { VELLUM_DOWNLOADS_URL } from "@/utils/external-urls";
import {
  getLocalBool,
  getLocalNumber,
  setLocalBool,
  setLocalNumber,
} from "@/utils/local-settings";

export type NativeAppPlatform = "ios" | "android";

export type NudgeTarget = NativeAppPlatform | "generic";

export interface NativeAppPromotion {
  target: NudgeTarget;
  appName: string | null;
  storeUrl: string;
}

export const NATIVE_APP_BANNER_MIN_TURNS = 5;

/** App Store listing for Vellum Assistant (id6759934423). */
export const IOS_APP_STORE_URL =
  "https://apps.apple.com/us/app/vellum-assistant/id6759934423";

const ANDROID_PACKAGE_ID = "ai.vellum.assistant";

/** Verbatim value Android's `getInstallReferrer()` returns after install. */
const ANDROID_INSTALL_REFERRER =
  "utm_source=vellum-app&utm_medium=in-app-nudge";

export const ANDROID_PLAY_STORE_URL =
  `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE_ID}` +
  `&referrer=${encodeURIComponent(ANDROID_INSTALL_REFERRER)}`;

const STORAGE_KEYS: Record<
  NudgeTarget,
  { downloaded: string; bannerDismissed: string; assistantTurnsSeen: string }
> = {
  ios: {
    downloaded: "app.iosNudge.downloaded",
    bannerDismissed: "app.iosNudge.bannerDismissed",
    assistantTurnsSeen: "app.iosNudge.assistantTurnsSeen",
  },
  android: {
    downloaded: "app.androidNudge.downloaded",
    bannerDismissed: "app.androidNudge.bannerDismissed",
    assistantTurnsSeen: "app.androidNudge.assistantTurnsSeen",
  },
  generic: {
    downloaded: "app.mobileNudge.downloaded",
    bannerDismissed: "app.mobileNudge.bannerDismissed",
    assistantTurnsSeen: "app.mobileNudge.assistantTurnsSeen",
  },
};

const NUDGE_TARGETS: readonly NudgeTarget[] = ["ios", "android", "generic"];

function resolveAndroidPlayStoreUrl(): string | null {
  const configuredUrl = import.meta.env.VITE_ANDROID_PLAY_STORE_URL?.trim();
  if (!configuredUrl) {
    return null;
  }

  try {
    const url = new URL(configuredUrl);
    const isExpectedListing =
      url.protocol === "https:" &&
      url.hostname === "play.google.com" &&
      url.pathname === "/store/apps/details" &&
      url.searchParams.get("id") === ANDROID_PACKAGE_ID;
    return isExpectedListing ? ANDROID_PLAY_STORE_URL : null;
  } catch (error) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

export function getNativeAppName(platform: NativeAppPlatform): string {
  return platform === "ios" ? "iOS" : "Android";
}

export function resolveMobilePromotion(
  platform: NativeAppPlatform | null,
): NativeAppPromotion {
  if (platform === "ios") {
    return {
      target: "ios",
      appName: getNativeAppName("ios"),
      storeUrl: IOS_APP_STORE_URL,
    };
  }

  if (platform === "android") {
    const storeUrl = resolveAndroidPlayStoreUrl();
    if (storeUrl) {
      return {
        target: "android",
        appName: getNativeAppName("android"),
        storeUrl,
      };
    }
  }

  return {
    target: "generic",
    appName: null,
    storeUrl: VELLUM_DOWNLOADS_URL,
  };
}

function targetPlatform(target: NudgeTarget): NativeAppPlatform | null {
  return target === "generic" ? null : target;
}

// One person can change target mid-session (Android's "Request desktop site"
// hides the OS from the user agent), so reads fan out across every target
// while writes stay target-specific: a fresh key set would re-nudge someone
// who already said no.
export function readNativeAppDownloaded(_target: NudgeTarget): boolean {
  return NUDGE_TARGETS.some((candidate) =>
    getLocalBool(STORAGE_KEYS[candidate].downloaded, false),
  );
}

export function writeNativeAppDownloaded(target: NudgeTarget): void {
  setLocalBool(STORAGE_KEYS[target].downloaded, true);
}

function readNativeAppBannerDismissed(_target: NudgeTarget): boolean {
  return NUDGE_TARGETS.some((candidate) =>
    getLocalBool(STORAGE_KEYS[candidate].bannerDismissed, false),
  );
}

function writeNativeAppBannerDismissed(target: NudgeTarget): void {
  setLocalBool(STORAGE_KEYS[target].bannerDismissed, true);
}

export function readNativeAppAssistantTurnsSeen(_target: NudgeTarget): number {
  return Math.max(
    0,
    ...NUDGE_TARGETS.map((candidate) =>
      getLocalNumber(STORAGE_KEYS[candidate].assistantTurnsSeen, 0),
    ),
  );
}

export function incrementNativeAppAssistantTurnsSeen(
  target: NudgeTarget,
  delta = 1,
): void {
  if (delta <= 0) {
    return;
  }
  setLocalNumber(
    STORAGE_KEYS[target].assistantTurnsSeen,
    readNativeAppAssistantTurnsSeen(target) + delta,
  );
}

export function openNativeAppStore(target: NudgeTarget): void {
  const promotion = resolveMobilePromotion(targetPlatform(target));
  window.open(promotion.storeUrl, "_blank", "noopener,noreferrer");
}

export function useNativeAppNudgeState(target: NudgeTarget): {
  bannerShouldShow: boolean;
  handleDownload: () => void;
  handleBannerDismiss: () => void;
} {
  const [downloaded, setDownloaded] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    setDownloaded(readNativeAppDownloaded(target));
    setBannerDismissed(readNativeAppBannerDismissed(target));
  }, [target]);

  const handleDownload = useCallback(() => {
    openNativeAppStore(target);
    writeNativeAppDownloaded(target);
    setDownloaded(true);
  }, [target]);

  const handleBannerDismiss = useCallback(() => {
    writeNativeAppBannerDismissed(target);
    setBannerDismissed(true);
  }, [target]);

  // Stable identity: consumers feed this into `useMemo` deps that build
  // banner elements. See docs/CONVENTIONS.md, "Never key an effect on a
  // ReactNode prop".
  return useMemo(
    () => ({
      bannerShouldShow: !downloaded && !bannerDismissed,
      handleDownload,
      handleBannerDismiss,
    }),
    [downloaded, bannerDismissed, handleDownload, handleBannerDismiss],
  );
}

export const __testing = {
  readNativeAppBannerDismissed,
  writeNativeAppBannerDismissed,
  resolveAndroidPlayStoreUrl,
};
