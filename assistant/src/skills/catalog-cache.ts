import { getLogger } from "../util/logger.js";
import type { CatalogSkill } from "./catalog-install.js";
import {
  fetchCatalog,
  getRepoSkillsDir,
  readLocalCatalog,
} from "./catalog-install.js";

const log = getLogger("catalog-cache");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedCatalog: CatalogSkill[] | null = null;
let cacheTimestamp = 0;

/**
 * Resolve the Vellum catalog with in-memory caching.
 *
 * When a local first-party catalog is available (dev mode or compiled binary
 * with bundled skills), merge it with the remote catalog so skills published
 * after the build still show up. Local entries take precedence by id. If the
 * remote fetch fails and a local catalog exists, fall back to it so listings
 * keep working offline. Mirrors `resolveCatalog()` in `catalog-install.ts`.
 */
export async function getCatalog(): Promise<CatalogSkill[]> {
  if (cachedCatalog && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedCatalog;
  }
  const repoSkillsDir = getRepoSkillsDir();
  const local = repoSkillsDir ? readLocalCatalog(repoSkillsDir) : [];
  let catalog: CatalogSkill[];
  try {
    const remote = await fetchCatalog();
    if (local.length > 0) {
      const localIds = new Set(local.map((s) => s.id));
      catalog = [...local, ...remote.filter((s) => !localIds.has(s.id))];
    } else {
      catalog = remote;
    }
  } catch (err) {
    if (local.length > 0) {
      log.warn(
        { err },
        "Failed to fetch Vellum catalog, falling back to bundled local catalog",
      );
      catalog = local;
    } else {
      log.warn(
        { err },
        "Failed to fetch Vellum catalog, using stale cache or empty",
      );
      return cachedCatalog ?? [];
    }
  }
  cachedCatalog = catalog;
  cacheTimestamp = Date.now();
  return catalog;
}

/** Return the cached catalog synchronously, or [] if no cache exists yet. */
export function getCachedCatalogSync(): CatalogSkill[] {
  return cachedCatalog ?? [];
}

/** Invalidate the cache (for testing or forced refresh). */
export function invalidateCatalogCache(): void {
  cachedCatalog = null;
  cacheTimestamp = 0;
}
