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
import { readBundledPluginCatalog } from "./plugin-catalog-local.js";
import { fetchPluginCatalogFromPlatform } from "./plugin-catalog-platform.js";
import type { PluginCatalog, SearchPluginsDeps } from "./search-plugins.js";

/** How long a fetched catalog is served before a refresh is attempted. */
export const PLUGIN_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  catalog: PluginCatalog;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Resolve the full plugin catalog at {@link ref}.
 *
 * With platform features disabled the bundled manifest is returned directly —
 * an in-memory constant, no network and no TTL. Otherwise the catalog is
 * fetched from the platform and, on success, cached per ref for the TTL; a
 * fetch failure propagates so the caller can surface it (e.g. map a rate-limit
 * to 503) — no stale catalog is ever served.
 */
export async function getPluginCatalog(
  ref: string,
  deps: SearchPluginsDeps,
): Promise<PluginCatalog> {
  if (!arePlatformFeaturesEnabled()) {
    return { ...readBundledPluginCatalog(), ref };
  }

  const cached = cache.get(ref);
  if (cached && Date.now() - cached.timestamp < PLUGIN_CATALOG_CACHE_TTL_MS) {
    return cached.catalog;
  }

  const catalog = await fetchPluginCatalogFromPlatform(deps, { ref });
  cache.set(ref, { catalog, timestamp: Date.now() });
  return catalog;
}

/** Invalidate the cache (for testing or forced refresh). */
export function invalidatePluginCatalogCache(): void {
  cache.clear();
}
