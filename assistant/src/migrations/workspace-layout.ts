import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getRootDir, getWorkspaceDir } from '../util/platform.js';
import { migrationLog } from './log.js';
import { mergeSkippedConfigKeys } from './config-merge.js';
import { mergeLegacyHooks } from './hooks-merge.js';
import { mergeLegacySkills } from './skills-merge.js';
import { mergeLegacyDataEntries } from './data-merge.js';

/**
 * Idempotent move: relocates source to destination for migration.
 * - No-op if source is missing (already migrated or never existed).
 * - No-op if destination already exists (avoids clobbering).
 * - Creates destination parent directories as needed.
 * - Logs warning on failure instead of throwing.
 *
 * Exported for testing; not intended for general use outside migrations.
 */
export function migratePath(source: string, destination: string): void {
  if (!existsSync(source)) return;
  if (existsSync(destination)) {
    migrationLog('debug', 'Migration skipped: destination already exists', { source, destination });
    return;
  }
  try {
    const destDir = dirname(destination);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    renameSync(source, destination);
    migrationLog('info', 'Migrated path', { from: source, to: destination });
  } catch (err) {
    migrationLog('warn', 'Failed to migrate path', { err: String(err), from: source, to: destination });
  }
}

/**
 * Migrate from the flat ~/.vellum layout to the workspace-based layout.
 *
 * Step (a) is special: if the workspace dir doesn't exist yet but the old
 * sandbox working dir (data/sandbox/fs) does, its contents are "extracted"
 * to become the new workspace root via rename. All subsequent moves then
 * land inside that workspace directory.
 *
 * Idempotent: safe to call on every startup — already-migrated items are
 * skipped, and a second run is a no-op.
 */
export function migrateToWorkspaceLayout(): void {
  const root = getRootDir();
  if (!existsSync(root)) return;

  const ws = getWorkspaceDir();

  // (a) Extract data/sandbox/fs -> workspace (only when workspace doesn't exist yet)
  if (!existsSync(ws)) {
    const sandboxFs = join(root, 'data', 'sandbox', 'fs');
    if (existsSync(sandboxFs)) {
      try {
        renameSync(sandboxFs, ws);
        migrationLog('info', 'Extracted sandbox/fs as workspace root', { from: sandboxFs, to: ws });
      } catch (err) {
        migrationLog('warn', 'Failed to extract sandbox/fs', { err: String(err), from: sandboxFs, to: ws });
      }
    }
  }

  // (b)-(h) Move legacy root-level items into workspace
  migratePath(join(root, 'config.json'), join(ws, 'config.json'));
  mergeSkippedConfigKeys(join(root, 'config.json'), join(ws, 'config.json'));
  migratePath(join(root, 'data'), join(ws, 'data'));
  mergeLegacyDataEntries(join(root, 'data'), join(ws, 'data'));
  migratePath(join(root, 'hooks'), join(ws, 'hooks'));
  mergeLegacyHooks(join(root, 'hooks'), join(ws, 'hooks'));
  migratePath(join(root, 'IDENTITY.md'), join(ws, 'IDENTITY.md'));
  migratePath(join(root, 'skills'), join(ws, 'skills'));
  mergeLegacySkills(join(root, 'skills'), join(ws, 'skills'));
  migratePath(join(root, 'SOUL.md'), join(ws, 'SOUL.md'));
  migratePath(join(root, 'USER.md'), join(ws, 'USER.md'));
}
