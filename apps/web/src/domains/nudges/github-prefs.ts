/**
 * GitHub-nudge public API.
 *
 * Backed by `useNudgeStore`; this file just exposes the GitHub-specific
 * derived state, click handlers, and a few non-React readers used by the
 * Discord-nudge prerequisite checks.
 */

import { useCallback } from "react";

import { computeNudgeSidebarVisible } from "@/domains/nudges/nudge-prefs.js";
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
  /**
   * True iff the user hasn't starred, hasn't dismissed the sidebar
   * entry, AND has already dismissed (or no longer needs to see) the
   * banner. The banner is the first surface; the sidebar only appears
   * once the banner is no longer eligible to render.
   */
  sidebarEntryVisible: boolean;
  /** Open the GitHub repo and persist the "starred" flag. */
  handleStar: () => void;
  /** Persist the "banner dismissed" flag. */
  handleBannerDismiss: () => void;
  /** Persist the "sidebar dismissed" flag. */
  handleSidebarDismiss: () => void;
}

export function useGitHubNudgeState(): GitHubNudgeState {
  const starred = useNudgeStore.use.githubStarred();
  const bannerDismissed = useNudgeStore.use.githubBannerDismissed();
  const sidebarDismissed = useNudgeStore.use.githubSidebarDismissed();

  const handleStar = useCallback(() => {
    openGitHubRepo();
    useNudgeStore.getState().markGitHubStarred();
  }, []);

  const handleBannerDismiss = useCallback(() => {
    useNudgeStore.getState().dismissGitHubBanner();
  }, []);

  const handleSidebarDismiss = useCallback(() => {
    useNudgeStore.getState().dismissGitHubSidebar();
  }, []);

  return {
    bannerShouldShow: !starred && !bannerDismissed,
    sidebarEntryVisible: computeNudgeSidebarVisible({
      converted: starred,
      bannerDismissed,
      sidebarDismissed,
    }),
    handleStar,
    handleBannerDismiss,
    handleSidebarDismiss,
  };
}

// ---------------------------------------------------------------------------
// Repo URL helper
// ---------------------------------------------------------------------------

export function openGitHubRepo(): void {
  if (typeof window === "undefined") return;
  window.open(GITHUB_REPO_URL, "_blank", "noopener,noreferrer");
}
