/**
 * Canonical assistant feature-flag resolver.
 *
 * Loads default flag values from the registry at
 * `meta/assistant-feature-flags/assistant-feature-flag-defaults.json`
 * and resolves the effective enabled/disabled state for each flag by
 * consulting (in priority order):
 *   1. `config.assistantFeatureFlagValues[key]`  (new canonical section)
 *   2. `config.featureFlags[legacyKey]`           (legacy backward-compat)
 *   3. defaults registry `defaultEnabled`
 *
 * Key format:
 *   Canonical:  `feature_flags.<id>.enabled`
 *   Legacy:     `skills.<id>.enabled`
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AssistantConfig } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeatureFlagDefault {
  defaultEnabled: boolean;
  description: string;
}

export type FeatureFlagDefaultsRegistry = Record<string, FeatureFlagDefault>;

// ---------------------------------------------------------------------------
// Registry loading (singleton, loaded once)
// ---------------------------------------------------------------------------

let cachedDefaults: FeatureFlagDefaultsRegistry | undefined;

function loadDefaultsRegistry(): FeatureFlagDefaultsRegistry {
  if (cachedDefaults) return cachedDefaults;

  const thisDir = import.meta.dirname ?? __dirname;
  const candidates = [
    // Bundled: co-located copy in the same directory as this source file.
    // Works in Docker / packaged builds where the repo-root `meta/` dir
    // is not available.
    join(thisDir, 'assistant-feature-flag-defaults.json'),
    // Development: relative to this source file's directory, walking up
    // to the repo root to reach `meta/`.
    join(thisDir, '..', '..', '..', 'meta', 'assistant-feature-flags', 'assistant-feature-flag-defaults.json'),
    // Alternate: from repo root via cwd
    join(process.cwd(), 'meta', 'assistant-feature-flags', 'assistant-feature-flag-defaults.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const raw = readFileSync(candidate, 'utf-8');
        cachedDefaults = JSON.parse(raw) as FeatureFlagDefaultsRegistry;
        return cachedDefaults;
      } catch {
        // Malformed file — fall through to empty registry
      }
    }
  }

  cachedDefaults = {};
  return cachedDefaults;
}

// ---------------------------------------------------------------------------
// Key mapping helpers
// ---------------------------------------------------------------------------

/**
 * Convert a canonical key (`feature_flags.<id>.enabled`) to the legacy
 * key format (`skills.<id>.enabled`).
 */
function canonicalToLegacyKey(canonicalKey: string): string | undefined {
  const match = canonicalKey.match(/^feature_flags\.(.+)\.enabled$/);
  if (!match) return undefined;
  return `skills.${match[1]}.enabled`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve whether an assistant feature flag is enabled.
 *
 * Resolution order:
 *   1. `config.assistantFeatureFlagValues[key]`  (explicit new-format override)
 *   2. `config.featureFlags[legacyKey]`           (legacy backward-compat)
 *   3. defaults registry `defaultEnabled`
 *   4. `true` (if the flag is unknown — open by default)
 */
export function isAssistantFeatureFlagEnabled(key: string, config: AssistantConfig): boolean {
  // 1. Check new canonical section
  const newValues = (config as AssistantConfigWithFeatureFlags).assistantFeatureFlagValues;
  if (newValues) {
    const explicit = newValues[key];
    if (typeof explicit === 'boolean') return explicit;
  }

  // 2. Check legacy featureFlags section (map canonical key -> legacy key)
  const legacyKey = canonicalToLegacyKey(key);
  if (legacyKey) {
    const flags = config.featureFlags;
    if (flags) {
      const legacyValue = flags[legacyKey];
      if (typeof legacyValue === 'boolean') return legacyValue;
    }
  }

  // 3. Check defaults registry
  const defaults = loadDefaultsRegistry();
  const entry = defaults[key];
  if (entry) return entry.defaultEnabled;

  // 4. Unknown flag — default to enabled
  return true;
}

/**
 * Convenience: check whether a skill is enabled by its skill ID.
 *
 * Translates the skill ID to the canonical key format
 * `feature_flags.<skillId>.enabled` and delegates to the full resolver.
 */
export function isAssistantSkillEnabled(skillId: string, config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(`feature_flags.${skillId}.enabled`, config);
}

/**
 * Return the loaded defaults registry (for introspection/tooling).
 */
export function getAssistantFeatureFlagDefaults(): FeatureFlagDefaultsRegistry {
  return loadDefaultsRegistry();
}

/**
 * Reset the cached defaults registry. Intended for tests only.
 */
export function _resetDefaultsCache(): void {
  cachedDefaults = undefined;
}

// ---------------------------------------------------------------------------
// Internal type augmentation for the new config field
// ---------------------------------------------------------------------------

interface AssistantConfigWithFeatureFlags extends AssistantConfig {
  assistantFeatureFlagValues?: Record<string, boolean>;
}
