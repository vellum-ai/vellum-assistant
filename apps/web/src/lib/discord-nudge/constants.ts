/** localStorage key: user clicked "Join Discord" on any nudge surface. */
export const KEY_DISCORD_NUDGE_JOINED = "app.discordNudge.joined";

/** localStorage key: user dismissed the in-chat floating banner. */
export const KEY_DISCORD_NUDGE_BANNER_DISMISSED =
  "app.discordNudge.bannerDismissed";

/** localStorage key: user dismissed the sidebar nudge entry. */
export const KEY_DISCORD_NUDGE_SIDEBAR_DISMISSED =
  "app.discordNudge.sidebarDismissed";

/**
 * localStorage key: epoch-ms timestamp of the first page load observed
 * by the Discord nudge module. Used to derive "account age" without a
 * network call — on first visit we record `Date.now()`.
 */
export const KEY_DISCORD_NUDGE_FIRST_SEEN_AT =
  "app.discordNudge.firstSeenAt";

/** Public Discord invite URL for the Vellum community. */
export const DISCORD_INVITE_URL = "https://discord.gg/ZABd9V2zM8";

/**
 * Minimum number of conversations (sidebar threads) the user must have
 * before the Discord nudge becomes eligible. Aggressive: 2.
 */
export const DISCORD_MIN_CONVERSATION_COUNT = 2;

/**
 * Minimum account age (milliseconds since `firstSeenAt`) before the
 * Discord nudge becomes eligible. 0 = no minimum age gate.
 */
export const DISCORD_MIN_ACCOUNT_AGE_MS = 0;

/**
 * Cooldown (milliseconds) after the GitHub nudge banner is dismissed
 * before the Discord nudge can surface. 24 hours.
 */
export const DISCORD_GITHUB_DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
