/** localStorage key: user clicked "Star on GitHub" on any nudge surface. */
export const KEY_GITHUB_NUDGE_STARRED = "app.githubNudge.starred";

/** localStorage key: user dismissed the in-chat floating banner. */
export const KEY_GITHUB_NUDGE_BANNER_DISMISSED =
  "app.githubNudge.bannerDismissed";

/** localStorage key: user dismissed the sidebar nudge entry. */
export const KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED =
  "app.githubNudge.sidebarDismissed";

/**
 * localStorage key: epoch-ms timestamp of the last time the user
 * dismissed the GitHub nudge banner. Used by the Discord nudge module
 * to enforce a cooldown period before surfacing.
 */
export const KEY_GITHUB_NUDGE_BANNER_DISMISSED_AT =
  "app.githubNudge.bannerDismissedAt";

/** Public GitHub repository for Vellum Assistant. */
export const GITHUB_REPO_URL =
  "https://github.com/vellum-ai/vellum-assistant";
