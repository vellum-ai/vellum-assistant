import { getLogger } from "./logger.js";
import { isFlagDeclared } from "./feature-flag-defaults.js";

const log = getLogger("feature-flag-env-overrides");

const ENV_PREFIX = "VELLUM_FLAG_";

const TRUTHY = new Set(["true", "1", "yes", "on"]);
const FALSY = new Set(["false", "0", "no", "off"]);

let cache: Record<string, boolean | string> | null = null;

function envKeyToFlagKey(envKey: string): string {
  return envKey.slice(ENV_PREFIX.length).toLowerCase().replace(/_/g, "-");
}

function parseValue(raw: string): boolean | string {
  const lower = raw.toLowerCase();
  if (TRUTHY.has(lower)) return true;
  if (FALSY.has(lower)) return false;
  return raw;
}

/**
 * Scan `process.env` for keys starting with `VELLUM_FLAG_`, convert each to a
 * kebab-case flag key, parse the value, and validate against the registry.
 *
 * The result is cached for the process lifetime. Unknown keys (not declared in
 * the registry) are logged at warn level and discarded.
 */
export function readEnvFeatureFlagOverrides(): Record<string, boolean | string> {
  if (cache !== null) return cache;

  const result: Record<string, boolean | string> = {};

  for (const envKey of Object.keys(process.env)) {
    if (!envKey.startsWith(ENV_PREFIX)) continue;

    const flagKey = envKeyToFlagKey(envKey);
    const raw = process.env[envKey];
    if (raw === undefined) continue;

    if (!isFlagDeclared(flagKey)) {
      log.warn({ envKey, flagKey }, "Ignoring unknown env feature flag override");
      continue;
    }

    result[flagKey] = parseValue(raw);
  }

  cache = result;
  return cache;
}

/** Reset the cache so the next call re-scans `process.env`. For tests. */
export function resetEnvOverridesCache(): void {
  cache = null;
}
