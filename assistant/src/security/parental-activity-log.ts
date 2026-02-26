/**
 * Activity log for the child profile.
 *
 * Records what actions the child profile takes so that a parent can review
 * them in Settings > Parental > Activity Log. Events are appended to
 * `~/.vellum/parental-activity-log.json` and never removed automatically;
 * the parent clears the log manually via the settings UI.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { v4 as uuid } from 'uuid';

import { ensureDir, pathExists } from '../util/fs.js';
import { getLogger } from '../util/logger.js';
import { getRootDir } from '../util/platform.js';

const log = getLogger('parental-activity-log');

export interface ActivityLogEntry {
  id: string;
  timestamp: string;         // ISO 8601
  profile: 'child';          // always "child" — only child actions are logged
  actionType: 'tool_call' | 'request' | 'approval_request';
  description: string;
  metadata?: Record<string, unknown>;
}

interface LogFile {
  entries: ActivityLogEntry[];
}

function getLogPath(): string {
  return join(getRootDir(), 'parental-activity-log.json');
}

function readLog(): ActivityLogEntry[] {
  try {
    const file = getLogPath();
    if (!pathExists(file)) return [];
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LogFile>;
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function writeLog(entries: ActivityLogEntry[]): void {
  const file = getLogPath();
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify({ entries }, null, 2), { encoding: 'utf-8' });
}

/**
 * Append one event to the activity log.
 *
 * The caller is responsible for only calling this when the active profile is
 * "child" — the store does not gate on profile state to keep it simple and
 * testable.
 */
export function appendActivityLogEntry(
  entry: Omit<ActivityLogEntry, 'id' | 'timestamp' | 'profile'>,
): ActivityLogEntry {
  const full: ActivityLogEntry = {
    id: uuid(),
    timestamp: new Date().toISOString(),
    profile: 'child',
    actionType: entry.actionType,
    description: entry.description,
    ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
  };

  const entries = readLog();
  entries.push(full);
  // Cap the log to prevent unbounded disk/memory growth.
  const MAX_ENTRIES = 10_000;
  const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
  writeLog(trimmed);
  log.debug({ id: full.id, actionType: full.actionType }, 'Activity log entry appended');
  return full;
}

/** Return all entries in chronological order. */
export function listActivityLogEntries(): ActivityLogEntry[] {
  return readLog();
}

/** Remove all entries from the log. */
export function clearActivityLog(): void {
  writeLog([]);
  log.info('Activity log cleared');
}
