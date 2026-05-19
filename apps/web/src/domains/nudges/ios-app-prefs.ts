import { useCallback, useEffect, useState } from "react";

import {
  computeNudgeSidebarVisible,
  readBooleanPref,
  writeBooleanPref,
  readNumberPref,
  writeNumberPref,
} from "@/domains/nudges/nudge-prefs.js";

import {
  KEY_IOS_APP_DOWNLOADED,
  KEY_IOS_APP_BANNER_DISMISSED,
  KEY_IOS_APP_SIDEBAR_DISMISSED,
  KEY_IOS_APP_ASSISTANT_TURNS_SEEN,
  IOS_APP_STORE_URL,
} from "@/domains/nudges/ios-app-constants.js";

// ---------------------------------------------------------------------------
// Public readers / writers
// ---------------------------------------------------------------------------

export function readIOSAppDownloaded(): boolean {
  return readBooleanPref(KEY_IOS_APP_DOWNLOADED, false);
}

export function writeIOSAppDownloaded(): void {
  writeBooleanPref(KEY_IOS_APP_DOWNLOADED, true);
}

function readIOSAppBannerDismissed(): boolean {
  return readBooleanPref(KEY_IOS_APP_BANNER_DISMISSED, false);
}

function writeIOSAppBannerDismissed(): void {
  writeBooleanPref(KEY_IOS_APP_BANNER_DISMISSED, true);
}

function readSidebarDismissed(): boolean {
  return readBooleanPref(KEY_IOS_APP_SIDEBAR_DISMISSED, false);
}

function writeSidebarDismissed(): void {
  writeBooleanPref(KEY_IOS_APP_SIDEBAR_DISMISSED, true);
}

export function readIOSAssistantTurnsSeen(): number {
  return readNumberPref(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, 0);
}

export function incrementIOSAssistantTurnsSeen(delta = 1): void {
  if (delta <= 0) return;
  const nextValue = readIOSAssistantTurnsSeen() + delta;
  writeNumberPref(KEY_IOS_APP_ASSISTANT_TURNS_SEEN, nextValue);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useIOSNudgeState(): {
  bannerShouldShow: boolean;
  sidebarEntryVisible: boolean;
  handleDownload: () => void;
  handleBannerDismiss: () => void;
  handleSidebarDismiss: () => void;
} {
  const [downloaded, setDownloaded] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [sidebarDismissed, setSidebarDismissed] = useState(false);

  useEffect(() => {
    setDownloaded(readIOSAppDownloaded());
    setBannerDismissed(readIOSAppBannerDismissed());
    setSidebarDismissed(readSidebarDismissed());
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

  const handleSidebarDismiss = useCallback(() => {
    writeSidebarDismissed();
    setSidebarDismissed(true);
  }, []);

  return {
    bannerShouldShow: !downloaded && !bannerDismissed,
    sidebarEntryVisible: computeNudgeSidebarVisible({
      converted: downloaded,
      bannerDismissed,
      sidebarDismissed,
    }),
    handleDownload,
    handleBannerDismiss,
    handleSidebarDismiss,
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
  readBooleanPref,
  writeBooleanPref,
  readNumberPref,
  writeNumberPref,
  readIOSAppBannerDismissed,
  writeIOSAppBannerDismissed,
  readSidebarDismissed,
  writeSidebarDismissed,
};
