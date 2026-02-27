import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "./logger.js";

const log = getLogger("feature-flag-defaults");

export type FeatureFlagDefault = {
  defaultEnabled: boolean;
  description: string;
};

export type FeatureFlagDefaultsRegistry = Record<string, FeatureFlagDefault>;

let cachedRegistry: FeatureFlagDefaultsRegistry | null = null;

const REGISTRY_FILENAME = "assistant-feature-flag-defaults.json";
const REGISTRY_RELATIVE = join("meta", "assistant-feature-flags", REGISTRY_FILENAME);

/**
 * Resolve the path to the defaults registry JSON file.
 *
 * The file lives at `meta/assistant-feature-flags/assistant-feature-flag-defaults.json`
 * relative to the repository root. We try several candidate locations so the
 * lookup works both in the monorepo dev layout and in Docker (where only
 * the gateway directory is copied to `/app`).
 *
 * Candidate order:
 *   1. `FEATURE_FLAG_DEFAULTS_PATH` env var (explicit override)
 *   2. Monorepo layout: walk up two levels from gateway/src/
 *   3. Docker / gateway-only layout: adjacent to gateway src (`<root>/meta/...`)
 *   4. cwd-based fallback
 */
function getRegistryCandidates(): string[] {
  const candidates: string[] = [];

  // 1. Explicit env override
  const envPath = process.env.FEATURE_FLAG_DEFAULTS_PATH?.trim();
  if (envPath) {
    candidates.push(envPath);
  }

  // 2. Monorepo layout: gateway/src -> repo root is ../../
  const srcDir = import.meta.dirname ?? new URL(".", import.meta.url).pathname;
  const repoRoot = join(srcDir, "..", "..");
  candidates.push(join(repoRoot, REGISTRY_RELATIVE));

  // 3. Docker layout: the gateway Dockerfile copies the gateway dir to /app,
  //    so the meta dir (if mounted or copied) may be under /app/../meta or a
  //    sibling directory. Also check one level up from srcDir (gateway root).
  candidates.push(join(srcDir, "..", REGISTRY_RELATIVE));

  // 4. cwd-based fallback
  candidates.push(join(process.cwd(), REGISTRY_RELATIVE));

  return candidates;
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

  const candidates = getRegistryCandidates();
  let raw: string | undefined;
  let resolvedPath: string | undefined;

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        raw = readFileSync(candidate, "utf-8");
        resolvedPath = candidate;
        break;
      } catch {
        // File exists but couldn't be read — try next candidate
      }
    }
  }

  if (!raw || !resolvedPath) {
    log.error({ candidates }, "Failed to read feature flag defaults registry from any candidate path");
    cachedRegistry = {};
    return cachedRegistry;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error({ err, path: resolvedPath }, "Feature flag defaults registry is not valid JSON");
    cachedRegistry = {};
    return cachedRegistry;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.error({ path: resolvedPath }, "Feature flag defaults registry must be a JSON object");
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

  log.info({ flagCount: Object.keys(registry).length, path: resolvedPath }, "Loaded feature flag defaults registry");
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
