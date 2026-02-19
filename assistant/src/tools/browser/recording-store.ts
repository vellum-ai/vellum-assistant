/**
 * Simple read/write for session recording JSON files.
 * Stores recordings at ~/.vellum/workspace/data/recordings/<id>.json
 */

import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { getDataDir } from '../../util/platform.js';
import { getLogger } from '../../util/logger.js';
import type { SessionRecording } from './network-recording-types.js';

const log = getLogger('recording-store');

function getRecordingsDir(): string {
  return join(getDataDir(), 'recordings');
}

export function saveRecording(recording: SessionRecording): string {
  const dir = getRecordingsDir();
  mkdirSync(dir, { recursive: true });

  const filePath = resolve(dir, `${recording.id}.json`);
  if (!filePath.startsWith(resolve(dir) + '/')) {
    throw new Error(`Invalid recording ID: ${recording.id}`);
  }
  writeFileSync(filePath, JSON.stringify(recording, null, 2), 'utf-8');
  log.info({ recordingId: recording.id, path: filePath, entries: recording.networkEntries.length }, 'Recording saved');
  return filePath;
}

export function loadRecording(recordingId: string): SessionRecording | null {
  const dir = getRecordingsDir();
  const filePath = resolve(dir, `${recordingId}.json`);
  if (!filePath.startsWith(resolve(dir) + '/')) {
    log.warn({ recordingId }, 'Invalid recording ID');
    return null;
  }
  if (!existsSync(filePath)) {
    log.warn({ recordingId, path: filePath }, 'Recording file not found');
    return null;
  }
  try {
    const data = readFileSync(filePath, 'utf-8');
    return JSON.parse(data) as SessionRecording;
  } catch (err) {
    log.warn({ err, recordingId }, 'Failed to load recording');
    return null;
  }
}
