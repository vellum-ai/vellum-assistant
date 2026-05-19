// TODO: port from platform
import type { PlatformNudgeState } from "@/domains/nudges/ios-app-prefs.js";

export function readMacOsAssistantTurnsSeen() { return 0; }
export function incrementMacOsAssistantTurnsSeen(_turnsSeen: number) {}
export function useMacOsNudgeState(): PlatformNudgeState {
  return { dismissed: false, bannerShouldShow: false, sidebarEntryVisible: false, handleDownload: () => {}, handleBannerDismiss: () => {}, handleSidebarDismiss: () => {} };
}
