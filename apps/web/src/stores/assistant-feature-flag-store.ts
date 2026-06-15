import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import { client } from "@/generated/api/client.gen";
import {
  ASSISTANT_FLAG_DEFAULTS,
  ASSISTANT_STRING_FLAG_DEFAULTS,
  getEnvFlagOverridesForScope,
  getFlagDefinition,
  storeKeyToFlagKey,
} from "@/lib/feature-flags/feature-flag-catalog";
import { toast } from "@vellumai/design-library/components/toast";

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
  stringFlags: Record<string, string>;
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
  setStringFlags: (flags: Record<string, string>) => void;
  setStringFlag: (key: string, value: string, assistantId: string | null) => void;
}

type AssistantFeatureFlagStore = Record<string, boolean> &
  AssistantFeatureFlagMeta &
  AssistantFeatureFlagActions;

let confirmedAssistantFlagValues: Record<string, boolean> = {
  ...ASSISTANT_FLAG_DEFAULTS,
};
let confirmedAssistantStringFlagValues: Record<string, string> = {
  ...ASSISTANT_STRING_FLAG_DEFAULTS,
};
let nextFlagRequestId = 0;
const pendingFlagRequestIds: Record<string, number> = {};

function resetConfirmedFlags(flags: Record<string, boolean> = {}) {
  confirmedAssistantFlagValues = { ...ASSISTANT_FLAG_DEFAULTS, ...flags };
  for (const key of Object.keys(pendingFlagRequestIds)) {
    delete pendingFlagRequestIds[key];
  }
}

function resetConfirmedStringFlags(flags: Record<string, string> = {}) {
  confirmedAssistantStringFlagValues = { ...ASSISTANT_STRING_FLAG_DEFAULTS, ...flags };
}

function resetAllConfirmed() {
  resetConfirmedFlags();
  resetConfirmedStringFlags();
}

const envOverrides = getEnvFlagOverridesForScope("assistant");

function latestConfirmedValue(key: string): boolean {
  return confirmedAssistantFlagValues[key] ?? ASSISTANT_FLAG_DEFAULTS[key] ?? false;
}

function latestConfirmedStringValue(key: string): string {
  return confirmedAssistantStringFlagValues[key] ?? ASSISTANT_STRING_FLAG_DEFAULTS[key] ?? "";
}

