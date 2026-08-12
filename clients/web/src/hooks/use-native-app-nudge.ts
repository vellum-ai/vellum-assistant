import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getLocalBool,
  getLocalNumber,
  setLocalBool,
  setLocalNumber,
} from "@/utils/local-settings";

export type NativeAppPlatform = "ios" | "android";

export interface NativeAppPromotion {
  platform: NativeAppPlatform;
  appName: string;
  storeUrl: string;
}

export const NATIVE_APP_BANNER_MIN_TURNS = 5;

/** App Store listing for Vellum Assistant (id6759934423). */
export const IOS_APP_STORE_URL =
  "https://apps.apple.com/us/app/vellum-assistant/id6759934423";

const ANDROID_PACKAGE_ID = "ai.vellum.assistant";
const ANDROID_PLAY_STORE_URL =
  `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE_ID}`;

const STORAGE_KEYS: Record<
  NativeAppPlatform,
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
};

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

export function getNativeAppPromotion(
  platform: NativeAppPlatform,
): NativeAppPromotion | null {
  if (platform === "ios") {
    return {
      platform,
      appName: getNativeAppName(platform),
      storeUrl: IOS_APP_STORE_URL,
    };
  }

  const storeUrl = resolveAndroidPlayStoreUrl();
  return storeUrl
    ? {
        platform,
        appName: getNativeAppName(platform),
        storeUrl,
      }
    : null;
}

export function readNativeAppDownloaded(
  platform: NativeAppPlatform,
): boolean {
  return getLocalBool(STORAGE_KEYS[platform].downloaded, false);
}

export function writeNativeAppDownloaded(
  platform: NativeAppPlatform,
): void {
  setLocalBool(STORAGE_KEYS[platform].downloaded, true);
}

function readNativeAppBannerDismissed(
  platform: NativeAppPlatform,
): boolean {
  return getLocalBool(STORAGE_KEYS[platform].bannerDismissed, false);
}

function writeNativeAppBannerDismissed(
  platform: NativeAppPlatform,
): void {
  setLocalBool(STORAGE_KEYS[platform].bannerDismissed, true);
}

export function readNativeAppAssistantTurnsSeen(
  platform: NativeAppPlatform,
): number {
  return Math.max(
    0,
    getLocalNumber(STORAGE_KEYS[platform].assistantTurnsSeen, 0),
  );
}

export function incrementNativeAppAssistantTurnsSeen(
  platform: NativeAppPlatform,
  delta = 1,
): void {
  if (delta <= 0) {
    return;
  }
  setLocalNumber(
    STORAGE_KEYS[platform].assistantTurnsSeen,
    readNativeAppAssistantTurnsSeen(platform) + delta,
  );
}

export function openNativeAppStore(platform: NativeAppPlatform): boolean {
  const promotion = getNativeAppPromotion(platform);
  if (!promotion) {
    return false;
  }
  window.open(promotion.storeUrl, "_blank", "noopener,noreferrer");
  return true;
}

export function useNativeAppNudgeState(platform: NativeAppPlatform): {
  bannerShouldShow: boolean;
  handleDownload: () => void;
  handleBannerDismiss: () => void;
} {
  const [downloaded, setDownloaded] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const promotionAvailable = getNativeAppPromotion(platform) !== null;

  useEffect(() => {
    setDownloaded(readNativeAppDownloaded(platform));
    setBannerDismissed(readNativeAppBannerDismissed(platform));
  }, [platform]);

  const handleDownload = useCallback(() => {
    if (!openNativeAppStore(platform)) {
      return;
    }
    writeNativeAppDownloaded(platform);
    setDownloaded(true);
  }, [platform]);

  const handleBannerDismiss = useCallback(() => {
    writeNativeAppBannerDismissed(platform);
    setBannerDismissed(true);
  }, [platform]);

  // Stable identity: consumers feed this into `useMemo` deps that build
  // banner elements. See docs/CONVENTIONS.md, "Never key an effect on a
  // ReactNode prop".
  return useMemo(
    () => ({
      bannerShouldShow: promotionAvailable && !downloaded && !bannerDismissed,
      handleDownload,
      handleBannerDismiss,
    }),
    [
      promotionAvailable,
      downloaded,
      bannerDismissed,
      handleDownload,
      handleBannerDismiss,
    ],
  );
}

export const __testing = {
  readNativeAppBannerDismissed,
  writeNativeAppBannerDismissed,
  resolveAndroidPlayStoreUrl,
};
