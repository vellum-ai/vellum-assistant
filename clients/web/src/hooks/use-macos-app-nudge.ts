/**
 * macOS app-download nudge module.
 *
 * Manages whether the user has downloaded the macOS app, banner
 * dismissal state, and a first-seen timestamp that gates the nudge
 * banner behind a minimum age (it surfaces ~24h after first observation).
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

/** localStorage key: epoch ms of the first time the macOS nudge observed the user. 0 = not yet. */
export const KEY_MAC_APP_FIRST_SEEN_AT = "app.macOsNudge.firstSeenAt";

/** Minimum age (ms since first seen) before the banner is eligible. 24 hours. */
export const MAC_APP_BANNER_MIN_AGE_MS = 24 * 60 * 60 * 1000;

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

export function readMacOsFirstSeenAt(): number {
  return getLocalNumber(KEY_MAC_APP_FIRST_SEEN_AT, 0);
}

/** Stamp the first-seen timestamp once. Idempotent: later calls are no-ops. */
export function ensureMacOsFirstSeenAt(): void {
  if (readMacOsFirstSeenAt() === 0) {
    setLocalNumber(KEY_MAC_APP_FIRST_SEEN_AT, Date.now());
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMacOsNudgeState(): {
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
    setDownloaded(readMacOsAppDownloaded());
    setBannerDismissed(readMacOsAppBannerDismissed());
    ensureMacOsFirstSeenAt();
    const seenAt = readMacOsFirstSeenAt();
    setFirstSeenAt(seenAt);
    setAgeEligible(
      seenAt !== 0 && Date.now() - seenAt >= MAC_APP_BANNER_MIN_AGE_MS,
    );
  }, []);

  // Flip eligibility mid-session once the age threshold elapses. For a 24h
  // gate this rarely fires in-session; the mount effect above recomputes it
  // on the user's next visit, which is the real trigger.
  useEffect(() => {
    if (firstSeenAt === 0 || ageEligible) return;
    const remaining = MAC_APP_BANNER_MIN_AGE_MS - (Date.now() - firstSeenAt);
    if (remaining <= 0) {
      setAgeEligible(true);
      return;
    }
    const timer = setTimeout(() => setAgeEligible(true), remaining);
    return () => clearTimeout(timer);
  }, [firstSeenAt, ageEligible]);

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
    // Drives the iOS/macOS → GitHub → Discord cascade: true until the user
    // downloads or dismisses.
    bannerShouldShow: !downloaded && !bannerDismissed,
    // True once the banner has waited the minimum age (24h) to render.
    ageEligible,
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
