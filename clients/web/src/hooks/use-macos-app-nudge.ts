/**
 * macOS app-download nudge module.
 *
 * Manages whether the user has downloaded the macOS app, banner
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

/** localStorage key: user clicked "Download" on any nudge surface. */
export const KEY_MAC_APP_DOWNLOADED = "app.macOsNudge.downloaded";

/** localStorage key: user dismissed the in-chat floating banner. */
export const KEY_MAC_APP_BANNER_DISMISSED = "app.macOsNudge.bannerDismissed";

/** localStorage key: cumulative completed assistant turns observed on web. */
export const KEY_MAC_APP_ASSISTANT_TURNS_SEEN =
  "app.macOsNudge.assistantTurnsSeen";

export const MAC_APP_BANNER_MIN_TURNS = 5;

/**
 * macOS app download URL. Replace with the canonical CDN or marketing
 * page URL before shipping.
 */
export const MACOS_DOWNLOAD_URL = "https://vellum.ai/download";

// ---------------------------------------------------------------------------
// Public readers / writers
// ---------------------------------------------------------------------------

export function readMacOsAppDownloaded(): boolean {
  return getLocalBool(KEY_MAC_APP_DOWNLOADED, false);
}

export function writeMacOsAppDownloaded(): void {
  setLocalBool(KEY_MAC_APP_DOWNLOADED, true);
}

function readMacOsAppBannerDismissed(): boolean {
  return getLocalBool(KEY_MAC_APP_BANNER_DISMISSED, false);
}

function writeMacOsAppBannerDismissed(): void {
  setLocalBool(KEY_MAC_APP_BANNER_DISMISSED, true);
}

export function readMacOsAssistantTurnsSeen(): number {
  return Math.max(0, getLocalNumber(KEY_MAC_APP_ASSISTANT_TURNS_SEEN, 0));
}

export function incrementMacOsAssistantTurnsSeen(delta = 1): void {
  if (delta <= 0) return;
  const nextValue = readMacOsAssistantTurnsSeen() + delta;
  setLocalNumber(KEY_MAC_APP_ASSISTANT_TURNS_SEEN, nextValue);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMacOsNudgeState(): {
  bannerShouldShow: boolean;
  handleDownload: () => void;
  handleBannerDismiss: () => void;
} {
  const [downloaded, setDownloaded] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    setDownloaded(readMacOsAppDownloaded());
    setBannerDismissed(readMacOsAppBannerDismissed());
  }, []);

  const handleDownload = useCallback(() => {
    openMacOsDownload();
    writeMacOsAppDownloaded();
    setDownloaded(true);
  }, []);

  const handleBannerDismiss = useCallback(() => {
    writeMacOsAppBannerDismissed();
    setBannerDismissed(true);
  }, []);

  return {
    bannerShouldShow: !downloaded && !bannerDismissed,
    handleDownload,
    handleBannerDismiss,
  };
}

// ---------------------------------------------------------------------------
// Download helper
// ---------------------------------------------------------------------------

export function openMacOsDownload(): void {
  window.open(MACOS_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
}

// ---------------------------------------------------------------------------
// Internals exported for tests only. Not part of the public API.
// ---------------------------------------------------------------------------

export const __testing = {
  readMacOsAppBannerDismissed,
  writeMacOsAppBannerDismissed,
};
