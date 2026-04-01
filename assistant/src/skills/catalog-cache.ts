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

/** Resolve the Vellum catalog with in-memory caching. */
export async function getCatalog(): Promise<CatalogSkill[]> {
  if (cachedCatalog && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedCatalog;
  }
  const repoSkillsDir = getRepoSkillsDir();
  let catalog: CatalogSkill[];
  if (repoSkillsDir) {
    catalog = readLocalCatalog(repoSkillsDir);
  } else {
    try {
      catalog = await fetchCatalog();
    } catch (err) {
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
