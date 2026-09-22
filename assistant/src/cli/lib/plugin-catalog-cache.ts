/**
 * In-memory cache for the installable plugin catalog.
 *
 * Platform-first: when platform features are enabled the catalog is fetched
 * from the Vellum platform and held per git ref for a short TTL. Two read
 * shapes share one refresh. A display read never waits on the network: it
 * serves whatever the ref already has (the cached copy, or the bundled
 * manifest when nothing is cached) and refreshes in the background. A `fresh`
 * read awaits the refresh and propagates its failure, so a pinned install
 * source is never resolved from a stale copy. When `VELLUM_DISABLE_PLATFORM`
 * disables platform features the bundled offline manifest is read instead,
 * with zero network calls.
 */

import { arePlatformFeaturesEnabled } from "../../platform/feature-gate.js";
import { getLogger } from "../../util/logger.js";
import {
  readBundledLocalPluginCatalog,
  readBundledPluginCatalog,
} from "./plugin-catalog-local.js";
import { fetchPluginCatalogFromPlatform } from "./plugin-catalog-platform.js";
import type { PluginCatalog, SearchPluginsDeps } from "./search-plugins.js";

/** How long a fetched catalog is served before a refresh is attempted. */
export const PLUGIN_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** How long the display path waits after a failed refresh before retrying. */
export const PLUGIN_CATALOG_FAILURE_RETRY_MS = 30 * 1000; // 30 seconds

const log = getLogger("plugin-catalog-cache");

interface CacheEntry {
  catalog: PluginCatalog;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

interface InFlightRefresh {
  promise: Promise<PluginCatalog>;
  /** The one change callback this refresh fires; the first reader to offer one fills it. */
  onChanged?: () => void;
}

const inFlight = new Map<string, InFlightRefresh>();
const lastFailureAt = new Map<string, number>();

/** Add bundled local packages without overriding platform-authoritative rows. */
export function mergePlatformCatalogWithBundledLocals(
  platform: PluginCatalog,
  bundledLocal: PluginCatalog = readBundledLocalPluginCatalog(),
): PluginCatalog {
  const seen = new Set(platform.matches.map((match) => match.name));
  return {
    ref: platform.ref,
    matches: [
      ...platform.matches,
      ...bundledLocal.matches.filter((match) => !seen.has(match.name)),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export interface GetPluginCatalogOptions {
  /**
   * Await a platform fetch when the cache is cold or past its TTL, and
   * propagate its failure. Install and one-shot CLI reads.
   */
  fresh?: boolean;
  /**
   * Called if the refresh this read starts or joins changes what the ref
   * serves. A refresh keeps the first callback it is offered and fires it once.
   */
  onChanged?: () => void;
}

function sameMatches(a: PluginCatalog, b: PluginCatalog): boolean {
  return JSON.stringify(a.matches) === JSON.stringify(b.matches);
}

/**
 * Start the single refresh for {@link ref} and register it as in flight.
 *
 * `served` is what the ref answered with before the refresh, so the change
 * callback fires only on a real change. The record holds a single callback
 * slot, which is what keeps one fetch to at most one notification.
 */
function startRefresh(
  ref: string,
  deps: SearchPluginsDeps,
  served: PluginCatalog,
  onChanged: (() => void) | undefined,
): InFlightRefresh {
  const slot: Pick<InFlightRefresh, "onChanged"> = { onChanged };
  const promise = fetchPluginCatalogFromPlatform(deps, { ref })
    .then((catalog) => {
      const merged = mergePlatformCatalogWithBundledLocals(catalog);
      cache.set(ref, { catalog: merged, timestamp: Date.now() });
      lastFailureAt.delete(ref);
      if (slot.onChanged && !sameMatches(served, merged)) {
        try {
          slot.onChanged();
        } catch (err) {
          log.warn({ err, ref }, "Plugin catalog change callback threw");
        }
      }
      return merged;
    })
    .catch((err: unknown) => {
      lastFailureAt.set(ref, Date.now());
      log.warn({ err, ref }, "Plugin catalog refresh failed");
      throw err;
    })
    .finally(() => {
      inFlight.delete(ref);
    });
  // Same object as `slot`, so a reader that joins later fills the slot the
  // promise reads when it settles.
  const refresh: InFlightRefresh = Object.assign(slot, { promise });
  inFlight.set(ref, refresh);
  return refresh;
}

/**
 * Resolve the full plugin catalog at {@link ref}.
 *
 * With platform features disabled the bundled manifest is returned directly:
 * an in-memory constant, no network and no TTL. Otherwise a cached catalog
 * within the TTL is served as is, and anything else gets or starts the one
 * in-flight refresh for that ref. A `fresh` read returns that refresh, so a
 * platform failure reaches the caller. A display read returns the cached
 * catalog (or the bundled manifest) straight away and lets the refresh land in
 * the background; after a failed refresh it holds off for
 * {@link PLUGIN_CATALOG_FAILURE_RETRY_MS} before fetching again, while a
 * `fresh` read ignores that gate.
 */
export async function getPluginCatalog(
  ref: string,
  deps: SearchPluginsDeps,
  options: GetPluginCatalogOptions = {},
): Promise<PluginCatalog> {
  if (!arePlatformFeaturesEnabled()) {
    return { ...readBundledPluginCatalog(), ref };
  }

  const cached = cache.get(ref);
  if (cached && Date.now() - cached.timestamp < PLUGIN_CATALOG_CACHE_TTL_MS) {
    return cached.catalog;
  }

  const served = cached?.catalog ?? { ...readBundledPluginCatalog(), ref };

  let refresh = inFlight.get(ref);
  if (!refresh) {
    const failedAt = lastFailureAt.get(ref);
    if (
      !options.fresh &&
      failedAt !== undefined &&
      Date.now() - failedAt < PLUGIN_CATALOG_FAILURE_RETRY_MS
    ) {
      return served;
    }
    refresh = startRefresh(ref, deps, served, options.onChanged);
  } else {
    refresh.onChanged ??= options.onChanged;
  }

  if (options.fresh) {
    return refresh.promise;
  }
  // A background refresh has no caller to reject to; its failure is logged
  // where it is recorded.
  refresh.promise.catch(() => {});
  return served;
}

/** Invalidate the cache (for testing or forced refresh). */
export function invalidatePluginCatalogCache(): void {
  cache.clear();
  inFlight.clear();
  lastFailureAt.clear();
}
