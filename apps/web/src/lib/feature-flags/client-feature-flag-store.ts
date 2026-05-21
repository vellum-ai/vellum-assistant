import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";
import {
  CLIENT_FLAG_DEFAULTS,
  type ClientFeatureFlags,
} from "@/lib/feature-flags/feature-flag-catalog.js";

const CLIENT_DEFAULTS = CLIENT_FLAG_DEFAULTS;

interface ClientFeatureFlagActions {
  setFlags: (flags: Partial<ClientFeatureFlags>) => void;
  setFlag: <K extends keyof ClientFeatureFlags>(
    key: K,
    value: ClientFeatureFlags[K],
  ) => void;
}

type ClientFeatureFlagStore = ClientFeatureFlags & ClientFeatureFlagActions;

const useClientFeatureFlagStoreBase = create<ClientFeatureFlagStore>()(
  (set) => ({
    ...CLIENT_DEFAULTS,

    setFlags: (flags) =>
      set((prev) => {
        const changed = (
          Object.keys(flags) as (keyof ClientFeatureFlags)[]
        ).some((k) => flags[k] !== prev[k]);
        return changed ? flags : prev;
      }),

    setFlag: (key, value) => set({ [key]: value }),
  }),
);

export const useClientFeatureFlagStore = createSelectors(
  useClientFeatureFlagStoreBase,
);
