
import { useCallback, useSyncExternalStore } from "react";

import {
  computeNudgeSidebarVisible,
  readBooleanPref,
  writeBooleanPref,
  readNumberPref,
  writeNumberPref,
} from "@/domains/nudges/nudge-prefs.js";

import {
  readGitHubNudgeStarred,
  readGitHubBannerDismissedAt,
} from "@/domains/nudges/github-prefs.js";

import {
  KEY_GITHUB_NUDGE_BANNER_DISMISSED,
  KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED,
} from "@/domains/nudges/github-constants.js";

import {
  DISCORD_INVITE_URL,
  DISCORD_MIN_CONVERSATION_COUNT,
  DISCORD_MIN_ACCOUNT_AGE_MS,
  DISCORD_GITHUB_DISMISS_COOLDOWN_MS,
  KEY_DISCORD_NUDGE_JOINED,
  KEY_DISCORD_NUDGE_BANNER_DISMISSED,
  KEY_DISCORD_NUDGE_SIDEBAR_DISMISSED,
  KEY_DISCORD_NUDGE_FIRST_SEEN_AT,
} from "@/domains/nudges/discord-constants.js";

// ---------------------------------------------------------------------------
// External-store subscription (same pattern as github-nudge/prefs.ts)
// ---------------------------------------------------------------------------

type PrefChangeEvent = CustomEvent<{ key: string; value: string | null }>;

const subscribeCache = new Map<
  string,
  (listener: () => void) => () => void
>();
const snapshotCache = new Map<string, () => boolean>();

function getSubscribeForKey(
  key: string,
): (listener: () => void) => () => void {
  let cached = subscribeCache.get(key);
  if (!cached) {
    cached = (listener) => {
      if (typeof window === "undefined") {
        return () => {};
      }
      const handleSameTab = (event: Event) => {
        const detail = (event as PrefChangeEvent).detail;
        if (detail?.key === key) {
          listener();
        }
      };
      const handleCrossTab = (event: StorageEvent) => {
        if (event.key === key) {
          listener();
        }
      };
      window.addEventListener("vellum:pref-changed", handleSameTab);
      window.addEventListener("storage", handleCrossTab);
      return () => {
        window.removeEventListener("vellum:pref-changed", handleSameTab);
        window.removeEventListener("storage", handleCrossTab);
      };
    };
    subscribeCache.set(key, cached);
  }
  return cached;
}

function getSnapshotForKey(key: string): () => boolean {
  let cached = snapshotCache.get(key);
  if (!cached) {
    cached = () => readBooleanPref(key, false);
    snapshotCache.set(key, cached);
  }
  return cached;
}

const SERVER_DEFAULT_FALSE = () => false;

function useBooleanPref(key: string): boolean {
  return useSyncExternalStore(
    getSubscribeForKey(key),
    getSnapshotForKey(key),
    SERVER_DEFAULT_FALSE,
  );
}

// ---------------------------------------------------------------------------
// First-seen timestamp
// ---------------------------------------------------------------------------

export function ensureFirstSeenAt(): void {
  if (typeof window === "undefined") {
    return;
  }
  const existing = readNumberPref(KEY_DISCORD_NUDGE_FIRST_SEEN_AT, 0);
  if (existing === 0) {
    writeNumberPref(KEY_DISCORD_NUDGE_FIRST_SEEN_AT, Date.now());
  }
}

export function readFirstSeenAt(): number {
  return readNumberPref(KEY_DISCORD_NUDGE_FIRST_SEEN_AT, 0);
}

// ---------------------------------------------------------------------------
// Prerequisite checks
// ---------------------------------------------------------------------------

function isGitHubNudgeResolved(): boolean {
  const starred = readGitHubNudgeStarred();
  if (starred) {
    return true;
  }
  const bannerDismissed = readBooleanPref(KEY_GITHUB_NUDGE_BANNER_DISMISSED, false);
  const sidebarDismissed = readBooleanPref(KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED, false);
  return bannerDismissed && sidebarDismissed;
}

function isGitHubDismissCooldownElapsed(): boolean {
  const dismissedAt = readGitHubBannerDismissedAt();
  if (dismissedAt === 0) {
    return true;
  }
  return Date.now() - dismissedAt >= DISCORD_GITHUB_DISMISS_COOLDOWN_MS;
}

