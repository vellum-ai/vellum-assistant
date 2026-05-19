
import { useCallback, useSyncExternalStore } from "react";

import {
  computeNudgeSidebarVisible,
  readBooleanPref,
  writeBooleanPref,
  writeNumberPref,
  readNumberPref,
} from "@/domains/nudges/nudge-prefs.js";

import {
  GITHUB_REPO_URL,
  KEY_GITHUB_NUDGE_BANNER_DISMISSED,
  KEY_GITHUB_NUDGE_BANNER_DISMISSED_AT,
  KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED,
  KEY_GITHUB_NUDGE_STARRED,
} from "@/domains/nudges/github-constants.js";

// ---------------------------------------------------------------------------
// External-store subscription
// ---------------------------------------------------------------------------
//
// `setLocalSetting` (the underlying writer behind `writeBooleanPref`)
// dispatches a synthetic `vellum:pref-changed` CustomEvent on `window`
// after every same-tab write, and the browser dispatches a native
// `storage` event on cross-tab writes. Both are bridged into
// `useSyncExternalStore` so every consumer of a given pref key re-renders
// the instant the flag flips on any surface or tab.
//
// The subscribe callback filters on `detail.key` (same-tab) and
// `event.key` (cross-tab) so unrelated pref flips do not trigger
// spurious re-renders.
//
// `subscribe` and `getSnapshot` are cached at module scope per pref key.
// `useSyncExternalStore` compares `subscribe` by reference and
// re-subscribes whenever it receives a fresh function — see
// https://react.dev/reference/react/useSyncExternalStore#parameters —
// so creating a new closure on every render would tear down and re-add
// listeners every render. Same convention as `useIsMobile.ts`.

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
      if (typeof window === "undefined") return () => {};
      const handleSameTab = (event: Event) => {
        const detail = (event as PrefChangeEvent).detail;
        if (detail?.key === key) listener();
      };
      const handleCrossTab = (event: StorageEvent) => {
        if (event.key === key) listener();
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
// Public readers / writers
// ---------------------------------------------------------------------------

export function readGitHubNudgeStarred(): boolean {
  return readBooleanPref(KEY_GITHUB_NUDGE_STARRED, false);
}

function writeGitHubNudgeStarred(): void {
  writeBooleanPref(KEY_GITHUB_NUDGE_STARRED, true);
}

function writeGitHubBannerDismissed(): void {
  writeBooleanPref(KEY_GITHUB_NUDGE_BANNER_DISMISSED, true);
  writeNumberPref(KEY_GITHUB_NUDGE_BANNER_DISMISSED_AT, Date.now());
}

export function readGitHubBannerDismissedAt(): number {
  return readNumberPref(KEY_GITHUB_NUDGE_BANNER_DISMISSED_AT, 0);
}

function writeGitHubSidebarDismissed(): void {
  writeBooleanPref(KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED, true);
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
  const starred = useBooleanPref(KEY_GITHUB_NUDGE_STARRED);
  const bannerDismissed = useBooleanPref(KEY_GITHUB_NUDGE_BANNER_DISMISSED);
  const sidebarDismissed = useBooleanPref(KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED);

  const handleStar = useCallback(() => {
    openGitHubRepo();
    writeGitHubNudgeStarred();
  }, []);

  const handleBannerDismiss = useCallback(() => {
    writeGitHubBannerDismissed();
  }, []);

  const handleSidebarDismiss = useCallback(() => {
    writeGitHubSidebarDismissed();
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

// ---------------------------------------------------------------------------
// Internals exported for tests only. Not part of the public API.
// ---------------------------------------------------------------------------

export const __testing = {
  writeGitHubNudgeStarred,
  writeGitHubBannerDismissed,
  writeGitHubSidebarDismissed,
  readGitHubBannerDismissedAt,
};
