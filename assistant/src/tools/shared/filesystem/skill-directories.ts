import { realpathSync } from "node:fs";

import { loadSkillCatalog } from "../../../config/skills.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("skill-directories");

/**
 * How long the resolved directory list is reused before the catalog is
 * rescanned. Skills are installed far less often than files are read, so a
 * short window keeps repeated reads off the filesystem while a newly
 * installed skill becomes readable shortly after it lands.
 */
const CACHE_TTL_MS = 30_000;

let cachedDirectories: string[] | null = null;
let cachedAt = 0;

function canonicalize(directoryPath: string): string {
  try {
    return realpathSync(directoryPath);
  } catch {
    return directoryPath;
  }
}

/**
 * Symlink-canonicalized directories of every skill in the catalog: bundled,
 * managed, workspace, plugin-resident and extra alike. The catalog is the
 * single enumeration of where skills live, so directories it does not list
 * are not skill directories.
 *
 * Callers use this to widen a read boundary, so it is consulted only when a
 * path already falls outside the working directory. The result is cached for
 * {@link CACHE_TTL_MS}; an enumeration failure yields an empty list, which
 * denies rather than widens.
 */
export function getSkillDirectories(): string[] {
  const now = Date.now();
  if (cachedDirectories && now - cachedAt < CACHE_TTL_MS) {
    return cachedDirectories;
  }

  let directories: string[] = [];
  try {
    const unique = new Set(
      loadSkillCatalog().map((skill) => skill.directoryPath),
    );
    directories = [...unique].map(canonicalize);
  } catch (err) {
    log.warn({ err }, "Failed to enumerate skill directories");
    directories = [];
  }

  cachedDirectories = directories;
  cachedAt = now;
  return directories;
}

/** Drop the cached directory list so the next call rescans the catalog. */
export function invalidateSkillDirectoriesCache(): void {
  cachedDirectories = null;
  cachedAt = 0;
}
