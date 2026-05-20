/**
 * Discord-nudge public API.
 *
 * Backed by `useNudgeStore`; this file exposes the Discord-specific derived
 * state, click handlers, and prerequisite checks (account age, GitHub-nudge
 * cascade, conversation count).
 */

import { useCallback } from "react";

import { computeNudgeSidebarVisible } from "@/domains/nudges/nudge-prefs.js";
import { useNudgeStore } from "@/domains/nudges/nudge-store.js";
import {
  readGitHubNudgeStarred,
  readGitHubBannerDismissedAt,
} from "@/domains/nudges/github-prefs.js";
import {
  DISCORD_INVITE_URL,
  DISCORD_MIN_CONVERSATION_COUNT,
  DISCORD_MIN_ACCOUNT_AGE_MS,
  DISCORD_GITHUB_DISMISS_COOLDOWN_MS,
} from "@/domains/nudges/discord-constants.js";

// ---------------------------------------------------------------------------
// First-seen timestamp
// ---------------------------------------------------------------------------

export function ensureFirstSeenAt(): void {
  useNudgeStore.getState().ensureDiscordFirstSeenAt();
}

export function readFirstSeenAt(): number {
  return useNudgeStore.getState().discordFirstSeenAt;
}

// ---------------------------------------------------------------------------
// Prerequisite checks
// ---------------------------------------------------------------------------

function isGitHubNudgeResolved(): boolean {
  if (readGitHubNudgeStarred()) {
    return true;
  }
  const state = useNudgeStore.getState();
  return state.githubBannerDismissed && state.githubSidebarDismissed;
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
  if (!platformNudgeResolved) return false;
  if (!isGitHubNudgeResolved()) return false;
  if (!isAccountAgeEligible()) return false;
  if (conversationCount < DISCORD_MIN_CONVERSATION_COUNT) return false;
  if (!isGitHubDismissCooldownElapsed()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public readers
// ---------------------------------------------------------------------------

export function readDiscordNudgeJoined(): boolean {
  return useNudgeStore.getState().discordJoined;
}

// ---------------------------------------------------------------------------
// Join flow
// ---------------------------------------------------------------------------

export function joinDiscord(): void {
  openDiscordInvite();
  useNudgeStore.getState().markDiscordJoined();
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
  const joined = useNudgeStore.use.discordJoined();
  const bannerDismissed = useNudgeStore.use.discordBannerDismissed();
  const sidebarDismissed = useNudgeStore.use.discordSidebarDismissed();

  // The Discord prereq cascade reads GitHub nudge state via `getState()`
  // inside `areDiscordPrerequisitesMet`. Subscribe to those fields here too
  // so the Discord nudge re-evaluates the moment a GitHub action flips one
  // of them — otherwise this component would only re-render when one of
  // its own three Discord fields changes.
  useNudgeStore.use.githubStarred();
  useNudgeStore.use.githubBannerDismissed();
  useNudgeStore.use.githubSidebarDismissed();
  useNudgeStore.use.discordFirstSeenAt();

  const prerequisitesMet = areDiscordPrerequisitesMet(
    platformNudgeResolved,
    conversationCount,
  );

  const handleJoin = useCallback(() => {
    openDiscordInvite();
    useNudgeStore.getState().markDiscordJoined();
  }, []);

  const handleBannerDismiss = useCallback(() => {
    useNudgeStore.getState().dismissDiscordBanner();
  }, []);

  const handleSidebarDismiss = useCallback(() => {
    useNudgeStore.getState().dismissDiscordSidebar();
  }, []);

  return {
    bannerShouldShow: prerequisitesMet && !joined && !bannerDismissed,
    sidebarEntryVisible:
      prerequisitesMet &&
      computeNudgeSidebarVisible({
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
  if (typeof window === "undefined") return;
  window.open(DISCORD_INVITE_URL, "_blank", "noopener,noreferrer");
}