function isAccountAgeEligible(): boolean {
  if (DISCORD_MIN_ACCOUNT_AGE_MS <= 0) {
    return true;
  }
  const firstSeen = readFirstSeenAt();
  if (firstSeen === 0) {
    return false;
  }
  return Date.now() - firstSeen >= DISCORD_MIN_ACCOUNT_AGE_MS;
}

export function areDiscordPrerequisitesMet(
  platformNudgeResolved: boolean,
  conversationCount: number,
): boolean {
  if (!platformNudgeResolved) {
    return false;
  }
  if (!isGitHubNudgeResolved()) {
    return false;
  }
  if (!isAccountAgeEligible()) {
    return false;
  }
  if (conversationCount < DISCORD_MIN_CONVERSATION_COUNT) {
    return false;
  }
  if (!isGitHubDismissCooldownElapsed()) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public readers / writers
// ---------------------------------------------------------------------------

export function readDiscordNudgeJoined(): boolean {
  return readBooleanPref(KEY_DISCORD_NUDGE_JOINED, false);
}

function writeDiscordNudgeJoined(): void {
  writeBooleanPref(KEY_DISCORD_NUDGE_JOINED, true);
}

export function joinDiscord(): void {
  openDiscordInvite();
  writeDiscordNudgeJoined();
}

function writeDiscordBannerDismissed(): void {
  writeBooleanPref(KEY_DISCORD_NUDGE_BANNER_DISMISSED, true);
}

function writeDiscordSidebarDismissed(): void {
  writeBooleanPref(KEY_DISCORD_NUDGE_SIDEBAR_DISMISSED, true);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface DiscordNudgeState {
  /** True iff the user hasn't joined and hasn't dismissed the banner and prerequisites are met. */
  bannerShouldShow: boolean;
  /**
   * True iff the user hasn't joined, hasn't dismissed the sidebar
   * entry, AND has already dismissed (or no longer needs to see) the
   * banner. The banner is the first surface; the sidebar only appears
   * once the banner is no longer eligible to render.
   */
  sidebarEntryVisible: boolean;
  /** Open the Discord invite and persist the "joined" flag. */
  handleJoin: () => void;
  /** Persist the "banner dismissed" flag. */
  handleBannerDismiss: () => void;
  /** Persist the "sidebar dismissed" flag. */
  handleSidebarDismiss: () => void;
}

export function useDiscordNudgeState(
  platformNudgeResolved: boolean,
  conversationCount: number,
): DiscordNudgeState {
  const joined = useBooleanPref(KEY_DISCORD_NUDGE_JOINED);
  const bannerDismissed = useBooleanPref(KEY_DISCORD_NUDGE_BANNER_DISMISSED);
  const sidebarDismissed = useBooleanPref(KEY_DISCORD_NUDGE_SIDEBAR_DISMISSED);

  const prerequisitesMet = areDiscordPrerequisitesMet(
    platformNudgeResolved,
    conversationCount,
  );

  const handleJoin = useCallback(() => {
    openDiscordInvite();
    writeDiscordNudgeJoined();
  }, []);

  const handleBannerDismiss = useCallback(() => {
    writeDiscordBannerDismissed();
  }, []);

  const handleSidebarDismiss = useCallback(() => {
    writeDiscordSidebarDismissed();
  }, []);

  return {
    bannerShouldShow: prerequisitesMet && !joined && !bannerDismissed,
    sidebarEntryVisible: prerequisitesMet && computeNudgeSidebarVisible({
      converted: joined,
      bannerDismissed,
      sidebarDismissed,
    }),
    handleJoin,
    handleBannerDismiss,
    handleSidebarDismiss,
  };
}

// ---------------------------------------------------------------------------
// Discord URL helper
// ---------------------------------------------------------------------------

export function openDiscordInvite(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.open(DISCORD_INVITE_URL, "_blank", "noopener,noreferrer");
}

// ---------------------------------------------------------------------------
// Internals exported for tests only. Not part of the public API.
// ---------------------------------------------------------------------------

export const __testing = {
  writeDiscordNudgeJoined,
  writeDiscordBannerDismissed,
  writeDiscordSidebarDismissed,
  isGitHubNudgeResolved,
  isGitHubDismissCooldownElapsed,
  isAccountAgeEligible,
};
