import { loadFeatureFlagDefaults } from "./feature-flag-defaults.js";
import {
  hasRemoteFeatureFlagSnapshot,
  readRemoteFeatureFlags,
} from "./feature-flag-remote-store.js";
import { readPersistedFeatureFlags } from "./feature-flag-store.js";

/**
 * Resolve the effective enabled/disabled state for a feature flag.
 *
 * Priority: persisted (user-toggled) > remote (platform-pushed) > registry default.
 * Undeclared keys with no override return `false` (fail closed).
 */
export function isFeatureFlagEnabled(key: string): boolean {
  const persisted = readPersistedFeatureFlags();
  const persistedValue = persisted[key];
  if (persistedValue !== undefined) return persistedValue;

  if (hasRemoteFeatureFlagSnapshot()) {
    const remote = readRemoteFeatureFlags();
    return remote[key] ?? false;
  }

  const defaults = loadFeatureFlagDefaults();
  return defaults[key]?.defaultEnabled ?? false;
}

function isPlatformMode(): boolean {
  const v = process.env.IS_PLATFORM?.trim().toLowerCase();
  return v === "true" || v === "1";
}

export function arePlatformFeaturesEnabled(): boolean {
  if (isPlatformMode()) return true;
  return isFeatureFlagEnabled("platform-features-in-local-mode");
}
