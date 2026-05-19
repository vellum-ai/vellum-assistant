/** localStorage key: user clicked "Download" on any nudge surface. */
export const KEY_MAC_APP_DOWNLOADED = "app.macOsNudge.downloaded";

/** localStorage key: user dismissed the in-chat floating banner. */
export const KEY_MAC_APP_BANNER_DISMISSED = "app.macOsNudge.bannerDismissed";

/** localStorage key: user permanently dismissed the sidebar nudge entry. */
export const KEY_MAC_APP_SIDEBAR_DISMISSED =
  "app.macOsNudge.sidebarDismissed";

/** localStorage key: cumulative completed assistant turns observed on web. */
export const KEY_MAC_APP_ASSISTANT_TURNS_SEEN =
  "app.macOsNudge.assistantTurnsSeen";

export const MAC_APP_BANNER_MIN_TURNS = 5;

/**
 * macOS app download URL. Replace with the canonical CDN or marketing
 * page URL before shipping.
 */
export const MACOS_DOWNLOAD_URL = "https://vellum.ai/download";
