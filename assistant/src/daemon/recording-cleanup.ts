/**
 * Periodic cleanup of expired file-backed QA recording attachments.
 *
 * Runs on a configurable interval (default: every 6 hours) and also
 * executes a single pass on daemon startup to catch recordings that
 * expired while the daemon was offline.
 */

import { existsSync, statSync, unlinkSync } from 'node:fs';
import { getExpiredFileAttachments, deleteFileBackedAttachment } from '../memory/attachments-store.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('recording-cleanup');

/**
 * Run a single cleanup pass: find expired file-backed attachments,
 * delete their files from disk, and remove the DB rows.
 *
 * Returns the number of cleaned-up attachments and total bytes freed.
 */
export function runCleanupPass(): { cleaned: number; bytesFreed: number } {
  const expired = getExpiredFileAttachments();
  if (expired.length === 0) {
    return { cleaned: 0, bytesFreed: 0 };
  }

  let cleaned = 0;
  let bytesFreed = 0;

  for (const { id, filePath } of expired) {
    try {
      let fileSize = 0;

      if (existsSync(filePath)) {
        try {
          fileSize = statSync(filePath).size;
        } catch {
          // If we can't stat, still try to delete
        }
        unlinkSync(filePath);
        log.info({ attachmentId: id, filePath }, 'Deleted expired recording file');
      } else {
        log.debug({ attachmentId: id, filePath }, 'Expired recording file already missing from disk');
      }

      const result = deleteFileBackedAttachment(id);
      if (result === 'deleted') {
        cleaned++;
        bytesFreed += fileSize;
      }
    } catch (err) {
      log.warn({ err, attachmentId: id, filePath }, 'Failed to clean up expired recording');
    }
  }

  if (cleaned > 0) {
    const mbFreed = (bytesFreed / (1024 * 1024)).toFixed(1);
    log.info({ count: cleaned, bytesFreed, mbFreed }, `Cleaned up ${cleaned} expired QA recordings, freed ${mbFreed} MB`);
  }

  return { cleaned, bytesFreed };
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic cleanup worker. Runs one immediate pass,
 * then schedules recurring passes at the configured interval.
 */
export function startRecordingCleanup(intervalMs: number): void {
  // Run one pass immediately to catch anything that expired while offline
  try {
    runCleanupPass();
  } catch (err) {
    log.warn({ err }, 'Initial recording cleanup pass failed');
  }

  // setInterval uses a 32-bit signed int internally; values above 2^31-1 ms
  // (~24.8 days) wrap around and fire near-continuously.
  const MAX_INTERVAL_MS = 2_147_483_647;
  const safeInterval = Math.min(intervalMs, MAX_INTERVAL_MS);

  cleanupTimer = setInterval(() => {
    try {
      runCleanupPass();
    } catch (err) {
      log.warn({ err }, 'Periodic recording cleanup pass failed');
    }
  }, safeInterval);

  // Don't keep the process alive just for cleanup
  cleanupTimer.unref();
  log.info({ intervalMs }, 'Recording cleanup worker started');
}

/**
 * Stop the periodic cleanup worker.
 */
export function stopRecordingCleanup(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    log.info('Recording cleanup worker stopped');
  }
}
