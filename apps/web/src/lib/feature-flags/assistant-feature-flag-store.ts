import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";
import {
  ASSISTANT_FLAG_DEFAULTS,
  type AssistantFeatureFlags,
} from "@/lib/feature-flags/feature-flag-catalog.js";

const ASSISTANT_DEFAULTS = ASSISTANT_FLAG_DEFAULTS;

interface AssistantFeatureFlagActions {
  setFlags: (flags: Partial<AssistantFeatureFlags>) => void;
  setFlag: <K extends keyof AssistantFeatureFlags>(
    key: K,
    value: AssistantFeatureFlags[K],
  ) => void;
}

type AssistantFeatureFlagStore = AssistantFeatureFlags &
  AssistantFeatureFlagActions;

const useAssistantFeatureFlagStoreBase = create<AssistantFeatureFlagStore>()(
  (set) => ({
    ...ASSISTANT_DEFAULTS,

    setFlags: (flags) =>
      set((prev) => {
        const changed = (
          Object.keys(flags) as (keyof AssistantFeatureFlags)[]
        ).some((k) => flags[k] !== prev[k]);
        return changed ? flags : prev;
      }),

    setFlag: (key, value) => set({ [key]: value }),
  }),
);

export const useAssistantFeatureFlagStore = createSelectors(
  useAssistantFeatureFlagStoreBase,
);
