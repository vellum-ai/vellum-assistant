/**
 * IPC route definitions for feature flags.
 *
 * Exports a list of `IpcRoute` objects that the gateway IPC server
 * registers at startup. These return the same merged flag state that
 * the HTTP GET /v1/feature-flags endpoint returns.
 */

import { z } from "zod";

import { loadFeatureFlagDefaults } from "../feature-flag-defaults.js";
import { readEnvFeatureFlagOverrides } from "../feature-flag-env-overrides.js";
import { readRemoteFeatureFlags } from "../feature-flag-remote-store.js";
import { readPersistedFeatureFlags } from "../feature-flag-store.js";
import type { IpcRoute } from "./server.js";

const GetFeatureFlagParamsSchema = z.object({
  flag: z.string(),
});

/**
 * Compute the merged feature flag state: defaults < remote < persisted.
 * Returns a `Record<string, boolean | string>` keyed by flag name.
 */
export function getMergedFeatureFlags(): Record<string, boolean | string> {
  const defaults = loadFeatureFlagDefaults();
  const persisted = readPersistedFeatureFlags();
  const remote = readRemoteFeatureFlags();

  const result: Record<string, boolean | string> = {};
  for (const [key, def] of Object.entries(defaults)) {
    const persistedValue = persisted[key];
    const remoteValue = remote[key];
    result[key] =
      persistedValue !== undefined
        ? persistedValue
        : remoteValue !== undefined
          ? remoteValue
          : def.defaultEnabled;
  }

  const envOverrides = readEnvFeatureFlagOverrides();
  for (const [key, value] of Object.entries(envOverrides)) {
    if (key in result) result[key] = value;
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
    handler: (params?: Record<string, unknown>): boolean | string | null => {
      const flag = params?.flag as string | undefined;
      if (!flag) return null;

      const flags = getMergedFeatureFlags();
      return Object.hasOwn(flags, flag) ? flags[flag] : null;
    },
  },
];
