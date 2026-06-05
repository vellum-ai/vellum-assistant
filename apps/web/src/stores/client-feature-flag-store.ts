import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import {
  CLIENT_FLAG_DEFAULTS,
  CLIENT_STRING_FLAG_DEFAULTS,
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

interface ClientFeatureFlagMeta {
  stringFlags: Record<string, string>;
}

interface ClientFeatureFlagActions {
  setFlags: (flags: Record<string, boolean>) => void;
  setFlag: (key: string, value: boolean) => void;
  clearOverride: (key: string) => void;
  setStringFlags: (flags: Record<string, string>) => void;
  setStringFlag: (key: string, value: string) => void;
  clearStringOverride: (key: string) => void;
}

type ClientFeatureFlagStore = Record<string, boolean> &
  ClientFeatureFlagMeta &
  ClientFeatureFlagActions;

const useClientFeatureFlagStoreBase = create<ClientFeatureFlagStore>()(
  (set) =>
    ({
      ...CLIENT_FLAG_DEFAULTS,
      ...localOverrides,
      stringFlags: { ...CLIENT_STRING_FLAG_DEFAULTS, ...localStringOverrides },

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

      setStringFlags: (flags: Record<string, string>) =>
        set((prev) => {
          const overrides = readStringOverrides();
          const merged = { ...flags, ...overrides };
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
        set((prev) => ({
          stringFlags: { ...prev.stringFlags, [key]: value },
        }));
      },

      clearStringOverride: (key: string) => {
        try {
          localStorage.removeItem(LS_STRING_PREFIX + key);
        } catch {
          // localStorage unavailable
        }
        const defaultValue = CLIENT_STRING_FLAG_DEFAULTS[key];
        set((prev) => ({
          stringFlags: {
            ...prev.stringFlags,
            [key]: defaultValue ?? "",
          },
        }));
      },
    }) as ClientFeatureFlagStore,
);

export const useClientFeatureFlagStore = createSelectors(
  useClientFeatureFlagStoreBase,
);
