import {
  createDesktopNudgeSettings,
  useDesktopNudgeState,
} from "@/hooks/use-desktop-app-nudge";
export {
  DESKTOP_APP_BANNER_MIN_TURNS as MAC_APP_BANNER_MIN_TURNS,
  DESKTOP_APP_BANNER_MIN_AGE_MS as MAC_APP_BANNER_MIN_AGE_MS,
  openDesktopDownload as openMacOsDownload,
} from "@/hooks/use-desktop-app-nudge";

const settings = createDesktopNudgeSettings("macos", "app.macOsNudge");
export const {
  downloaded: KEY_MAC_APP_DOWNLOADED,
  bannerDismissed: KEY_MAC_APP_BANNER_DISMISSED,
  assistantTurnsSeen: KEY_MAC_APP_ASSISTANT_TURNS_SEEN,
  firstSeenAt: KEY_MAC_APP_FIRST_SEEN_AT,
} = settings.keys;
export const {
  readDownloaded: readMacOsAppDownloaded,
  writeDownloaded: writeMacOsAppDownloaded,
  readAssistantTurnsSeen: readMacOsAssistantTurnsSeen,
  incrementAssistantTurnsSeen: incrementMacOsAssistantTurnsSeen,
  readFirstSeenAt: readMacOsFirstSeenAt,
  ensureFirstSeenAt: ensureMacOsFirstSeenAt,
} = settings;

export function useMacOsNudgeState() {
  return useDesktopNudgeState(settings, true);
}

export const __testing = {
  readMacOsAppBannerDismissed: settings.readBannerDismissed,
  writeMacOsAppBannerDismissed: settings.writeBannerDismissed,
};
