import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";
import { CLIENT_FLAG_DEFAULTS } from "@/lib/feature-flags/feature-flag-catalog.js";

const LS_PREFIX = "ff:client:";

function readOverrides(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  const overrides: Record<string, boolean> = {};
  try {
    for (const key of Object.keys(CLIENT_FLAG_DEFAULTS)) {
      const stored = localStorage.getItem(LS_PREFIX + key);
      if (stored !== null) {
        overrides[key] = stored === "true";
      }
    }
  } catch {
    // localStorage unavailable
  }
  return overrides;
}

const localOverrides = readOverrides();

interface ClientFeatureFlagActions {
  setFlags: (flags: Record<string, boolean>) => void;
  setFlag: (key: string, value: boolean) => void;
  clearOverride: (key: string) => void;
}

type ClientFeatureFlagStore = Record<string, boolean> &
  ClientFeatureFlagActions;

const useClientFeatureFlagStoreBase = create<ClientFeatureFlagStore>()(
  (set) =>
    ({
      ...CLIENT_FLAG_DEFAULTS,
      ...localOverrides,

      setFlags: (flags: Record<string, boolean>) =>
        set((prev) => {
          const overrides = readOverrides();
          const merged = { ...flags, ...overrides };
          const changed = Object.keys(merged).some(
            (k) => merged[k] !== prev[k],
          );
          return changed ? merged : prev;
        }),

      setFlag: (key: string, value: boolean) => {
        try {
          localStorage.setItem(LS_PREFIX + key, String(value));
        } catch {
          // localStorage unavailable
        }
        set({ [key]: value });
      },

      clearOverride: (key: string) => {
        try {
          localStorage.removeItem(LS_PREFIX + key);
        } catch {
          // localStorage unavailable
        }
        const defaultValue = CLIENT_FLAG_DEFAULTS[key];
        if (defaultValue !== undefined) {
          set({ [key]: defaultValue });
        }
      },
    }) as ClientFeatureFlagStore,
);

export const useClientFeatureFlagStore = createSelectors(
  useClientFeatureFlagStoreBase,
);
