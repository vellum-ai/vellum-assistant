import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import {
  CLIENT_FLAG_DEFAULTS,
  CLIENT_STRING_FLAG_DEFAULTS,
  getEnvFlagOverridesForScope,
} from "@/lib/feature-flags/feature-flag-catalog";

const LS_PREFIX = "vellum:ff:";
const LS_STRING_PREFIX = "vellum:ff-str:";

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

function readStringOverrides(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const overrides: Record<string, string> = {};
  try {
    for (const key of Object.keys(CLIENT_STRING_FLAG_DEFAULTS)) {
      const stored = localStorage.getItem(LS_STRING_PREFIX + key);
      if (stored !== null) {
        overrides[key] = stored;
      }
    }
  } catch {
    // localStorage unavailable
  }
  return overrides;
}

const localOverrides = readOverrides();
const localStringOverrides = readStringOverrides();
const envOverrides = getEnvFlagOverridesForScope("client");

interface ClientFeatureFlagMeta {
  stringFlags: Record<string, string>;
  /**
   * Flips `true` the first time the client flag query settles (success OR
   * terminal error), so the synchronous `buildNavigationState()` can tell
   * whether a server-synced arm has had a chance to land. Stays `false` until
   * then. See `use-client-feature-flag-sync.ts` for where it is set.
   */
  loaded: boolean;
}

interface ClientFeatureFlagActions {
  setFlags: (flags: Record<string, boolean>) => void;
  setFlag: (key: string, value: boolean) => void;
  clearOverride: (key: string) => void;
  setStringFlags: (flags: Record<string, string>) => void;
  setStringFlag: (key: string, value: string) => void;
  clearStringOverride: (key: string) => void;
  setLoaded: () => void;
}

type ClientFeatureFlagStore = Record<string, boolean> &
  ClientFeatureFlagMeta &
  ClientFeatureFlagActions;

// See assistant-feature-flag-store.ts for why setStr() is needed.
const useClientFeatureFlagStoreBase = create<ClientFeatureFlagStore>()(
  (set) => {
    const setStr = set as unknown as (
      partial:
        | { stringFlags: Record<string, string> }
        | ((state: ClientFeatureFlagStore) => { stringFlags: Record<string, string> } | ClientFeatureFlagStore),
    ) => void;

    return ({
      ...CLIENT_FLAG_DEFAULTS,
      ...localOverrides,
      ...envOverrides.bool,
      stringFlags: { ...CLIENT_STRING_FLAG_DEFAULTS, ...localStringOverrides, ...envOverrides.str },
      loaded: false,

      setFlags: (flags: Record<string, boolean>) =>
        set((prev) => {
          const overrides = readOverrides();
          const merged = { ...flags, ...overrides, ...envOverrides.bool };
          const changed = Object.keys(merged).some(
            (k) => merged[k] !== prev[k],
          );
          // Receiving server flags means the query has settled; mark loaded so
          // the synchronous nav-state read no longer treats the arm as unknown.
          if (!prev.loaded) {
            return { ...(changed ? merged : {}), loaded: true };
          }
          return changed ? merged : prev;
        }),

      setLoaded: () =>
        set((prev) => (prev.loaded ? prev : { loaded: true })),

      setFlag: (key: string, value: boolean) => {
        try {
          localStorage.setItem(LS_PREFIX + key, String(value));
        } catch {
          // localStorage unavailable
        }
        set({ [key]: envOverrides.bool[key] ?? value });
      },

      clearOverride: (key: string) => {
        try {
          localStorage.removeItem(LS_PREFIX + key);
        } catch {
          // localStorage unavailable
        }
        const defaultValue = envOverrides.bool[key] ?? CLIENT_FLAG_DEFAULTS[key];
        if (defaultValue !== undefined) {
          set({ [key]: defaultValue });
        }
      },

      setStringFlags: (flags: Record<string, string>) =>
        setStr((prev) => {
          const overrides = readStringOverrides();
          const merged = { ...flags, ...overrides, ...envOverrides.str };
          const prevStr = prev.stringFlags;
          const changed = Object.keys(merged).some(
            (k) => merged[k] !== prevStr[k],
          );
          return changed ? { stringFlags: merged } : prev;
        }),

      setStringFlag: (key: string, value: string) => {
        try {
          localStorage.setItem(LS_STRING_PREFIX + key, value);
        } catch {
          // localStorage unavailable
        }
        setStr((prev) => ({
          stringFlags: { ...prev.stringFlags, [key]: envOverrides.str[key] ?? value },
        }));
      },

      clearStringOverride: (key: string) => {
        try {
          localStorage.removeItem(LS_STRING_PREFIX + key);
        } catch {
          // localStorage unavailable
        }
        const defaultValue = envOverrides.str[key] ?? CLIENT_STRING_FLAG_DEFAULTS[key];
        setStr((prev) => ({
          stringFlags: {
            ...prev.stringFlags,
            [key]: defaultValue ?? "",
          },
        }));
      },
    }) as ClientFeatureFlagStore;
  },
);

export const useClientFeatureFlagStore = createSelectors(
  useClientFeatureFlagStoreBase,
);
