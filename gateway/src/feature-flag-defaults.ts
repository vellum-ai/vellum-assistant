import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLogger } from "./logger.js";

const log = getLogger("feature-flag-defaults");

export type FeatureFlagDefault = {
  defaultEnabled: boolean;
  description: string;
  label: string;
};

export type FeatureFlagDefaultsRegistry = Record<string, FeatureFlagDefault>;

let cachedRegistry: FeatureFlagDefaultsRegistry | null = null;

/** Test-only: when set, these paths are prepended to the candidate list. */
let registryCandidateOverrides: string[] | null = null;

const REGISTRY_FILENAME = "feature-flag-registry.json";
const REGISTRY_RELATIVE = join("meta", "feature-flags", REGISTRY_FILENAME);

/**
 * Resolve the path to the unified feature flag registry JSON file.
 *
 * The canonical file lives at
 * `meta/feature-flags/feature-flag-registry.json`
 * relative to the repository root. We also support bundled copies so
 * gateway-only layouts can still resolve defaults without the repo-root
 * `meta/` tree.
 *
 * Candidate order:
 *   1. Bundled copy adjacent to gateway source (`gateway/src/<file>`)
 *   2. macOS app bundle resources (`Contents/Resources/<file>`)
 *   3. Monorepo layout: walk up two levels from gateway/src/
 *   4. Docker / gateway-only layout: adjacent to gateway src (`<root>/meta/...`)
 *   5. cwd-based fallback
 */
function getRegistryCandidates(): string[] {
  const candidates: string[] = [];

  // Allow tests to inject custom candidate paths ahead of the real ones
  if (registryCandidateOverrides) {
    candidates.push(...registryCandidateOverrides);
  }

  const srcDir = import.meta.dirname ?? new URL(".", import.meta.url).pathname;

  // 1. Bundled gateway-local copy
  candidates.push(join(srcDir, REGISTRY_FILENAME));

  // 2. Packaged macOS app layout: <App>.app/Contents/MacOS/vellum-gateway
  //    defaults live under <App>.app/Contents/Resources/<file>.
  const execDir = dirname(process.execPath);
  candidates.push(join(execDir, "..", "Resources", REGISTRY_FILENAME));

  // 3. Monorepo layout: gateway/src -> repo root is ../../
  const repoRoot = join(srcDir, "..", "..");
  candidates.push(join(repoRoot, REGISTRY_RELATIVE));

  // 4. Docker layout: the gateway Dockerfile copies the gateway dir to /app,
  //    so the meta dir (if mounted or copied) may be under /app/../meta or a
  //    sibling directory. Also check one level up from srcDir (gateway root).
  candidates.push(join(srcDir, "..", REGISTRY_RELATIVE));

  // 5. cwd-based fallback
  candidates.push(join(process.cwd(), REGISTRY_RELATIVE));

  return candidates;
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
    if (typeof entry.description !== "string") {
      log.warn(
        { key: entry.key },
        "Skipping invalid registry entry (description is not string)",
      );
      continue;
    }

    result[entry.key as string] = {
      defaultEnabled: entry.defaultEnabled,
      description: entry.description,
      label: typeof entry.label === "string" ? entry.label : "",
    };
  }
  return result;
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
    log.error(
      { candidates },
      "Failed to read feature flag registry from any candidate path",
    );
    cachedRegistry = {};
    return cachedRegistry;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error(
      { err, path: resolvedPath },
      "Feature flag registry is not valid JSON",
    );
    cachedRegistry = {};
    return cachedRegistry;
  }

  const registry = parseRegistryToDefaults(parsed);

  log.info(
    { flagCount: Object.keys(registry).length, path: resolvedPath },
    "Loaded feature flag defaults registry",
  );
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

/** Prepend custom candidate paths for registry resolution (for testing). */
export function _setRegistryCandidateOverrides(
  overrides: string[] | null,
): void {
  registryCandidateOverrides = overrides;
}
