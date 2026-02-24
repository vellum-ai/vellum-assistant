import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { isPlainObject } from '../util/object.js';
import { migrationLog } from './log.js';

/**
 * When migratePath skips config.json because the workspace copy already
 * exists, the legacy root config may still contain keys (e.g. slackWebhookUrl)
 * that were never written to the workspace config. This merges any missing
 * top-level keys from the legacy file into the workspace file so they are
 * not silently lost during upgrade.
 */
export function mergeSkippedConfigKeys(legacyPath: string, workspacePath: string): void {
  if (!existsSync(legacyPath) || !existsSync(workspacePath)) return;

  let legacy: Record<string, unknown>;
  let workspace: Record<string, unknown>;
  try {
    const legacyRaw = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    const workspaceRaw = JSON.parse(readFileSync(workspacePath, 'utf-8'));
    if (!isPlainObject(legacyRaw) || !isPlainObject(workspaceRaw)) return;
    legacy = legacyRaw;
    workspace = workspaceRaw;
  } catch {
    return; // malformed JSON — skip silently
  }

  const merged: string[] = [];
  for (const key of Object.keys(legacy)) {
    if (!(key in workspace)) {
      workspace[key] = legacy[key];
      merged.push(key);
    }
  }

  if (merged.length > 0) {
    try {
      writeFileSync(workspacePath, JSON.stringify(workspace, null, 2) + '\n');
      // Remove merged keys from legacy config so they are not resurrected
      // if a user later deletes them from the workspace config.
      for (const key of merged) {
        delete legacy[key];
      }
      if (Object.keys(legacy).length === 0) {
        unlinkSync(legacyPath);
      } else {
        writeFileSync(legacyPath, JSON.stringify(legacy, null, 2) + '\n');
      }
      migrationLog('info', 'Merged legacy config keys into workspace config', { keys: merged });
    } catch (err) {
      migrationLog('warn', 'Failed to merge legacy config keys', { err: String(err), keys: merged });
    }
  }
}
