/**
 * Canonical assistant feature-flag resolver.
 *
 * Loads default flag values from the unified registry at
 * `meta/feature-flags/feature-flag-registry.json` and resolves the effective
 * enabled/disabled state for each declared assistant-scope flag by consulting
 * (in priority order):
 *   1. `config.assistantFeatureFlagValues[key]`  (explicit override)
 *   2. defaults registry `defaultEnabled`         (for declared keys)
 *   3. `true`                                     (for undeclared keys)
 *
 * Key format:
 *   Canonical:  `feature_flags.<id>.enabled`
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AssistantConfig } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeatureFlagDefault {
  defaultEnabled: boolean;
  description: string;
  label: string;
}

export type FeatureFlagDefaultsRegistry = Record<string, FeatureFlagDefault>;

// ---------------------------------------------------------------------------
// Registry loading (singleton, loaded once)
// ---------------------------------------------------------------------------

let cachedDefaults: FeatureFlagDefaultsRegistry | undefined;

const REGISTRY_FILENAME = "feature-flag-registry.json";

function loadDefaultsRegistry(): FeatureFlagDefaultsRegistry {
  if (cachedDefaults) return cachedDefaults;

  const thisDir = import.meta.dirname ?? __dirname;
  const envPath = process.env.FEATURE_FLAG_DEFAULTS_PATH?.trim();
  const candidates = [
    // Explicit override (primarily for tests / controlled environments)
    ...(envPath ? [envPath] : []),
    // Bundled: co-located copy in the same directory as this source file.
    // Works in Docker / packaged builds where the repo-root `meta/` dir
    // is not available.
    join(thisDir, REGISTRY_FILENAME),
    // Packaged macOS app layout: the daemon binary lives at
    // <App>.app/Contents/MacOS/vellum-daemon and the registry is copied
    // to <App>.app/Contents/Resources/ by build.sh. In bun --compile
    // binaries, import.meta.dirname resolves to /$bunfs/root (virtual),
    // so we need to resolve relative to the real executable path.
    join(dirname(process.execPath), "..", "Resources", REGISTRY_FILENAME),
    // Development: relative to this source file's directory, walking up
    // to the repo root to reach `meta/feature-flags/`.
    join(thisDir, "..", "..", "..", "meta", "feature-flags", REGISTRY_FILENAME),
    // Alternate: from repo root via cwd
    join(process.cwd(), "meta", "feature-flags", REGISTRY_FILENAME),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const raw = readFileSync(candidate, "utf-8");
        const parsed = JSON.parse(raw);
        cachedDefaults = parseRegistryToDefaults(parsed);
        return cachedDefaults;
      } catch {
        // Malformed file — fall through to next candidate
      }
    }
  }

  cachedDefaults = {};
  return cachedDefaults;
}

/**
 * Parse the unified registry JSON into a flat key -> default map,
 * filtering to assistant-scope flags only.
 */
function parseRegistryToDefaults(parsed: unknown): FeatureFlagDefaultsRegistry {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const registry = parsed as { version?: number; flags?: unknown[] };
  if (!Array.isArray(registry.flags)) return {};

  const result: FeatureFlagDefaultsRegistry = {};
  for (const flag of registry.flags) {
    if (!flag || typeof flag !== "object" || Array.isArray(flag)) continue;
    const entry = flag as Record<string, unknown>;
    if (entry.scope !== "assistant") continue;
    if (typeof entry.key !== "string") continue;
    if (typeof entry.defaultEnabled !== "boolean") continue;

    result[entry.key as string] = {
      defaultEnabled: entry.defaultEnabled,
      description:
        typeof entry.description === "string" ? entry.description : "",
      label: typeof entry.label === "string" ? entry.label : "",
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve whether an assistant feature flag is enabled.
 *
 * Resolution order:
 *   1. `config.assistantFeatureFlagValues[key]`  (explicit override)
 *   2. defaults registry `defaultEnabled`         (for declared assistant-scope keys)
 *   3. `true`                                     (for undeclared keys with no override)
 */
export function isAssistantFeatureFlagEnabled(
  key: string,
  config: AssistantConfig,
): boolean {
  const defaults = loadDefaultsRegistry();
  const declared = defaults[key];

  // 1. Check config overrides
  const explicit = config.assistantFeatureFlagValues?.[key];
  if (typeof explicit === "boolean") return explicit;

  // 2. For declared keys, use the registry default
  if (declared) {
    return declared.defaultEnabled;
  }

  // 3. Undeclared keys with no persisted override default to enabled
  return true;
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
