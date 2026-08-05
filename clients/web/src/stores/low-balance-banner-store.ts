import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * Zustand store for the session-scoped dismissal of the proactive low-balance
 * composer banner. "Session" means until the page or app reloads: the store is
 * deliberately in-memory only (no persistence), so a fresh load shows the
 * banner again while the server still reports a low balance.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */
interface LowBalanceBannerState {
  /** True once the user dismisses the banner for the rest of this session. */
  dismissed: boolean;
}

interface LowBalanceBannerActions {
  dismiss: () => void;
}

const useLowBalanceBannerStoreBase = create<
  LowBalanceBannerState & LowBalanceBannerActions
>()((set) => ({
  dismissed: false,

  dismiss: () => set({ dismissed: true }),
}));

export const useLowBalanceBannerStore = createSelectors(
  useLowBalanceBannerStoreBase,
);
