import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";
import { ASSISTANT_FLAG_DEFAULTS } from "@/lib/feature-flags/feature-flag-catalog.js";

interface AssistantFeatureFlagActions {
  setFlags: (flags: Record<string, boolean>) => void;
  setFlag: (key: string, value: boolean) => void;
}

type AssistantFeatureFlagStore = Record<string, boolean> & AssistantFeatureFlagActions;

const useAssistantFeatureFlagStoreBase = create<AssistantFeatureFlagStore>()(
  (set) => ({
    ...ASSISTANT_FLAG_DEFAULTS,

    setFlags: (flags: Record<string, boolean>) =>
      set((prev) => {
        const changed = Object.keys(flags).some(
          (k) => flags[k] !== prev[k],
        );
        return changed ? flags : prev;
      }),

    setFlag: (key: string, value: boolean) => set({ [key]: value }),
  } as AssistantFeatureFlagStore),
);

export const useAssistantFeatureFlagStore = createSelectors(
  useAssistantFeatureFlagStoreBase,
);