// The store type intersects Record<string, boolean> with meta/action
// interfaces. Zustand's set() expects Partial<Store>, but the index
// signature makes { stringFlags: Record<string, string> } incompatible.
// setStr() bypasses this for string-flag-only partials.
const useAssistantFeatureFlagStoreBase = create<AssistantFeatureFlagStore>()(
  (set) => {
    const setStr = set as unknown as (
      partial:
        | { stringFlags: Record<string, string> }
        | ((state: AssistantFeatureFlagStore) => { stringFlags: Record<string, string> } | AssistantFeatureFlagStore),
    ) => void;

    return ({
      ...ASSISTANT_FLAG_DEFAULTS,
      ...envOverrides.bool,
      hasHydrated: false,
      stringFlags: { ...ASSISTANT_STRING_FLAG_DEFAULTS, ...envOverrides.str },

      setFlags: (flags: Record<string, boolean>) =>
        set((prev) => {
          resetConfirmedFlags(flags);
          const merged = { ...flags, ...envOverrides.bool };
          const changed = Object.keys(merged).some(
            (k) => merged[k] !== prev[k],
          );
          return changed ? merged : prev;
        }),

      setFlag: (key: string, value: boolean, assistantId: string | null) => {
        const requestId = ++nextFlagRequestId;
        const revertIfLatestRejectedRequest = () => {
          if (pendingFlagRequestIds[key] !== requestId) {
            return;
          }
          delete pendingFlagRequestIds[key];
          const confirmedValue = latestConfirmedValue(key);
          set((prev) => {
            if (prev[key] !== value) {
              return prev;
            }
            return { [key]: confirmedValue };
          });
          toast.error(
            `Couldn't update "${getFlagDefinition(key)?.label ?? key}" — change reverted.`,
          );
        };
        const flagKey = storeKeyToFlagKey(key);
        // Assistant-scoped flags persist via the gateway. Without an assistant
        // id there is nowhere to write, so this is a true no-op: never apply an
        // optimistic value or fake a "confirmed" one the daemon will never
        // receive — that local-only write is what masked the silent failure.
        if (!assistantId || !flagKey) {
          return;
        }
        pendingFlagRequestIds[key] = requestId;
        void client
          .patch({
            url: `/v1/assistants/${assistantId}/feature-flags/${flagKey}`,
            body: { enabled: value },
            throwOnError: false,
          } as Parameters<typeof client.patch>[0])
          .then((result) => {
            const response = (result as { response?: Response }).response;
            if (response?.ok) {
              confirmedAssistantFlagValues[key] = value;
              if (pendingFlagRequestIds[key] === requestId) {
                delete pendingFlagRequestIds[key];
              }
            } else {
              revertIfLatestRejectedRequest();
            }
          })
          .catch(revertIfLatestRejectedRequest);

        set({ [key]: envOverrides.bool[key] ?? value });
      },

      markHydrated: () => set({ hasHydrated: true }),

      resetForAssistantSwitch: () => {
        resetAllConfirmed();
        set({ ...ASSISTANT_FLAG_DEFAULTS, ...envOverrides.bool, hasHydrated: false });
        setStr({ stringFlags: { ...ASSISTANT_STRING_FLAG_DEFAULTS, ...envOverrides.str } });
      },

      setStringFlags: (flags: Record<string, string>) =>
        setStr((prev) => {
          resetConfirmedStringFlags(flags);
          const merged = { ...flags, ...envOverrides.str };
          const prevStr = prev.stringFlags;
          const changed = Object.keys(merged).some(
            (k) => merged[k] !== prevStr[k],
          );
          return changed ? { stringFlags: merged } : prev;
        }),

      setStringFlag: (key: string, value: string, assistantId: string | null) => {
        const requestId = ++nextFlagRequestId;
        const revertIfLatestRejectedRequest = () => {
          if (pendingFlagRequestIds[key] !== requestId) {
            return;
          }
          delete pendingFlagRequestIds[key];
          const confirmedValue = latestConfirmedStringValue(key);
          setStr((prev) => {
            if (prev.stringFlags[key] !== value) {
              return prev;
            }
            return { stringFlags: { ...prev.stringFlags, [key]: confirmedValue } };
          });
          toast.error(
            `Couldn't update "${getFlagDefinition(key)?.label ?? key}" — change reverted.`,
          );
        };
        const flagKey = storeKeyToFlagKey(key);
        // See `setFlag`: a missing assistant id is a true no-op for
        // assistant-scoped flags rather than a local-only write.
        if (!assistantId || !flagKey) {
          return;
        }
        pendingFlagRequestIds[key] = requestId;
        void client
          .patch({
            url: `/v1/assistants/${assistantId}/feature-flags/${flagKey}`,
            body: { enabled: value },
            throwOnError: false,
          } as Parameters<typeof client.patch>[0])
          .then((result) => {
            const response = (result as { response?: Response }).response;
            if (response?.ok) {
              confirmedAssistantStringFlagValues[key] = value;
              if (pendingFlagRequestIds[key] === requestId) {
                delete pendingFlagRequestIds[key];
              }
            } else {
              revertIfLatestRejectedRequest();
            }
          })
          .catch(revertIfLatestRejectedRequest);

        setStr((prev) => ({
          stringFlags: { ...prev.stringFlags, [key]: envOverrides.str[key] ?? value },
        }));
      },
    }) as AssistantFeatureFlagStore;
  },
);

export const useAssistantFeatureFlagStore = createSelectors(
  useAssistantFeatureFlagStoreBase,
);
