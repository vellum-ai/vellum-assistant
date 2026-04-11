/**
 * IPC route definitions for feature flags.
 *
 * Exports a list of `IpcRoute` objects that the gateway IPC server
 * registers at startup. These return the same merged flag state that
 * the HTTP GET /v1/feature-flags endpoint returns.
 */

import { loadFeatureFlagDefaults } from "../feature-flag-defaults.js";
import { readRemoteFeatureFlags } from "../feature-flag-remote-store.js";
import { readPersistedFeatureFlags } from "../feature-flag-store.js";
import type { IpcRoute } from "./server.js";

/**
 * Compute the merged feature flag state: defaults < remote < persisted.
 * Returns a `Record<string, boolean>` keyed by flag name.
 */
export function getMergedFeatureFlags(): Record<string, boolean> {
  const defaults = loadFeatureFlagDefaults();
  const persisted = readPersistedFeatureFlags();
  const remote = readRemoteFeatureFlags();

  const result: Record<string, boolean> = {};
  for (const [key, def] of Object.entries(defaults)) {
    const persistedValue = persisted[key];
    result[key] =
      persistedValue !== undefined
        ? persistedValue
        : remote[key] !== undefined
          ? remote[key]
          : def.defaultEnabled;
  }
  return result;
}

/**
 * IPC routes for feature flag queries.
 */
export const featureFlagRoutes: IpcRoute[] = [
  {
    method: "getFeatureFlags",
    handler: () => getMergedFeatureFlags(),
  },
  {
    method: "getFeatureFlag",
    handler: (params?: Record<string, unknown>): boolean | null => {
      const flag = params?.flag;
      if (typeof flag !== "string") return null;

      const flags = getMergedFeatureFlags();
      return flag in flags ? flags[flag] : null;
    },
  },
];
