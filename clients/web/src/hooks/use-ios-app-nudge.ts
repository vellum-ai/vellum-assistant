/**
 * iOS app-download nudge module.
 *
 * Manages whether the user has downloaded the iOS app, banner
 * dismissal state, and assistant turn counting for the minimum-turn
 * threshold before the nudge banner surfaces.
 */

import { useCallback, useEffect, useState } from "react";

import {
  getLocalBool,
  setLocalBool,
  getLocalNumber,
  setLocalNumber,
} from "@/utils/local-settings";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** localStorage key: user tapped "Download" on any iOS nudge surface. */
export const KEY_IOS_APP_DOWNLOADED = "app.iosNudge.downloaded";

/** localStorage key: user dismissed the in-chat floating banner. */
export const KEY_IOS_APP_BANNER_DISMISSED = "app.iosNudge.bannerDismissed";

/** localStorage key: cumulative completed assistant turns observed on web. */
export const KEY_IOS_APP_ASSISTANT_TURNS_SEEN =
  "app.iosNudge.assistantTurnsSeen";

export const IOS_APP_BANNER_MIN_TURNS = 5;

/** App Store listing for Vellum Assistant (id6759934423). */
export const IOS_APP_STORE_URL =
  "https://apps.apple.com/us/app/vellum-assistant/id6759934423";

// ---------------------------------------------------------------------------
// Public readers / writers
// ---------------------------------------------------------------------------

export function readIOSAppDownloaded(): boolean {
  return getLocalBool(KEY_IOS_APP_DOWNLOADED, false);
}

export function writeIOSAppDownloaded(): void {
  setLocalBool(KEY_IOS_APP_DOWNLOADED, true);
}

function readIOSAppBannerDismissed(): boolean {
  return getLocalBool(KEY_IOS_APP_BANNER_DISMISSED, false);
}

function writeIOSAppBannerDismissed(): void {
  setLocalBool(KEY_IOS_APP_BANNER_DISMISSED, true);
}

export function readIOSAssistantTurnsSeen(): number {
  return Math.max(0, getLocalNumber(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, 0));
}

export function incrementIOSAssistantTurnsSeen(delta = 1): void {
  if (delta <= 0) return;
  const nextValue = readIOSAssistantTurnsSeen() + delta;
  setLocalNumber(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, nextValue);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useIOSNudgeState(): {
  bannerShouldShow: boolean;
  handleDownload: () => void;
  handleBannerDismiss: () => void;
} {
  const [downloaded, setDownloaded] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    setDownloaded(readIOSAppDownloaded());
    setBannerDismissed(readIOSAppBannerDismissed());
  }, []);

  const handleDownload = useCallback(() => {
    openIOSAppStore();
    writeIOSAppDownloaded();
    setDownloaded(true);
  }, []);

  const handleBannerDismiss = useCallback(() => {
    writeIOSAppBannerDismissed();
    setBannerDismissed(true);
  }, []);

  return {
    bannerShouldShow: !downloaded && !bannerDismissed,
    handleDownload,
    handleBannerDismiss,
  };
}

// ---------------------------------------------------------------------------
// App Store helper
// ---------------------------------------------------------------------------

export function openIOSAppStore(): void {
  window.open(IOS_APP_STORE_URL, "_blank", "noopener,noreferrer");
}

// ---------------------------------------------------------------------------
// Internals exported for tests only. Not part of the public API.
// ---------------------------------------------------------------------------

export const __testing = {
  readIOSAppBannerDismissed,
  writeIOSAppBannerDismissed,
};
