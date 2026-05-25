/**
 * GitHub-nudge public API.
 *
 * Backed by `useNudgeStore`; this file just exposes the GitHub-specific
 * derived state, click handlers, and a few non-React readers used by the
 * Discord-nudge prerequisite checks.
 */

import { useCallback } from "react";

import { useNudgeStore } from "@/domains/nudges/nudge-store.js";
import { GITHUB_REPO_URL } from "@/domains/nudges/github-constants.js";

// ---------------------------------------------------------------------------
// Public readers (non-React, for cross-module prerequisite checks)
// ---------------------------------------------------------------------------

export function readGitHubNudgeStarred(): boolean {
  return useNudgeStore.getState().githubStarred;
}

export function readGitHubBannerDismissedAt(): number {
  return useNudgeStore.getState().githubBannerDismissedAt;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface GitHubNudgeState {
  /** True iff the user hasn't starred and hasn't dismissed the banner. */
  bannerShouldShow: boolean;
  /** Open the GitHub repo and persist the "starred" flag. */
  handleStar: () => void;
  /** Persist the "banner dismissed" flag. */
  handleBannerDismiss: () => void;
}

export function useGitHubNudgeState(): GitHubNudgeState {
  const starred = useNudgeStore.use.githubStarred();
  const bannerDismissed = useNudgeStore.use.githubBannerDismissed();

  const handleStar = useCallback(() => {
    openGitHubRepo();
    useNudgeStore.getState().markGitHubStarred();
  }, []);

  const handleBannerDismiss = useCallback(() => {
    useNudgeStore.getState().dismissGitHubBanner();
  }, []);

  return {
    bannerShouldShow: !starred && !bannerDismissed,
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
