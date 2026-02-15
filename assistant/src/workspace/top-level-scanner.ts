import { readdirSync } from 'node:fs';

/** Hard cap on returned entries to keep context bounded. */
export const MAX_TOP_LEVEL_ENTRIES = 120;

export interface TopLevelSnapshot {
  rootPath: string;
  directories: string[];
  truncated: boolean;
}

/**
 * Return a deterministic, bounded list of top-level directories
 * under `rootPath`.  Hidden directories are included.  The result
 * is sorted lexicographically.
 */
export function scanTopLevelDirectories(rootPath: string): TopLevelSnapshot {
  let entries: string[];
  try {
    entries = readdirSync(rootPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return { rootPath, directories: [], truncated: false };
  }

  const truncated = entries.length > MAX_TOP_LEVEL_ENTRIES;
  return {
    rootPath,
    directories: truncated ? entries.slice(0, MAX_TOP_LEVEL_ENTRIES) : entries,
    truncated,
  };
}
