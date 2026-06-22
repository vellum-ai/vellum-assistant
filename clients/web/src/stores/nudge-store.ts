/**
 * Zustand store for GitHub + Discord nudge prefs.
 *
 * Owns whether each nudge has been actioned (starred, joined) or
 * dismissed (banner) and when. `use-github-nudge.ts` and
 * `use-discord-nudge.ts` expose thin selector hooks backed by this store.
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

import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface NudgeState {
  githubStarred: boolean;
  githubBannerDismissed: boolean;
  /** Epoch ms of the most recent GitHub banner dismiss. 0 = never. */
  githubBannerDismissedAt: number;
  /** Epoch ms of the first time the GitHub nudge module observed the user. 0 = not yet recorded. */
  githubFirstSeenAt: number;
  /** Cumulative count of user messages sent across all conversations. */
  githubUserMessagesSeen: number;
  discordJoined: boolean;
  discordBannerDismissed: boolean;
  /** Epoch ms of the first time the Discord nudge module observed the user. 0 = not yet recorded. */
  discordFirstSeenAt: number;
}

export interface NudgeActions {
  markGitHubStarred: () => void;
  dismissGitHubBanner: () => void;
  /** Stamp `githubFirstSeenAt` to `Date.now()` on first observation. No-op afterwards. */
  ensureGitHubFirstSeenAt: () => void;
  incrementGitHubUserMessagesSeen: (delta: number) => void;
  markDiscordJoined: () => void;
  dismissDiscordBanner: () => void;
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
  githubFirstSeenAt: 0,
  githubUserMessagesSeen: 0,
  discordJoined: false,
  discordBannerDismissed: false,
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
      ensureGitHubFirstSeenAt: () => {
        if (get().githubFirstSeenAt === 0) {
          set({ githubFirstSeenAt: Date.now() });
        }
      },
      incrementGitHubUserMessagesSeen: (delta: number) => {
        if (delta <= 0) return;
        set({ githubUserMessagesSeen: get().githubUserMessagesSeen + delta });
      },
      markDiscordJoined: () => set({ discordJoined: true }),
      dismissDiscordBanner: () => set({ discordBannerDismissed: true }),
      ensureDiscordFirstSeenAt: () => {
        if (get().discordFirstSeenAt === 0) {
          set({ discordFirstSeenAt: Date.now() });
        }
      },
    }),
    {
      name: NUDGE_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        githubStarred: state.githubStarred,
        githubBannerDismissed: state.githubBannerDismissed,
        githubBannerDismissedAt: state.githubBannerDismissedAt,
        githubFirstSeenAt: state.githubFirstSeenAt,
        githubUserMessagesSeen: state.githubUserMessagesSeen,
        discordJoined: state.discordJoined,
        discordBannerDismissed: state.discordBannerDismissed,
        discordFirstSeenAt: state.discordFirstSeenAt,
      }),
    },
  ),
);

export const useNudgeStore = createSelectors(useNudgeStoreBase);

// ---------------------------------------------------------------------------
// Cross-tab sync
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === NUDGE_STORE_KEY) {
      void useNudgeStoreBase.persist.rehydrate();
    }
  });
}


