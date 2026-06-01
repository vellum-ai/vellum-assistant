import { loadFeatureFlagDefaults } from "./feature-flag-defaults.js";
import { readRemoteFeatureFlags } from "./feature-flag-remote-store.js";
import { readPersistedFeatureFlags } from "./feature-flag-store.js";

/**
 * Resolve the effective enabled/disabled state for a feature flag.
 *
 * Priority: persisted (user-toggled) > remote (platform-pushed) > registry default.
 * Undeclared keys return `false` (fail closed), even if stale local/remote
 * state contains a value for them.
 */
export function isFeatureFlagEnabled(key: string): boolean {
  const defaults = loadFeatureFlagDefaults();
  const defaultDef = defaults[key];
  if (defaultDef === undefined) return false;

  const persisted = readPersistedFeatureFlags();
  const persistedValue = persisted[key];
  if (persistedValue !== undefined) return persistedValue;

  const remote = readRemoteFeatureFlags();
  const remoteValue = remote[key];
  if (remoteValue !== undefined) return remoteValue;

  return defaultDef.defaultEnabled;
}

function isPlatformMode(): boolean {
  const v = process.env.IS_PLATFORM?.trim().toLowerCase();
  return v === "true" || v === "1";
}

export function arePlatformFeaturesEnabled(): boolean {
  if (isPlatformMode()) return true;
  return isFeatureFlagEnabled("platform-features-in-local-mode");
}
