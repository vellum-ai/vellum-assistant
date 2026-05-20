import { useCallback, useEffect, useState } from "react";

import {
  computeNudgeSidebarVisible,
  readBooleanPref,
  writeBooleanPref,
  readNumberPref,
  writeNumberPref,
} from "@/domains/nudges/nudge-prefs.js";

import {
  KEY_MAC_APP_DOWNLOADED,
  KEY_MAC_APP_BANNER_DISMISSED,
  KEY_MAC_APP_SIDEBAR_DISMISSED,
  KEY_MAC_APP_ASSISTANT_TURNS_SEEN,
  MACOS_DOWNLOAD_URL,
} from "@/domains/nudges/mac-app-constants.js";

// ---------------------------------------------------------------------------
// Public readers / writers
// ---------------------------------------------------------------------------

export function readMacOsAppDownloaded(): boolean {
  return readBooleanPref(KEY_MAC_APP_DOWNLOADED, false);
}

export function writeMacOsAppDownloaded(): void {
  writeBooleanPref(KEY_MAC_APP_DOWNLOADED, true);
}

function readMacOsAppBannerDismissed(): boolean {
  return readBooleanPref(KEY_MAC_APP_BANNER_DISMISSED, false);
}

function writeMacOsAppBannerDismissed(): void {
  writeBooleanPref(KEY_MAC_APP_BANNER_DISMISSED, true);
}

function readSidebarDismissed(): boolean {
  return readBooleanPref(KEY_MAC_APP_SIDEBAR_DISMISSED, false);
}

function writeSidebarDismissed(): void {
  writeBooleanPref(KEY_MAC_APP_SIDEBAR_DISMISSED, true);
}

export function readMacOsAssistantTurnsSeen(): number {
  return readNumberPref(KEY_MAC_APP_ASSISTANT_TURNS_SEEN, 0);
}

export function incrementMacOsAssistantTurnsSeen(delta = 1): void {
  if (delta <= 0) return;
  const nextValue = readMacOsAssistantTurnsSeen() + delta;
  writeNumberPref(KEY_MAC_APP_ASSISTANT_TURNS_SEEN, nextValue);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useMacOsNudgeState(): {
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
    setDownloaded(readMacOsAppDownloaded());
    setBannerDismissed(readMacOsAppBannerDismissed());
    setSidebarDismissed(readSidebarDismissed());
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
// Download helper
// ---------------------------------------------------------------------------

export function openMacOsDownload(): void {
  window.open(MACOS_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
}

// ---------------------------------------------------------------------------
// Internals exported for tests only. Not part of the public API.
// ---------------------------------------------------------------------------

export const __testing = {
  readBooleanPref,
  writeBooleanPref,
  readNumberPref,
  writeNumberPref,
  readMacOsAppBannerDismissed,
  writeMacOsAppBannerDismissed,
  readSidebarDismissed,
  writeSidebarDismissed,
};
