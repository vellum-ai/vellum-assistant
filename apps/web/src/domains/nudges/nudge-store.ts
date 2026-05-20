/**
 * Zustand store for GitHub + Discord nudge prefs.
 *
 * Replaces the hand-rolled `useSyncExternalStore` + per-key
 * subscribe/snapshot caches that previously lived in `github-prefs.ts`
 * and `discord-prefs.ts`. Both pref modules now read/write through this
 * store; their public hooks (`useGitHubNudgeState`, `useDiscordNudgeState`)
 * remain as thin selector wrappers so consumers don't change.
 *
 * **Storage model:**
 *
 * - The persist middleware serialises the whole nudge slice into a
 *   single localStorage key, `vellum:nudge-prefs`.
 * - On first load (no `vellum:nudge-prefs` key present), the initial
 *   state is seeded from the legacy per-key entries the old modules
 *   wrote (`app.githubNudge.starred`, `app.discordNudge.joined`, etc.),
 *   so users carrying over from the platform deployment keep their
 *   dismissals.
 * - Cross-tab updates: the persist middleware doesn't sync across tabs
 *   on its own. We listen for `storage` events on `vellum:nudge-prefs`
 *   and call `persist.rehydrate()` to pull in the other tab's write.
 *
 * Reference:
 * - {@link https://zustand.docs.pmnd.rs/}
 * - {@link https://zustand.docs.pmnd.rs/integrations/persisting-store-data}
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { createSelectors } from "@/utils/create-selectors.js";

import {
  readBooleanPref,
  readNumberPref,
} from "@/domains/nudges/nudge-prefs.js";
import {
  KEY_GITHUB_NUDGE_STARRED,
  KEY_GITHUB_NUDGE_BANNER_DISMISSED,
  KEY_GITHUB_NUDGE_BANNER_DISMISSED_AT,
  KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED,
} from "@/domains/nudges/github-constants.js";
import {
  KEY_DISCORD_NUDGE_JOINED,
  KEY_DISCORD_NUDGE_BANNER_DISMISSED,
  KEY_DISCORD_NUDGE_SIDEBAR_DISMISSED,
  KEY_DISCORD_NUDGE_FIRST_SEEN_AT,
} from "@/domains/nudges/discord-constants.js";

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface NudgeState {
  githubStarred: boolean;
  githubBannerDismissed: boolean;
  /** Epoch ms of the most recent GitHub banner dismiss. 0 = never. */
  githubBannerDismissedAt: number;
  githubSidebarDismissed: boolean;
  discordJoined: boolean;
  discordBannerDismissed: boolean;
  discordSidebarDismissed: boolean;
  /** Epoch ms of the first time the Discord nudge module observed the user. 0 = not yet recorded. */
  discordFirstSeenAt: number;
}

export interface NudgeActions {
  markGitHubStarred: () => void;
  dismissGitHubBanner: () => void;
  dismissGitHubSidebar: () => void;
  markDiscordJoined: () => void;
  dismissDiscordBanner: () => void;
  dismissDiscordSidebar: () => void;
  /** Stamp `discordFirstSeenAt` to `Date.now()` on first observation. No-op afterwards. */
  ensureDiscordFirstSeenAt: () => void;
}

export type NudgeStore = NudgeState & NudgeActions;

// ---------------------------------------------------------------------------
// Initial state — hydrate from legacy per-key localStorage entries
// ---------------------------------------------------------------------------

function computeInitialFromLegacy(): NudgeState {
  return {
    githubStarred: readBooleanPref(KEY_GITHUB_NUDGE_STARRED, false),
    githubBannerDismissed: readBooleanPref(KEY_GITHUB_NUDGE_BANNER_DISMISSED, false),
    githubBannerDismissedAt: readNumberPref(KEY_GITHUB_NUDGE_BANNER_DISMISSED_AT, 0),
    githubSidebarDismissed: readBooleanPref(KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED, false),
    discordJoined: readBooleanPref(KEY_DISCORD_NUDGE_JOINED, false),
    discordBannerDismissed: readBooleanPref(KEY_DISCORD_NUDGE_BANNER_DISMISSED, false),
    discordSidebarDismissed: readBooleanPref(KEY_DISCORD_NUDGE_SIDEBAR_DISMISSED, false),
    discordFirstSeenAt: readNumberPref(KEY_DISCORD_NUDGE_FIRST_SEEN_AT, 0),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const NUDGE_STORE_KEY = "vellum:nudge-prefs";

const useNudgeStoreBase = create<NudgeStore>()(
  persist(
    (set, get) => ({
      ...computeInitialFromLegacy(),

      markGitHubStarred: () => set({ githubStarred: true }),
      dismissGitHubBanner: () =>
        set({
          githubBannerDismissed: true,
          githubBannerDismissedAt: Date.now(),
        }),
      dismissGitHubSidebar: () => set({ githubSidebarDismissed: true }),
      markDiscordJoined: () => set({ discordJoined: true }),
      dismissDiscordBanner: () => set({ discordBannerDismissed: true }),
      dismissDiscordSidebar: () => set({ discordSidebarDismissed: true }),
      ensureDiscordFirstSeenAt: () => {
        if (get().discordFirstSeenAt === 0) {
          set({ discordFirstSeenAt: Date.now() });
        }
      },
    }),
    {
      name: NUDGE_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Only persist state, not action functions.
      partialize: (state) => ({
        githubStarred: state.githubStarred,
        githubBannerDismissed: state.githubBannerDismissed,
        githubBannerDismissedAt: state.githubBannerDismissedAt,
        githubSidebarDismissed: state.githubSidebarDismissed,
        discordJoined: state.discordJoined,
        discordBannerDismissed: state.discordBannerDismissed,
        discordSidebarDismissed: state.discordSidebarDismissed,
        discordFirstSeenAt: state.discordFirstSeenAt,
      }),
    },
  ),
);

export const useNudgeStore = createSelectors(useNudgeStoreBase);

// ---------------------------------------------------------------------------
// Cross-tab sync
// ---------------------------------------------------------------------------

// `localStorage.setItem` fires a native `storage` event in *other* tabs.
// Persist middleware doesn't subscribe to it on its own, so wire a listener
// that rehydrates this store whenever `vellum:nudge-prefs` changes elsewhere.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === NUDGE_STORE_KEY) {
      void useNudgeStoreBase.persist.rehydrate();
    }
  });
}
