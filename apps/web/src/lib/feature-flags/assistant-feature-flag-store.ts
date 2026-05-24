import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";
import { client } from "@/generated/api/client.gen.js";
import { ASSISTANT_FLAG_DEFAULTS, storeKeyToFlagKey } from "@/lib/feature-flags/feature-flag-catalog.js";

let currentAssistantId: string | null = null;

/**
 * Internal store fields that are NOT feature flag values. Surfaces that
 * enumerate flags (e.g. the feature flags settings panel) iterate over
 * `ALL_FLAGS` from the registry rather than the store's own keys, so
 * meta-state lives alongside flag values without leaking into UI lists.
 */
interface AssistantFeatureFlagMeta {
  /**
   * `false` until the first real `/feature-flags` response has been
   * applied for the current assistant. Until then, flag values are
   * registry defaults (typically `false`) — code that gates navigation
   * or destructive UI on a flag must wait for `hasHydrated === true`
   * before treating a `false` flag as authoritative.
   */
  hasHydrated: boolean;
}

interface AssistantFeatureFlagActions {
  setFlags: (flags: Record<string, boolean>) => void;
  setFlag: (key: string, value: boolean) => void;
  /** Marks the store as having received real /feature-flags data. */
  markHydrated: () => void;
  /** Called on assistant switch: resets to defaults + clears hasHydrated. */
  resetForAssistantSwitch: () => void;
}

type AssistantFeatureFlagStore = Record<string, boolean> &
  AssistantFeatureFlagMeta &
  AssistantFeatureFlagActions;

const useAssistantFeatureFlagStoreBase = create<AssistantFeatureFlagStore>()(
  (set) =>
    ({
      ...ASSISTANT_FLAG_DEFAULTS,
      hasHydrated: false,

      setFlags: (flags: Record<string, boolean>) =>
        set((prev) => {
          const changed = Object.keys(flags).some(
            (k) => flags[k] !== prev[k],
          );
          return changed ? flags : prev;
        }),

      setFlag: (key: string, value: boolean) => {
        set({ [key]: value });

        const flagKey = storeKeyToFlagKey(key);
        if (currentAssistantId && flagKey) {
          void client.patch({
            url: `/v1/assistants/${currentAssistantId}/feature-flags/${flagKey}`,
            body: { enabled: value },
            throwOnError: false,
          } as Parameters<typeof client.patch>[0]);
        }
      },

      markHydrated: () => set({ hasHydrated: true }),

      resetForAssistantSwitch: () =>
        set({ ...ASSISTANT_FLAG_DEFAULTS, hasHydrated: false }),
    }) as AssistantFeatureFlagStore,
);

export const useAssistantFeatureFlagStore = createSelectors(
  useAssistantFeatureFlagStoreBase,
);

export function setAssistantIdForFlags(id: string | null) {
  currentAssistantId = id;
}
