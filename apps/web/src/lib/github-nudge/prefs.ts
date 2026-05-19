// TODO: port from platform
export interface GitHubNudgeState {
  dismissed: boolean;
  bannerShouldShow: boolean;
  sidebarEntryVisible: boolean;
  handleStar: () => void;
  handleBannerDismiss: () => void;
}
export function useGitHubNudgeState(): GitHubNudgeState {
  return { dismissed: false, bannerShouldShow: false, sidebarEntryVisible: false, handleStar: () => {}, handleBannerDismiss: () => {} };
}
