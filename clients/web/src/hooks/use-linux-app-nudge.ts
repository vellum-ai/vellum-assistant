import {
  createDesktopNudgeSettings,
  useDesktopNudgeState,
} from "@/hooks/use-desktop-app-nudge";
export {
  DESKTOP_APP_BANNER_MIN_TURNS as LINUX_APP_BANNER_MIN_TURNS,
  DESKTOP_APP_BANNER_MIN_AGE_MS as LINUX_APP_BANNER_MIN_AGE_MS,
  openDesktopDownload as openLinuxDownload,
} from "@/hooks/use-desktop-app-nudge";

const settings = createDesktopNudgeSettings("linux", "app.linuxNudge");
export const {
  downloaded: KEY_LINUX_APP_DOWNLOADED,
  bannerDismissed: KEY_LINUX_APP_BANNER_DISMISSED,
  assistantTurnsSeen: KEY_LINUX_APP_ASSISTANT_TURNS_SEEN,
  firstSeenAt: KEY_LINUX_APP_FIRST_SEEN_AT,
} = settings.keys;
export const {
  readDownloaded: readLinuxAppDownloaded,
  writeDownloaded: writeLinuxAppDownloaded,
  readAssistantTurnsSeen: readLinuxAssistantTurnsSeen,
  incrementAssistantTurnsSeen: incrementLinuxAssistantTurnsSeen,
  readFirstSeenAt: readLinuxFirstSeenAt,
  ensureFirstSeenAt: ensureLinuxFirstSeenAt,
} = settings;

export function useLinuxNudgeState(eligible: boolean) {
  return useDesktopNudgeState(settings, eligible);
}
