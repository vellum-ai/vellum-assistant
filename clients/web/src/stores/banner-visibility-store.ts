import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * Zustand store tracking whether a composer nudge banner is currently
 * rendered. Contract for mutual exclusivity: a sidebar tip must never render
 * while a composer nudge banner is showing, so tip surfaces read
 * {@link useBannerVisible} and hide themselves while it's true.
 *
 * Each `ChatBody` instance that actually mounts its banner overlay registers
 * here for the duration. A count (not a boolean) tolerates concurrent
 * instances — main chat plus the app-editing side panel — without a
 * last-write-wins race, mirroring `edge-swipe-arbiter-store`.
 *
 * Not persisted — visibility is live render state.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */
interface BannerVisibilityState {
  /** Number of currently mounted nudge banner overlays. */
  visibleBannerCount: number;
}

interface BannerVisibilityActions {
  registerVisibleBanner: () => void;
  unregisterVisibleBanner: () => void;
}

const useBannerVisibilityStoreBase = create<
  BannerVisibilityState & BannerVisibilityActions
>()((set) => ({
  visibleBannerCount: 0,

  registerVisibleBanner: () =>
    set((state) => ({ visibleBannerCount: state.visibleBannerCount + 1 })),
  unregisterVisibleBanner: () =>
    set((state) => ({
      visibleBannerCount: Math.max(0, state.visibleBannerCount - 1),
    })),
}));

export const useBannerVisibilityStore = createSelectors(
  useBannerVisibilityStoreBase,
);

/** Reactive read for tip surfaces — true while any nudge banner is mounted. */
export const useBannerVisible = () =>
  useBannerVisibilityStore.use.visibleBannerCount() > 0;
