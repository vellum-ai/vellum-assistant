/**
 * GitHub-nudge public API.
 *
 * Backed by `useNudgeStore`; this file exposes the GitHub-specific
 * derived state, click handlers, and a few non-React readers used by the
 * Discord-nudge prerequisite checks.
 *
 * The nudge is gated behind two engagement thresholds (either one
 * qualifies): a minimum account age (time since first observation) and
 * a minimum number of user messages sent.
 */

import { useCallback, useEffect, useState } from "react";

import { useNudgeStore } from "@/stores/nudge-store";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Public GitHub repository for Vellum Assistant. */
export const GITHUB_REPO_URL =
  "https://github.com/vellum-ai/vellum-assistant";

/** Minimum account age (ms since first observation) before the nudge is eligible. */
export const GITHUB_MIN_AGE_MS = 5 * 60 * 1000; // 5 minutes

/** Minimum user messages sent before the nudge is eligible. */
export const GITHUB_MIN_USER_MESSAGES = 5;

// ---------------------------------------------------------------------------
// Public readers (non-React, for cross-module prerequisite checks)
// ---------------------------------------------------------------------------

export function readGitHubNudgeStarred(): boolean {
  return useNudgeStore.getState().githubStarred;
}

export function readGitHubBannerDismissedAt(): number {
  return useNudgeStore.getState().githubBannerDismissedAt;
}

export function readGitHubUserMessagesSeen(): number {
  return useNudgeStore.getState().githubUserMessagesSeen;
}

// ---------------------------------------------------------------------------
// First-seen timestamp
// ---------------------------------------------------------------------------

export function ensureGitHubFirstSeenAt(): void {
  useNudgeStore.getState().ensureGitHubFirstSeenAt();
}

export function incrementGitHubUserMessagesSeen(delta: number): void {
  useNudgeStore.getState().incrementGitHubUserMessagesSeen(delta);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface GitHubNudgeState {
  /** True iff the user hasn't starred, hasn't dismissed, and meets an engagement gate. */
  bannerShouldShow: boolean;
  /** Open the GitHub repo and persist the "starred" flag. */
  handleStar: () => void;
  /** Persist the "banner dismissed" flag. */
  handleBannerDismiss: () => void;
}

export function useGitHubNudgeState(): GitHubNudgeState {
  const starred = useNudgeStore.use.githubStarred();
  const bannerDismissed = useNudgeStore.use.githubBannerDismissed();
  const firstSeenAt = useNudgeStore.use.githubFirstSeenAt();
  const userMessagesSeen = useNudgeStore.use.githubUserMessagesSeen();

  // --- Age eligibility with timer -------------------------------------------
  const [ageEligible, setAgeEligible] = useState(() => {
    if (firstSeenAt === 0) return false;
    return Date.now() - firstSeenAt >= GITHUB_MIN_AGE_MS;
  });

  useEffect(() => {
    if (firstSeenAt === 0 || ageEligible) return;

    const remaining = GITHUB_MIN_AGE_MS - (Date.now() - firstSeenAt);
    if (remaining <= 0) {
      setAgeEligible(true);
      return;
    }

    const timer = setTimeout(() => setAgeEligible(true), remaining);
    return () => clearTimeout(timer);
  }, [firstSeenAt, ageEligible]);

  const messageEligible = userMessagesSeen >= GITHUB_MIN_USER_MESSAGES;
  const engagementMet = ageEligible || messageEligible;

  const handleStar = useCallback(() => {
    openGitHubRepo();
    useNudgeStore.getState().markGitHubStarred();
  }, []);

  const handleBannerDismiss = useCallback(() => {
    useNudgeStore.getState().dismissGitHubBanner();
  }, []);

  return {
    bannerShouldShow: !starred && !bannerDismissed && engagementMet,
    handleStar,
    handleBannerDismiss,
  };
}

// ---------------------------------------------------------------------------
// Repo URL helper
// ---------------------------------------------------------------------------

export function openGitHubRepo(): void {
  if (typeof window === "undefined") return;
  window.open(GITHUB_REPO_URL, "_blank", "noopener,noreferrer");
}
