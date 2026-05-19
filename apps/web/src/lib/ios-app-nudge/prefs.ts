// TODO: port from platform
export interface PlatformNudgeState {
  dismissed: boolean;
  bannerShouldShow: boolean;
  sidebarEntryVisible: boolean;
  handleDownload: () => void;
  handleBannerDismiss: () => void;
  handleSidebarDismiss: () => void;
}

export function readIOSAssistantTurnsSeen() { return 0; }
export function incrementIOSAssistantTurnsSeen(_turnsSeen: number) {}
export function useIOSNudgeState(): PlatformNudgeState {
  return { dismissed: false, bannerShouldShow: false, sidebarEntryVisible: false, handleDownload: () => {}, handleBannerDismiss: () => {}, handleSidebarDismiss: () => {} };
}
