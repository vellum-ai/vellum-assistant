/**
 * In-memory cache for the installable plugin catalog.
 *
 * The catalog (`loadPluginCatalog`) is built from a single unauthenticated
 * GitHub Contents API call — the `marketplace.json` manifest. GitHub's
 * unauthenticated rate limit is 60 requests/hour per IP, so a long-lived
 * daemon that hit GitHub on every catalog search (on web mount, on every
 * keystroke, across reloads and multiple clients) would exhaust that budget
 * and start getting HTTP 403s.
 *
 * Because the GitHub responses are **query-independent** — `searchPlugins`
 * applies the regex filter in memory — one catalog load serves any number of
 * searches. This cache holds that load per git ref for a short TTL and, on an
 * upstream failure, serves the last good catalog so a transient rate-limit or
 * outage is invisible to callers. Mirrors the skills catalog cache
 * (`src/skills/catalog-cache.ts`).
 */

import { getLogger } from "../../util/logger.js";
import {
  loadPluginCatalog,
  type PluginCatalog,
  PluginCatalogUnavailableError,
  type SearchPluginsDeps,
} from "./search-plugins.js";

const log = getLogger("plugin-catalog-cache");

/** How long a fetched catalog is served before a refresh is attempted. */
export const PLUGIN_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  catalog: PluginCatalog;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Resolve the full plugin catalog at {@link ref} with in-memory caching.
 *
 * Within the TTL window the cached catalog is returned without touching the
 * network. After the TTL elapses a refresh is attempted; if it fails with a
 * transient upstream error ({@link PluginCatalogUnavailableError} — rate
 * limiting or a 5xx) and a cached catalog exists, the stale catalog is served
 * (and its TTL window is reset so a sustained outage doesn't re-enter the
 * failing fetch on every call). A hard error (e.g. a malformed manifest, or a
 * deleted ref) always propagates — serving stale there would silently mask a
 * real misconfiguration. With no cache to fall
 * back on, the underlying error propagates regardless so the caller can
 * surface it (e.g. the route maps a rate-limit failure to 503).
 */
export async function getPluginCatalog(
  ref: string,
  deps: SearchPluginsDeps,
): Promise<PluginCatalog> {
  const cached = cache.get(ref);
  if (cached && Date.now() - cached.timestamp < PLUGIN_CATALOG_CACHE_TTL_MS) {
    return cached.catalog;
  }

  try {
    const catalog = await loadPluginCatalog({ ref }, deps);
    cache.set(ref, { catalog, timestamp: Date.now() });
    return catalog;
  } catch (err) {
    if (cached && err instanceof PluginCatalogUnavailableError) {
      log.warn(
        { err, ref },
        "Failed to refresh plugin catalog, serving stale cache",
      );
      // Reset the TTL window so subsequent calls during the outage are served
      // from cache instead of re-entering loadPluginCatalog() every time.
      cached.timestamp = Date.now();
      return cached.catalog;
    }
    throw err;
  }
}

/** Invalidate the cache (for testing or forced refresh). */
export function invalidatePluginCatalogCache(): void {
  cache.clear();
}
