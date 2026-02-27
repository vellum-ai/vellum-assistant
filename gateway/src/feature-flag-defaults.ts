import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "./logger.js";

const log = getLogger("feature-flag-defaults");

export type FeatureFlagDefault = {
  defaultEnabled: boolean;
  description: string;
};

export type FeatureFlagDefaultsRegistry = Record<string, FeatureFlagDefault>;

let cachedRegistry: FeatureFlagDefaultsRegistry | null = null;

/**
 * Resolve the path to the defaults registry JSON file.
 *
 * The file lives at `meta/assistant-feature-flags/assistant-feature-flag-defaults.json`
 * relative to the repository root. We derive the repo root from the gateway
 * source directory (gateway/src/) by walking up two levels.
 */
function getRegistryPath(): string {
  // __dirname equivalent for ESM: import.meta.dirname (Bun) or derive from import.meta.url
  const srcDir = import.meta.dirname ?? new URL(".", import.meta.url).pathname;
  // srcDir = <repo>/gateway/src  -> repo root = srcDir/../../
  const repoRoot = join(srcDir, "..", "..");
  return join(repoRoot, "meta", "assistant-feature-flags", "assistant-feature-flag-defaults.json");
}

/**
 * Load and validate the feature flag defaults registry.
 *
 * The registry is loaded once and cached for the lifetime of the process.
 * Invalid entries (missing required fields, wrong types) are skipped with a
 * warning rather than crashing the gateway.
 */
export function loadFeatureFlagDefaults(): FeatureFlagDefaultsRegistry {
  if (cachedRegistry) return cachedRegistry;

  const registryPath = getRegistryPath();
  let raw: string;
  try {
    raw = readFileSync(registryPath, "utf-8");
  } catch (err) {
    log.error({ err, path: registryPath }, "Failed to read feature flag defaults registry");
    cachedRegistry = {};
    return cachedRegistry;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error({ err, path: registryPath }, "Feature flag defaults registry is not valid JSON");
    cachedRegistry = {};
    return cachedRegistry;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.error({ path: registryPath }, "Feature flag defaults registry must be a JSON object");
    cachedRegistry = {};
    return cachedRegistry;
  }

  const registry: FeatureFlagDefaultsRegistry = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      log.warn({ key }, "Skipping invalid defaults registry entry (not an object)");
      continue;
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.defaultEnabled !== "boolean") {
      log.warn({ key }, "Skipping invalid defaults registry entry (defaultEnabled is not boolean)");
      continue;
    }
    if (typeof entry.description !== "string") {
      log.warn({ key }, "Skipping invalid defaults registry entry (description is not string)");
      continue;
    }
    registry[key] = {
      defaultEnabled: entry.defaultEnabled,
      description: entry.description,
    };
  }

  log.info({ flagCount: Object.keys(registry).length }, "Loaded feature flag defaults registry");
  cachedRegistry = registry;
  return cachedRegistry;
}

/**
 * Check whether a given flag key is declared in the defaults registry.
 */
export function isFlagDeclared(flagKey: string): boolean {
  const registry = loadFeatureFlagDefaults();
  return flagKey in registry;
}

/** Reset the cached registry (for testing). */
export function resetFeatureFlagDefaultsCache(): void {
  cachedRegistry = null;
}
