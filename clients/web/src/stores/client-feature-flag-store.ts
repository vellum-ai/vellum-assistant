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
  if (typeof window === "undefined") {
    return {};
  }
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
  if (typeof window === "undefined") {
    return {};
  }
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

/**
 * The values to hold when no server response stands behind them: registry
 * defaults, with local and env overrides layered back on top. Overrides are
 * the developer's answer for every identity and every fetch outcome, so they
 * survive both a scope change and a settle.
 */
function flagsWithoutServerValues(): Record<string, boolean> {
  return { ...CLIENT_FLAG_DEFAULTS, ...readOverrides(), ...envOverrides.bool };
}

function stringFlagsWithoutServerValues(): Record<string, string> {
  return {
    ...CLIENT_STRING_FLAG_DEFAULTS,
    ...readStringOverrides(),
    ...envOverrides.str,
  };
}

interface ClientFeatureFlagMeta {
  stringFlags: Record<string, string>;
  /**
   * Whether the values in hand are a real answer for {@link scopeKey} — set by
   * `setFlags` when this scope's server response lands, or by
   * `settleWithoutServerValues` when none is coming, and cleared by
   * `beginScope` when the identity moves. Routes that redirect on a default-off
   * flag must wait for this before bouncing — otherwise a cold load races the
   * async LD fetch and redirects away before the real value (possibly `true`)
   * arrives. Stays meaningful regardless of local/env overrides, which are
   * applied synchronously at store init and win over the server value anyway.
   */
  hydrated: boolean;
  /**
   * The identity the current server values were evaluated against — the
   * `requestScopeKey` of the session and organization the request carried — or
   * `null` before any scope has been claimed. Flags are evaluated per (user,
   * org), so a value is only an answer for the scope it was fetched in.
   */
  scopeKey: string | null;
}

interface ClientFeatureFlagActions {
  setFlags: (flags: Record<string, boolean>, scopeKey: string | null) => void;
  beginScope: (scopeKey: string) => void;
  settleWithoutServerValues: (scopeKey: string | null) => void;
  setFlag: (key: string, value: boolean) => void;
  clearOverride: (key: string) => void;
  setStringFlags: (
    flags: Record<string, string>,
    scopeKey: string | null,
  ) => void;
  setStringFlag: (key: string, value: string) => void;
  clearStringOverride: (key: string) => void;
}

/**
 * Whether values produced for `scopeKey` still answer the identity the store
 * has claimed.
 *
 * Flags are evaluated per (user, org), so a response — or a decision that none
 * is coming — is only an answer for the scope it was produced under. The two
 * can drift apart because `beginScope` runs synchronously from a store
 * subscription while the values are applied from a passive effect that closed
 * over an earlier render: the claim lands first, and the write that follows
 * carries the previous identity's answer. Enforcing the match here rather than
 * at the call site keeps "values may only hydrate the scope they were produced
 * for" a property of the store.
 *
 * A `null` on either side is an unclaimed store or an unscoped write, which
 * nothing contradicts.
 */
function answersScope(
  claimed: string | null,
  scopeKey: string | null,
): boolean {
  return claimed === null || scopeKey === null || claimed === scopeKey;
}

type ClientFeatureFlagStore = Record<string, boolean> &
  ClientFeatureFlagMeta &
  ClientFeatureFlagActions;

/**
 * A partial the store accepts but `Partial<ClientFeatureFlagStore>` rejects:
 * the `Record<string, boolean>` index signature makes every non-boolean meta
 * field (`stringFlags`, `scopeKey`) incompatible. See
 * assistant-feature-flag-store.ts for the same workaround.
 */
type ClientFeatureFlagPartial = Partial<ClientFeatureFlagMeta> & {
  [key: string]: boolean | string | null | Record<string, string> | undefined;
};

const useClientFeatureFlagStoreBase = create<ClientFeatureFlagStore>()((
  set,
) => {
  const setMeta = set as unknown as (
    partial:
      | ClientFeatureFlagPartial
      | ((
          state: ClientFeatureFlagStore,
        ) => ClientFeatureFlagPartial | ClientFeatureFlagStore),
  ) => void;

  return {
    ...CLIENT_FLAG_DEFAULTS,
    ...localOverrides,
    ...envOverrides.bool,
    stringFlags: {
      ...CLIENT_STRING_FLAG_DEFAULTS,
      ...localStringOverrides,
      ...envOverrides.str,
    },
    hydrated: false,
    scopeKey: null,

    setFlags: (flags: Record<string, boolean>, scopeKey: string | null) =>
      set((prev) => {
        if (!answersScope(prev.scopeKey, scopeKey)) {
          return prev;
        }
        const overrides = readOverrides();
        const merged = { ...flags, ...overrides, ...envOverrides.bool };
        const changed = Object.keys(merged).some((k) => merged[k] !== prev[k]);
        // Always flip `hydrated` on the first server response, even when the
        // merged values match the current defaults (nothing "changed"), so
        // redirect-on-flag routes know the real value has landed.
        if (!changed) {
          return prev.hydrated ? prev : { hydrated: true };
        }
        return { ...merged, hydrated: true };
      }),

    /**
     * Claim `scopeKey` as the identity the next server values belong to.
     *
     * A different identity means the values in hand answer a question nobody
     * asked: an anonymous evaluation says nothing about the signed-in one, in
     * either direction. So a scope change drops the previous identity's
     * server values and re-opens the pre-hydration window, leaving surfaces
     * that gate on `hydrated` waiting for the new identity's response rather
     * than acting on the old one's.
     */
    beginScope: (scopeKey: string) =>
      setMeta((prev) => {
        if (prev.scopeKey === scopeKey) {
          return prev;
        }
        return {
          ...flagsWithoutServerValues(),
          stringFlags: stringFlagsWithoutServerValues(),
          hydrated: false,
          scopeKey,
        };
      }),

    /**
     * Settle hydration when no server values are coming. Two situations
     * reach here and they want different answers:
     *
     * - Nothing has landed for this scope — the fetch is off for this mode,
     *   or the first attempt failed. Registry defaults are the honest answer,
     *   and settling stops surfaces that wait on `hydrated` from hanging.
     * - A refresh failed after an earlier success in the same scope. The last
     *   values the server gave for this identity remain the best answer;
     *   falling back to defaults would switch a legitimately-enabled feature
     *   off mid-session over one failed request. Hydration is already
     *   settled, so nothing needs to change.
     */
    settleWithoutServerValues: (scopeKey: string | null) =>
      set((prev) => {
        if (prev.hydrated || !answersScope(prev.scopeKey, scopeKey)) {
          return prev;
        }
        return { ...flagsWithoutServerValues(), hydrated: true };
      }),

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

    setStringFlags: (flags: Record<string, string>, scopeKey: string | null) =>
      setMeta((prev) => {
        if (!answersScope(prev.scopeKey, scopeKey)) {
          return prev;
        }
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
      setMeta((prev) => ({
        stringFlags: {
          ...prev.stringFlags,
          [key]: envOverrides.str[key] ?? value,
        },
      }));
    },

    clearStringOverride: (key: string) => {
      try {
        localStorage.removeItem(LS_STRING_PREFIX + key);
      } catch {
        // localStorage unavailable
      }
      const defaultValue =
        envOverrides.str[key] ?? CLIENT_STRING_FLAG_DEFAULTS[key];
      setMeta((prev) => ({
        stringFlags: {
          ...prev.stringFlags,
          [key]: defaultValue ?? "",
        },
      }));
    },
  } as ClientFeatureFlagStore;
});

export const useClientFeatureFlagStore = createSelectors(
  useClientFeatureFlagStoreBase,
);
