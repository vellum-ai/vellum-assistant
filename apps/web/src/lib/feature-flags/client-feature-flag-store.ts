import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";
import { CLIENT_FLAG_DEFAULTS } from "@/lib/feature-flags/feature-flag-catalog.js";

interface ClientFeatureFlagStore extends Record<string, unknown> {
  setFlags: (flags: Record<string, boolean>) => void;
  setFlag: (key: string, value: boolean) => void;
}

const useClientFeatureFlagStoreBase = create<ClientFeatureFlagStore>()(
  (set) => ({
    ...CLIENT_FLAG_DEFAULTS,

    setFlags: (flags: Record<string, boolean>) =>
      set((prev) => {
        const changed = Object.keys(flags).some(
          (k) => flags[k] !== prev[k],
        );
        return changed ? flags : prev;
      }),

    setFlag: (key: string, value: boolean) => set({ [key]: value }),
  }),
);

export const useClientFeatureFlagStore = createSelectors(
  useClientFeatureFlagStoreBase,
);
