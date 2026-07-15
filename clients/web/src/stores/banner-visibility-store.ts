/**
 * Zustand store tracking whether a composer nudge banner is currently
 * visible. Contract for mutual exclusivity: a sidebar tip must never render
 * while a composer nudge banner is showing, so tip surfaces read
 * `bannerVisible` and hide themselves when it's true.
 *
 * Not persisted — visibility is derived live by `use-chat-banner-slots`.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// State & Actions
// ---------------------------------------------------------------------------

export interface BannerVisibilityState {
  bannerVisible: boolean;
}

export interface BannerVisibilityActions {
  setBannerVisible: (value: boolean) => void;
}

export type BannerVisibilityStore = BannerVisibilityState &
  BannerVisibilityActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useBannerVisibilityStoreBase = create<BannerVisibilityStore>()(
  (set, get) => ({
    bannerVisible: false,

    setBannerVisible: (value) => {
      if (get().bannerVisible !== value) {
        set({ bannerVisible: value });
      }
    },
  }),
);

export const useBannerVisibilityStore = createSelectors(
  useBannerVisibilityStoreBase,
);
