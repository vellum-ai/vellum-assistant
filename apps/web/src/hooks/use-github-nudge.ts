/**
 * GitHub-nudge public API.
 *
 * Backed by `useNudgeStore`; this file exposes the GitHub-specific
 * derived state, click handlers, and a few non-React readers used by the
 * Discord-nudge prerequisite checks.
 */

import { useCallback } from "react";

import { useNudgeStore } from "@/stores/nudge-store";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Public GitHub repository for Vellum Assistant. */
export const GITHUB_REPO_URL =
  "https://github.com/vellum-ai/vellum-assistant";

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
