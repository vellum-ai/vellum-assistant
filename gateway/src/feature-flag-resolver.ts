import { loadFeatureFlagDefaults } from "./feature-flag-defaults.js";
import { readEnvFeatureFlagOverrides } from "./feature-flag-env-overrides.js";
import { readRemoteFeatureFlags } from "./feature-flag-remote-store.js";
import {
  normalizeStaleRemoteFlagValue,
  resolveAbsentFlagDefault,
} from "./feature-flag-staged-rollout.js";
import { readPersistedFeatureFlags } from "./feature-flag-store.js";

/**
 * Resolve the raw value for a feature flag.
 *
 * Priority: env override > persisted (user-toggled) > remote (platform-pushed) > registry default.
 * Undeclared keys return `false` (fail closed), even if stale local/remote
 * state contains a value for them. The remote-layer value is passed through
 * {@link normalizeStaleRemoteFlagValue} (so a stale staged-rollout `false`
 * cached off-platform does not beat the registry default), and when no explicit
 * value is present the registry default is resolved through
 * {@link resolveAbsentFlagDefault} so staged-rollout flags fail safe to `false`
 * on managed deployments.
 */
export function getFeatureFlagValue(key: string): boolean | string {
  const defaults = loadFeatureFlagDefaults();
  const defaultDef = defaults[key];
  if (defaultDef === undefined) return false;

  const envOverrides = readEnvFeatureFlagOverrides();
  if (key in envOverrides) return envOverrides[key];

  const persisted = readPersistedFeatureFlags();
  const persistedValue = persisted[key];
  if (persistedValue !== undefined) return persistedValue;

  const remote = readRemoteFeatureFlags();
  const remoteValue = remote[key];
  if (remoteValue !== undefined)
    return normalizeStaleRemoteFlagValue(key, remoteValue);

  return resolveAbsentFlagDefault(key, defaultDef.defaultEnabled);
}

/**
 * Resolve whether a feature flag is enabled (boolean coercion).
 *
 * For boolean flags, returns the resolved value directly.
 * For string flags, returns true if the value is non-empty.
 * Undeclared keys return `false` (fail closed).
 */
export function isFeatureFlagEnabled(key: string): boolean {
  return !!getFeatureFlagValue(key);
}

function isPlatformMode(): boolean {
  const v = process.env.IS_PLATFORM?.trim().toLowerCase();
  return v === "true" || v === "1";
}

export function arePlatformFeaturesEnabled(): boolean {
  if (isPlatformMode()) return true;
  const v = process.env.VELLUM_DISABLE_PLATFORM?.trim().toLowerCase();
  return !(v === "true" || v === "1");
}
