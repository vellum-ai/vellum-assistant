import { readdirSync } from 'node:fs';

/** Hard cap on returned entries to keep context bounded. */
export const MAX_TOP_LEVEL_ENTRIES = 120;

export interface TopLevelSnapshot {
  rootPath: string;
  directories: string[];
  files: string[];
  truncated: boolean;
}

/**
 * Return a deterministic, bounded list of top-level directories
 * under `rootPath`.  Hidden directories are included.  The result
 * is sorted lexicographically.
 */
export function scanTopLevelDirectories(rootPath: string): TopLevelSnapshot {
  let dirEntries: string[];
  let fileEntries: string[];
  try {
    const all = readdirSync(rootPath, { withFileTypes: true });
    dirEntries = all.filter((d) => d.isDirectory()).map((d) => d.name).sort();
    fileEntries = all.filter((d) => d.isFile()).map((d) => d.name).sort();
  } catch {
    return { rootPath, directories: [], files: [], truncated: false };
  }

  const totalEntries = dirEntries.length + fileEntries.length;
  const truncated = totalEntries > MAX_TOP_LEVEL_ENTRIES;

  if (truncated) {
    // Directories first, then fill remaining budget with files
    const dirs = dirEntries.slice(0, MAX_TOP_LEVEL_ENTRIES);
    const remaining = Math.max(0, MAX_TOP_LEVEL_ENTRIES - dirs.length);
    const files = fileEntries.slice(0, remaining);
    return { rootPath, directories: dirs, files, truncated };
  }

  return { rootPath, directories: dirEntries, files: fileEntries, truncated };
}
