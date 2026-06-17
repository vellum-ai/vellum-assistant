/**
 * Discord-nudge public API.
 *
 * Backed by `useNudgeStore`; this file exposes the Discord-specific derived
 * state, click handlers, and prerequisite checks (account age, GitHub-nudge
 * cascade, conversation count).
 */

import { useCallback } from "react";

import { useNudgeStore } from "@/stores/nudge-store";
import {
  readGitHubNudgeStarred,
  readGitHubBannerDismissedAt,
} from "@/hooks/use-github-nudge";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
  return useNudgeStore.getState().githubBannerDismissed;
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
  /** Open the Discord invite and persist the "joined" flag. */
  handleJoin: () => void;
  /** Persist the "banner dismissed" flag. */
  handleBannerDismiss: () => void;
}

export function useDiscordNudgeState(
  platformNudgeResolved: boolean,
  conversationCount: number,
): DiscordNudgeState {
  const joined = useNudgeStore.use.discordJoined();
  const bannerDismissed = useNudgeStore.use.discordBannerDismissed();

  useNudgeStore.use.githubStarred();
  useNudgeStore.use.githubBannerDismissed();
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

  return {
    bannerShouldShow: prerequisitesMet && !joined && !bannerDismissed,
    handleJoin,
    handleBannerDismiss,
  };
}

// ---------------------------------------------------------------------------
// Discord URL helper
// ---------------------------------------------------------------------------

export function openDiscordInvite(): void {
  if (typeof window === "undefined") return;
  window.open(DISCORD_INVITE_URL, "_blank", "noopener,noreferrer");
}
