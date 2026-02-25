import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { migrationLog } from './log.js';

/**
 * When migratePath skips the data directory because workspace/data already
 * exists (e.g. the user's project had a data/ folder that was extracted from
 * sandbox/fs), the legacy data directory may still contain internal state
 * subdirectories (db/, logs/, sandbox/, etc.) that need to be preserved.
 * This merges any missing entries from the legacy data path into workspace/data.
 */
export function mergeLegacyDataEntries(legacyDir: string, workspaceDir: string): void {
  if (!existsSync(legacyDir) || !existsSync(workspaceDir)) return;

  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(legacyDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const src = join(legacyDir, entry.name);
    const dest = join(workspaceDir, entry.name);
    if (existsSync(dest)) continue; // already present in workspace
    try {
      renameSync(src, dest);
      migrationLog('info', 'Merged legacy data entry into workspace', { from: src, to: dest });
    } catch (err) {
      migrationLog('warn', 'Failed to merge legacy data entry', { err: String(err), from: src, to: dest });
    }
  }
}
