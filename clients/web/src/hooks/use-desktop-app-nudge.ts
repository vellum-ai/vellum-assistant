import { useCallback, useEffect, useMemo, useState } from "react";

import { emitNativeAppNudgeEvent } from "@/utils/native-app-nudge-telemetry";
import { VELLUM_DOWNLOADS_URL } from "@/utils/external-urls";
import {
  getLocalBool,
  setLocalBool,
  getLocalNumber,
  setLocalNumber,
} from "@/utils/local-settings";

export const DESKTOP_APP_BANNER_MIN_TURNS = 5;
export const DESKTOP_APP_BANNER_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export function createDesktopNudgeSettings(
  target: "macos" | "linux",
  prefix: string,
) {
  const keys = {
    downloaded: `${prefix}.downloaded`,
    bannerDismissed: `${prefix}.bannerDismissed`,
    assistantTurnsSeen: `${prefix}.assistantTurnsSeen`,
    firstSeenAt: `${prefix}.firstSeenAt`,
  };
  const readAssistantTurnsSeen = () =>
    Math.max(0, getLocalNumber(keys.assistantTurnsSeen, 0));
  const readFirstSeenAt = () => getLocalNumber(keys.firstSeenAt, 0);
  return {
    target,
    keys,
    readDownloaded: () => getLocalBool(keys.downloaded, false),
    writeDownloaded: () => setLocalBool(keys.downloaded, true),
    readBannerDismissed: () => getLocalBool(keys.bannerDismissed, false),
    writeBannerDismissed: () => setLocalBool(keys.bannerDismissed, true),
    readAssistantTurnsSeen,
    incrementAssistantTurnsSeen(delta = 1) {
      if (delta > 0) {
        setLocalNumber(
          keys.assistantTurnsSeen,
          readAssistantTurnsSeen() + delta,
        );
      }
    },
    readFirstSeenAt,
    ensureFirstSeenAt() {
      if (readFirstSeenAt() === 0) {
        setLocalNumber(keys.firstSeenAt, Date.now());
      }
    },
  };
}

type DesktopNudgeSettings = ReturnType<typeof createDesktopNudgeSettings>;

export function openDesktopDownload(): void {
  window.open(VELLUM_DOWNLOADS_URL, "_blank", "noopener,noreferrer");
}

export function useDesktopNudgeState(
  settings: DesktopNudgeSettings,
  eligible: boolean,
) {
  const [downloaded, setDownloaded] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [firstSeenAt, setFirstSeenAt] = useState(0);
  const [ageEligible, setAgeEligible] = useState(false);

  useEffect(() => {
    if (!eligible) {
      return;
    }
    setDownloaded(settings.readDownloaded());
    setBannerDismissed(settings.readBannerDismissed());
    settings.ensureFirstSeenAt();
    const seenAt = settings.readFirstSeenAt();
    setFirstSeenAt(seenAt);
    setAgeEligible(
      seenAt !== 0 && Date.now() - seenAt >= DESKTOP_APP_BANNER_MIN_AGE_MS,
    );
  }, [settings, eligible]);

  useEffect(() => {
    if (!eligible || firstSeenAt === 0 || ageEligible) {
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
  }, [eligible, firstSeenAt, ageEligible]);

  const handleDownload = useCallback(() => {
    emitNativeAppNudgeEvent("click", "banner", settings.target);
    openDesktopDownload();
    settings.writeDownloaded();
    setDownloaded(true);
  }, [settings]);

  const handleBannerDismiss = useCallback(() => {
    emitNativeAppNudgeEvent("dismiss", "banner", settings.target);
    settings.writeBannerDismissed();
    setBannerDismissed(true);
  }, [settings]);

  return useMemo(
    () => ({
      bannerShouldShow: !downloaded && !bannerDismissed,
      ageEligible: eligible && ageEligible,
      handleDownload,
      handleBannerDismiss,
    }),
    [
      downloaded,
      bannerDismissed,
      eligible,
      ageEligible,
      handleDownload,
      handleBannerDismiss,
    ],
  );
}
