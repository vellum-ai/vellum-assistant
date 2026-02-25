/**
 * Recording cleanup worker.
 *
 * Periodically removes expired file-backed recording attachments whose
 * retention period has elapsed. Follows the same start/stop pattern as
 * the memory jobs worker.
 */

import { unlinkSync } from 'node:fs';
import type { RecordingConfig } from '../config/types.js';
import { rawAll, rawRun } from '../memory/db.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('recording-cleanup');

interface ExpiredAttachment {
  id: string;
  filePath: string;
}

export interface RecordingCleanupWorker {
  stop(): void;
}

function sweepExpiredRecordings(config: RecordingConfig): void {
  if (config.defaultRetentionDays === 0) return;

  const cutoffMs = Date.now() - config.defaultRetentionDays * 86_400_000;

  const expired = rawAll<ExpiredAttachment>(
    `SELECT id, file_path AS filePath FROM attachments
     WHERE file_path IS NOT NULL
       AND created_at < ?`,
    cutoffMs,
  );

  if (expired.length === 0) return;

  for (const att of expired) {
    try {
      unlinkSync(att.filePath);
    } catch (err) {
      // File may already be deleted or moved; log and continue
      log.debug({ err, filePath: att.filePath, attachmentId: att.id }, 'Could not delete recording file (may already be removed)');
    }

    try {
      // Remove message-attachment links first, then the attachment record
      rawRun('DELETE FROM message_attachments WHERE attachment_id = ?', att.id);
      rawRun('DELETE FROM attachments WHERE id = ?', att.id);
      log.info({ attachmentId: att.id, filePath: att.filePath }, 'Deleted expired recording attachment');
    } catch (err) {
      log.warn({ err, attachmentId: att.id }, 'Failed to delete attachment record');
    }
  }
}

export function startRecordingCleanupWorker(config: RecordingConfig): RecordingCleanupWorker {
  if (config.defaultRetentionDays === 0) {
    log.info('Recording retention set to 0 (keep forever) — cleanup worker disabled');
    return { stop() {} };
  }

  // Run an initial sweep on startup
  try {
    sweepExpiredRecordings(config);
  } catch (err) {
    log.warn({ err }, 'Initial recording cleanup sweep failed');
  }

  const timer = setInterval(() => {
    try {
      sweepExpiredRecordings(config);
    } catch (err) {
      log.warn({ err }, 'Recording cleanup sweep failed');
    }
  }, config.cleanupIntervalMs);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
