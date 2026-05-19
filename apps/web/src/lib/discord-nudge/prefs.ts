// TODO: port from platform
export interface DiscordNudgeState {
  dismissed: boolean;
  bannerShouldShow: boolean;
  sidebarEntryVisible: boolean;
  handleJoin: () => void;
  handleBannerDismiss: () => void;
}
export function useDiscordNudgeState(_platformResolved?: boolean, _conversationCount?: number): DiscordNudgeState {
  return { dismissed: false, bannerShouldShow: false, sidebarEntryVisible: false, handleJoin: () => {}, handleBannerDismiss: () => {} };
}
export function ensureFirstSeenAt() {}
