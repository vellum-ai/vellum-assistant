/**
 * In-memory cache for the installable plugin catalog.
 *
 * Platform-first: when platform features are enabled the catalog is fetched
 * from the Vellum platform and any fetch failure propagates (fail hard — no
 * stale-cache smoothing). Successful loads are held per git ref for a short
 * TTL. When `VELLUM_DISABLE_PLATFORM` disables platform features the bundled
 * offline manifest is read instead, with zero network calls.
 */

import { arePlatformFeaturesEnabled } from "../../platform/feature-gate.js";
import {
  readBundledLocalPluginCatalog,
  readBundledPluginCatalog,
} from "./plugin-catalog-local.js";
import { fetchPluginCatalogFromPlatform } from "./plugin-catalog-platform.js";
import { filterPluginCatalogByFeatureFlags } from "./plugin-catalog-visibility.js";
import type { PluginCatalog, SearchPluginsDeps } from "./search-plugins.js";

/** How long a fetched catalog is served before a refresh is attempted. */
export const PLUGIN_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  catalog: PluginCatalog;
  timestamp: number;
}

type PluginCatalogLoadDeps = Pick<SearchPluginsDeps, "fetch">;

const cache = new Map<string, CacheEntry>();

/**
 * Add bundled local packages without overriding platform-authoritative rows.
 * A platform row without an integration borrows the bundled row's
 * integration of the same name, so an integration the platform omits or
 * serves malformed never disappears from the catalog.
 */
export function mergePlatformCatalogWithBundledLocals(
  platform: PluginCatalog,
  bundledLocal: PluginCatalog = readBundledLocalPluginCatalog(),
): PluginCatalog {
  const bundledByName = new Map(
    bundledLocal.matches.map((match) => [match.name, match]),
  );
  const platformMatches = platform.matches.map((match) => {
    const bundledIntegration = bundledByName.get(match.name)?.integration;
    if (match.integration || !bundledIntegration) {
      return match;
    }
    return { ...match, integration: bundledIntegration };
  });
  const seen = new Set(platform.matches.map((match) => match.name));
  return {
    ref: platform.ref,
    matches: [
      ...platformMatches,
      ...bundledLocal.matches.filter((match) => !seen.has(match.name)),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Resolve the full plugin catalog at {@link ref}.
 *
 * With platform features disabled the bundled manifest is returned directly —
 * an in-memory constant, no network and no TTL. Otherwise the catalog is
 * fetched from the platform and, on success, cached per ref for the TTL; a
 * fetch failure propagates so the caller can surface it (e.g. map a rate-limit
 * to 503) — no stale catalog is ever served.
 */
async function loadPluginCatalog(
  ref: string,
  deps: PluginCatalogLoadDeps,
): Promise<PluginCatalog> {
  if (!arePlatformFeaturesEnabled()) {
    return { ...readBundledPluginCatalog(), ref };
  }

  const cached = cache.get(ref);
  if (cached && Date.now() - cached.timestamp < PLUGIN_CATALOG_CACHE_TTL_MS) {
    return cached.catalog;
  }

  const catalog = await fetchPluginCatalogFromPlatform(deps, { ref });
  const merged = mergePlatformCatalogWithBundledLocals(catalog);
  cache.set(ref, { catalog: merged, timestamp: Date.now() });
  return merged;
}

/** Installable catalog with feature-flag visibility applied. */
export async function getPluginCatalog(
  ref: string,
  deps: SearchPluginsDeps,
): Promise<PluginCatalog> {
  return filterPluginCatalogByFeatureFlags(
    await loadPluginCatalog(ref, deps),
    deps.featureFlagEnabled,
  );
}

/** Category metadata for plugins already installed, including hidden entries. */
export async function getPluginCatalogForInstalledMetadata(
  ref: string,
  deps: PluginCatalogLoadDeps,
): Promise<PluginCatalog> {
  return loadPluginCatalog(ref, deps);
}

/** Invalidate the cache (for testing or forced refresh). */
export function invalidatePluginCatalogCache(): void {
  cache.clear();
}
