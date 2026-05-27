/**
 * IPC route definitions for feature flags.
 *
 * Exports a list of `IpcRoute` objects that the gateway IPC server
 * registers at startup. These return the same merged flag state that
 * the HTTP GET /v1/feature-flags endpoint returns.
 */

import { z } from "zod";

import { loadFeatureFlagDefaults } from "../feature-flag-defaults.js";
import {
  hasRemoteFeatureFlagSnapshot,
  readRemoteFeatureFlags,
} from "../feature-flag-remote-store.js";
import { readPersistedFeatureFlags } from "../feature-flag-store.js";
import type { IpcRoute } from "./server.js";

const GetFeatureFlagParamsSchema = z.object({
  flag: z.string(),
});

/**
 * Compute the merged feature flag state: defaults < remote < persisted.
 * Once a remote snapshot exists, declared flags missing from it fail closed.
 * Returns a `Record<string, boolean>` keyed by flag name.
 */
export function getMergedFeatureFlags(): Record<string, boolean> {
  const defaults = loadFeatureFlagDefaults();
  const persisted = readPersistedFeatureFlags();
  const remote = readRemoteFeatureFlags();
  const hasRemoteSnapshot = hasRemoteFeatureFlagSnapshot();

  const result: Record<string, boolean> = {};
  for (const [key, def] of Object.entries(defaults)) {
    const persistedValue = persisted[key];
    result[key] =
      persistedValue !== undefined
        ? persistedValue
        : hasRemoteSnapshot
          ? (remote[key] ?? false)
          : def.defaultEnabled;
  }
  return result;
}

/**
 * IPC routes for feature flag queries.
 */
export const featureFlagRoutes: IpcRoute[] = [
  {
    method: "get_feature_flags",
    handler: () => getMergedFeatureFlags(),
  },
  {
    method: "get_feature_flag",
    schema: GetFeatureFlagParamsSchema,
    handler: (params?: Record<string, unknown>): boolean | null => {
      const flag = params?.flag as string | undefined;
      if (!flag) return null;

      const flags = getMergedFeatureFlags();
      return Object.hasOwn(flags, flag) ? flags[flag] : null;
    },
  },
];
