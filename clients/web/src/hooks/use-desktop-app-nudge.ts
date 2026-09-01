/** Desktop app-download nudge state shared by macOS and Windows browsers. */

import { useCallback, useEffect, useMemo, useState } from "react";

import type { DesktopAppPlatform } from "@/runtime/desktop-app-platform";
import { emitNativeAppNudgeEvent } from "@/utils/native-app-nudge-telemetry";
import { VELLUM_DOWNLOADS_URL } from "@/utils/external-urls";
import {
  getLocalBool,
  setLocalBool,
  getLocalNumber,
  setLocalNumber,
} from "@/utils/local-settings";

// The persisted namespace is a compatibility contract shared by desktop apps.
export const KEY_DESKTOP_APP_DOWNLOADED = "app.macOsNudge.downloaded";
export const KEY_DESKTOP_APP_BANNER_DISMISSED =
  "app.macOsNudge.bannerDismissed";
export const KEY_DESKTOP_APP_ASSISTANT_TURNS_SEEN =
  "app.macOsNudge.assistantTurnsSeen";
export const KEY_DESKTOP_APP_FIRST_SEEN_AT = "app.macOsNudge.firstSeenAt";

export const DESKTOP_APP_BANNER_MIN_TURNS = 5;
export const DESKTOP_APP_BANNER_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export function readDesktopAppDownloaded(): boolean {
  return getLocalBool(KEY_DESKTOP_APP_DOWNLOADED, false);
}

export function writeDesktopAppDownloaded(): void {
  setLocalBool(KEY_DESKTOP_APP_DOWNLOADED, true);
}

function readDesktopAppBannerDismissed(): boolean {
  return getLocalBool(KEY_DESKTOP_APP_BANNER_DISMISSED, false);
}

function writeDesktopAppBannerDismissed(): void {
  setLocalBool(KEY_DESKTOP_APP_BANNER_DISMISSED, true);
}

export function readDesktopAppAssistantTurnsSeen(): number {
  return Math.max(
    0,
    getLocalNumber(KEY_DESKTOP_APP_ASSISTANT_TURNS_SEEN, 0),
  );
}

export function incrementDesktopAppAssistantTurnsSeen(delta = 1): void {
  if (delta <= 0) {
    return;
  }
  const nextValue = readDesktopAppAssistantTurnsSeen() + delta;
  setLocalNumber(KEY_DESKTOP_APP_ASSISTANT_TURNS_SEEN, nextValue);
}

export function readDesktopAppFirstSeenAt(): number {
  return getLocalNumber(KEY_DESKTOP_APP_FIRST_SEEN_AT, 0);
}

export function ensureDesktopAppFirstSeenAt(): void {
  if (readDesktopAppFirstSeenAt() === 0) {
    setLocalNumber(KEY_DESKTOP_APP_FIRST_SEEN_AT, Date.now());
  }
}

export function useDesktopAppNudgeState(platform: DesktopAppPlatform): {
  bannerShouldShow: boolean;
  ageEligible: boolean;
  handleDownload: () => void;
  handleBannerDismiss: () => void;
} {
  const [downloaded, setDownloaded] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [firstSeenAt, setFirstSeenAt] = useState(0);
  const [ageEligible, setAgeEligible] = useState(false);

  useEffect(() => {
    setDownloaded(readDesktopAppDownloaded());
    setBannerDismissed(readDesktopAppBannerDismissed());
    ensureDesktopAppFirstSeenAt();
    const seenAt = readDesktopAppFirstSeenAt();
    setFirstSeenAt(seenAt);
    setAgeEligible(
      seenAt !== 0 && Date.now() - seenAt >= DESKTOP_APP_BANNER_MIN_AGE_MS,
    );
  }, []);

  useEffect(() => {
    if (firstSeenAt === 0 || ageEligible) {
      return;
    }
    const remaining =
      DESKTOP_APP_BANNER_MIN_AGE_MS - (Date.now() - firstSeenAt);
    if (remaining <= 0) {
      setAgeEligible(true);
      return;
    }
    const timer = setTimeout(() => setAgeEligible(true), remaining);
    return () => clearTimeout(timer);
  }, [firstSeenAt, ageEligible]);

  const handleDownload = useCallback(() => {
    emitNativeAppNudgeEvent("click", "banner", platform);
    openDesktopAppDownload();
    writeDesktopAppDownloaded();
    setDownloaded(true);
  }, [platform]);

  const handleBannerDismiss = useCallback(() => {
    emitNativeAppNudgeEvent("dismiss", "banner", platform);
    writeDesktopAppBannerDismissed();
    setBannerDismissed(true);
  }, [platform]);

  return useMemo(
    () => ({
      bannerShouldShow: !downloaded && !bannerDismissed,
      ageEligible,
      handleDownload,
      handleBannerDismiss,
    }),
    [
      downloaded,
      bannerDismissed,
      ageEligible,
      handleDownload,
      handleBannerDismiss,
    ],
  );
}

export function openDesktopAppDownload(): void {
  window.open(VELLUM_DOWNLOADS_URL, "_blank", "noopener,noreferrer");
}

export const __testing = {
  readDesktopAppBannerDismissed,
  writeDesktopAppBannerDismissed,
};
