import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'recording-cleanup-test-'));

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
  getRootDir: () => testDir,
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  }),
}));

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { uploadFileBackedAttachment } from '../memory/attachments-store.js';
import { startRecordingCleanupWorker } from '../daemon/recording-cleanup.js';
import type { RecordingConfig } from '../config/types.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

function resetTables() {
  const db = getDb();
  db.run('DELETE FROM message_attachments');
  db.run('DELETE FROM attachments');
}

function makeConfig(overrides: Partial<RecordingConfig> = {}): RecordingConfig {
  return {
    defaultRetentionDays: 30,
    cleanupIntervalMs: 3600000,
    captureScope: 'display',
    includeAudio: false,
    enforceStartBeforeActions: true,
    ...overrides,
  };
}

/** Insert a file-backed attachment with a custom createdAt timestamp. */
function insertExpiredAttachment(
  filename: string,
  filePath: string,
  createdAt: number,
): string {
  const att = uploadFileBackedAttachment(filename, 'video/mp4', filePath, 1024);
  // Directly update createdAt to simulate an old attachment
  const db = getDb();
  db.run('UPDATE attachments SET created_at = ? WHERE id = ?', createdAt, att.id);
  return att.id;
}

describe('startRecordingCleanupWorker', () => {
  beforeEach(resetTables);

  test('removes expired file-backed attachments after retention period', () => {
    const filePath = join(testDir, 'expired-video.mp4');
    writeFileSync(filePath, 'fake video data');

    // Created 31 days ago — should be cleaned up with 30-day retention
    const createdAt = Date.now() - 31 * 86_400_000;
    const attId = insertExpiredAttachment('expired.mp4', filePath, createdAt);

    const worker = startRecordingCleanupWorker(makeConfig({ defaultRetentionDays: 30 }));

    // The initial sweep runs synchronously in the constructor
    const db = getDb();
    const row = db.run('SELECT id FROM attachments WHERE id = ?', attId);

    // Attachment record should be deleted
    const remaining = db.query('SELECT id FROM attachments WHERE id = ?').get(attId);
    expect(remaining).toBeNull();

    // File should be deleted
    expect(existsSync(filePath)).toBe(false);

    worker.stop();
  });

  test('does not remove attachments within retention period', () => {
    const filePath = join(testDir, 'recent-video.mp4');
    writeFileSync(filePath, 'fake video data');

    // Created 10 days ago — should NOT be cleaned up with 30-day retention
    const createdAt = Date.now() - 10 * 86_400_000;
    const attId = insertExpiredAttachment('recent.mp4', filePath, createdAt);

    const worker = startRecordingCleanupWorker(makeConfig({ defaultRetentionDays: 30 }));

    const db = getDb();
    const remaining = db.query('SELECT id FROM attachments WHERE id = ?').get(attId);
    expect(remaining).not.toBeNull();

    expect(existsSync(filePath)).toBe(true);

    worker.stop();
  });

  test('does not remove non-file-backed attachments', () => {
    // Upload a regular (non-file-backed) attachment
    const db = getDb();
    const id = 'inline-attachment-id';
    db.run(
      `INSERT INTO attachments (id, original_filename, mime_type, size_bytes, kind, data_base64, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, 'screenshot.png', 'image/png', 100, 'image', 'iVBORw0K',
      Date.now() - 31 * 86_400_000,
    );

    const worker = startRecordingCleanupWorker(makeConfig({ defaultRetentionDays: 30 }));

    // Non-file-backed attachment should still exist (filePath IS NULL)
    const remaining = db.query('SELECT id FROM attachments WHERE id = ?').get(id);
    expect(remaining).not.toBeNull();

    worker.stop();
  });

  test('skips cleanup when defaultRetentionDays is 0', () => {
    const filePath = join(testDir, 'keep-forever.mp4');
    writeFileSync(filePath, 'fake video data');

    const createdAt = Date.now() - 365 * 86_400_000; // 1 year old
    const attId = insertExpiredAttachment('old.mp4', filePath, createdAt);

    const worker = startRecordingCleanupWorker(makeConfig({ defaultRetentionDays: 0 }));

    const db = getDb();
    const remaining = db.query('SELECT id FROM attachments WHERE id = ?').get(attId);
    expect(remaining).not.toBeNull();
    expect(existsSync(filePath)).toBe(true);

    worker.stop();
  });

  test('handles missing files gracefully (file already deleted)', () => {
    const filePath = join(testDir, 'already-gone.mp4');
    // Do NOT create the file — simulate it being already deleted

    const createdAt = Date.now() - 31 * 86_400_000;
    const attId = insertExpiredAttachment('gone.mp4', filePath, createdAt);

    // Should not throw even though file doesn't exist
    const worker = startRecordingCleanupWorker(makeConfig({ defaultRetentionDays: 30 }));

    // Attachment record should still be cleaned up from DB
    const db = getDb();
    const remaining = db.query('SELECT id FROM attachments WHERE id = ?').get(attId);
    expect(remaining).toBeNull();

    worker.stop();
  });

  test('worker can be stopped cleanly', () => {
    const worker = startRecordingCleanupWorker(makeConfig());
    // Should not throw
    worker.stop();
    // Calling stop again should also be safe
    worker.stop();
  });
});
