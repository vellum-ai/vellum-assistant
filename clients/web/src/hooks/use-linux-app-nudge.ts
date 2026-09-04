/**
 * Linux app-download nudge module.
 *
 * Mirrors `use-macos-app-nudge.ts`: tracks whether the user has downloaded the
 * Linux app, banner dismissal state, and a first-seen timestamp that gates the
 * nudge banner behind a minimum age (it surfaces ~24h after first observation).
 *
 * Visibility is additionally gated on the `linux-desktop-app` feature flag by
 * the caller (`domains/chat/hooks/use-app-nudges.ts`), so the nudge stays dark
 * until the download page carries a Linux build.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { emitNativeAppNudgeEvent } from "@/utils/native-app-nudge-telemetry";
import { VELLUM_DOWNLOADS_URL } from "@/utils/external-urls";
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
export const KEY_LINUX_APP_DOWNLOADED = "app.linuxNudge.downloaded";

/** localStorage key: user dismissed the in-chat floating banner. */
export const KEY_LINUX_APP_BANNER_DISMISSED = "app.linuxNudge.bannerDismissed";

/** localStorage key: cumulative completed assistant turns observed on web. */
export const KEY_LINUX_APP_ASSISTANT_TURNS_SEEN =
  "app.linuxNudge.assistantTurnsSeen";

export const LINUX_APP_BANNER_MIN_TURNS = 5;

/** localStorage key: epoch ms of the first time the Linux nudge observed the user. 0 = not yet. */
export const KEY_LINUX_APP_FIRST_SEEN_AT = "app.linuxNudge.firstSeenAt";

/** Minimum age (ms since first seen) before the banner is eligible. 24 hours. */
export const LINUX_APP_BANNER_MIN_AGE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public readers / writers
// ---------------------------------------------------------------------------

export function readLinuxAppDownloaded(): boolean {
  return getLocalBool(KEY_LINUX_APP_DOWNLOADED, false);
}

export function writeLinuxAppDownloaded(): void {
  setLocalBool(KEY_LINUX_APP_DOWNLOADED, true);
}

function readLinuxAppBannerDismissed(): boolean {
  return getLocalBool(KEY_LINUX_APP_BANNER_DISMISSED, false);
}

function writeLinuxAppBannerDismissed(): void {
  setLocalBool(KEY_LINUX_APP_BANNER_DISMISSED, true);
}

export function readLinuxAssistantTurnsSeen(): number {
  return Math.max(0, getLocalNumber(KEY_LINUX_APP_ASSISTANT_TURNS_SEEN, 0));
}

export function incrementLinuxAssistantTurnsSeen(delta = 1): void {
  if (delta <= 0) {
    return;
  }
  const nextValue = readLinuxAssistantTurnsSeen() + delta;
  setLocalNumber(KEY_LINUX_APP_ASSISTANT_TURNS_SEEN, nextValue);
}

export function readLinuxFirstSeenAt(): number {
  return getLocalNumber(KEY_LINUX_APP_FIRST_SEEN_AT, 0);
}

/** Stamp the first-seen timestamp once. Idempotent: later calls are no-ops. */
export function ensureLinuxFirstSeenAt(): void {
  if (readLinuxFirstSeenAt() === 0) {
    setLocalNumber(KEY_LINUX_APP_FIRST_SEEN_AT, Date.now());
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * @param eligible - Whether the current reader is a flag-enabled Linux browser
 *   user. React hook order forbids calling this conditionally, so eligibility
 *   is a parameter instead: an ineligible reader must not have the age gate
 *   stamped, or the 24h wait would already be spent by the time the flag turns
 *   on and every returning Linux reader would see the banner at once.
 */
export function useLinuxNudgeState(eligible: boolean): {
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
    if (!eligible) {
      return;
    }
    setDownloaded(readLinuxAppDownloaded());
    setBannerDismissed(readLinuxAppBannerDismissed());
    ensureLinuxFirstSeenAt();
    const seenAt = readLinuxFirstSeenAt();
    setFirstSeenAt(seenAt);
    setAgeEligible(
      seenAt !== 0 && Date.now() - seenAt >= LINUX_APP_BANNER_MIN_AGE_MS,
    );
  }, [eligible]);

  // Flip eligibility mid-session once the age threshold elapses. For a 24h
  // gate this rarely fires in-session; the mount effect above recomputes it
  // on the user's next visit, which is the real trigger.
  useEffect(() => {
    if (firstSeenAt === 0 || ageEligible) {
      return;
    }
    const remaining = LINUX_APP_BANNER_MIN_AGE_MS - (Date.now() - firstSeenAt);
    if (remaining <= 0) {
      setAgeEligible(true);
      return;
    }
    const timer = setTimeout(() => setAgeEligible(true), remaining);
    return () => clearTimeout(timer);
  }, [firstSeenAt, ageEligible]);

  const handleDownload = useCallback(() => {
    emitNativeAppNudgeEvent("click", "banner", "linux");
    openLinuxDownload();
    writeLinuxAppDownloaded();
    setDownloaded(true);
  }, []);

  const handleBannerDismiss = useCallback(() => {
    emitNativeAppNudgeEvent("dismiss", "banner", "linux");
    writeLinuxAppBannerDismissed();
    setBannerDismissed(true);
  }, []);

  // Stable identity: consumers feed this into `useMemo` deps that build
  // banner elements. See docs/CONVENTIONS.md, "Never key an effect on a
  // ReactNode prop".
  return useMemo(
    () => ({
      // Drives the platform → GitHub → Discord cascade: true until the user
      // downloads or dismisses.
      bannerShouldShow: !downloaded && !bannerDismissed,
      // True once the banner has waited the minimum age (24h) to render.
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

// ---------------------------------------------------------------------------
// Download helper
// ---------------------------------------------------------------------------

export function openLinuxDownload(): void {
  window.open(VELLUM_DOWNLOADS_URL, "_blank", "noopener,noreferrer");
}
