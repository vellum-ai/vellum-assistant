/**
 * Zustand store for GitHub + Discord nudge prefs.
 *
 * Owns whether each nudge has been actioned (starred, joined) or
 * dismissed (banner, sidebar) and when. `github-prefs.ts` and
 * `discord-prefs.ts` expose thin selector hooks (`useGitHubNudgeState`,
 * `useDiscordNudgeState`) backed by this store.
 *
 * **Storage model:**
 *
 * - The persist middleware serialises the whole nudge slice into a
 *   single localStorage key, `vellum:nudge-prefs`.
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
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: NudgeState = {
  githubStarred: false,
  githubBannerDismissed: false,
  githubBannerDismissedAt: 0,
  githubSidebarDismissed: false,
  discordJoined: false,
  discordBannerDismissed: false,
  discordSidebarDismissed: false,
  discordFirstSeenAt: 0,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const NUDGE_STORE_KEY = "vellum:nudge-prefs";

const useNudgeStoreBase = create<NudgeStore>()(
  persist(
    (set, get) => ({
      ...INITIAL_STATE,

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

// ---------------------------------------------------------------------------
// One-shot legacy cleanup
// ---------------------------------------------------------------------------

// One-time cleanup of legacy per-key localStorage entries from an
// older nudge-state shape. The persist middleware now owns the state
// under `vellum:nudge-prefs`; the old keys are orphaned bytes on
// every user's device and get removed on first load.
const LEGACY_CLEANUP_FLAG = "app.nudgeLegacy.cleaned";

const LEGACY_KEYS = [
  KEY_GITHUB_NUDGE_STARRED,
  KEY_GITHUB_NUDGE_BANNER_DISMISSED,
  KEY_GITHUB_NUDGE_BANNER_DISMISSED_AT,
  KEY_GITHUB_NUDGE_SIDEBAR_DISMISSED,
  KEY_DISCORD_NUDGE_JOINED,
  KEY_DISCORD_NUDGE_BANNER_DISMISSED,
  KEY_DISCORD_NUDGE_SIDEBAR_DISMISSED,
  KEY_DISCORD_NUDGE_FIRST_SEEN_AT,
];

if (typeof window !== "undefined") {
  try {
    if (localStorage.getItem(LEGACY_CLEANUP_FLAG) !== "true") {
      // Calling localStorage.removeItem directly (rather than going through
      // `removeLocalSetting` in domains/settings/) keeps this cleanup
      // self-contained — nothing listens for the `vellum:pref-changed`
      // event on these specific legacy keys.
      for (const key of LEGACY_KEYS) {
        localStorage.removeItem(key);
      }
      localStorage.setItem(LEGACY_CLEANUP_FLAG, "true");
    }
  } catch {
    // Storage unavailable (private mode, quota, etc.) — re-attempt next load.
  }
}
