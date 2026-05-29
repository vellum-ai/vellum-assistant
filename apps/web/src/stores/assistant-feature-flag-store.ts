import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import { client } from "@/generated/api/client.gen";
import { ASSISTANT_FLAG_DEFAULTS, storeKeyToFlagKey } from "@/lib/feature-flags/feature-flag-catalog";

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
  /**
   * Apply an override and PATCH the server. `assistantId` is passed in
   * by the caller (e.g. the Developer panel or the dev-mode unlock
   * gesture) rather than read from a module-level cache, so this store
   * doesn't need its own copy of the active assistant — that lives in
   * the assistant lifecycle on `RootLayout`.
   */
  setFlag: (key: string, value: boolean, assistantId: string | null) => void;
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

      setFlag: (key: string, value: boolean, assistantId: string | null) => {
        // Fire the PATCH before updating local state: the platform-features
        // interceptor reads this store synchronously, so toggling
        // platformFeaturesInLocalMode OFF would block its own request.
        const flagKey = storeKeyToFlagKey(key);
        if (assistantId && flagKey) {
          void client.patch({
            url: `/v1/assistants/${assistantId}/feature-flags/${flagKey}`,
            body: { enabled: value },
            throwOnError: false,
          } as Parameters<typeof client.patch>[0]);
        }

        set({ [key]: value });
      },

      markHydrated: () => set({ hasHydrated: true }),

      resetForAssistantSwitch: () =>
        set({ ...ASSISTANT_FLAG_DEFAULTS, hasHydrated: false }),
    }) as AssistantFeatureFlagStore,
);

export const useAssistantFeatureFlagStore = createSelectors(
  useAssistantFeatureFlagStoreBase,
);
