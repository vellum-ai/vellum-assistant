import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
import {
  uploadAttachment,
  createFileBackedAttachment,
  getAttachmentById,
  getExpiredFileAttachments,
} from '../memory/attachments-store.js';
import { runCleanupPass } from '../daemon/recording-cleanup.js';

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

// ---------------------------------------------------------------------------
// Cleanup pass tests
// ---------------------------------------------------------------------------

describe('runCleanupPass', () => {
  beforeEach(resetTables);

  test('deletes expired file-backed attachments and their files', () => {
    const now = Date.now();
    const recordingsDir = join(testDir, 'recordings');
    mkdirSync(recordingsDir, { recursive: true });

    // Create a file on disk
    const filePath = join(recordingsDir, 'expired-recording.mp4');
    writeFileSync(filePath, Buffer.alloc(1024, 0)); // 1 KB dummy file

    // Create expired file-backed attachment
    const expired = createFileBackedAttachment({
      filename: 'expired-recording.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
      filePath,
      expiresAt: now - 10000, // expired 10 seconds ago
    });

    // Verify file exists before cleanup
    expect(existsSync(filePath)).toBe(true);

    const result = runCleanupPass();

    expect(result.cleaned).toBe(1);
    expect(result.bytesFreed).toBe(1024);

    // File should be removed from disk
    expect(existsSync(filePath)).toBe(false);

    // DB row should be removed
    expect(getAttachmentById(expired.id)).toBeNull();
  });

  test('does not touch non-expired file-backed attachments', () => {
    const now = Date.now();
    const recordingsDir = join(testDir, 'recordings');
    mkdirSync(recordingsDir, { recursive: true });

    const filePath = join(recordingsDir, 'fresh-recording.mp4');
    writeFileSync(filePath, Buffer.alloc(512, 0));

    const fresh = createFileBackedAttachment({
      filename: 'fresh-recording.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 512,
      filePath,
      expiresAt: now + 86400000, // expires tomorrow
    });

    const result = runCleanupPass();

    expect(result.cleaned).toBe(0);
    expect(result.bytesFreed).toBe(0);

    // File should still exist
    expect(existsSync(filePath)).toBe(true);

    // DB row should still exist
    expect(getAttachmentById(fresh.id)).not.toBeNull();
  });

  test('never touches inline_base64 attachments', () => {
    // Create an inline base64 attachment
    const inline = uploadAttachment('chart.png', 'image/png', 'iVBORw0K');

    const result = runCleanupPass();

    expect(result.cleaned).toBe(0);

    // Inline attachment should still exist
    expect(getAttachmentById(inline.id)).not.toBeNull();
  });

  test('handles missing files gracefully (file already deleted)', () => {
    const now = Date.now();

    // Create expired attachment pointing to a non-existent file
    const expired = createFileBackedAttachment({
      filename: 'ghost-recording.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 2048,
      filePath: join(testDir, 'nonexistent', 'ghost.mp4'),
      expiresAt: now - 10000,
    });

    const result = runCleanupPass();

    // Should still clean up the DB row even if the file is missing
    expect(result.cleaned).toBe(1);
    expect(result.bytesFreed).toBe(0); // no file to measure

    expect(getAttachmentById(expired.id)).toBeNull();
  });

  test('cleans up multiple expired recordings in one pass', () => {
    const now = Date.now();
    const recordingsDir = join(testDir, 'recordings-multi');
    mkdirSync(recordingsDir, { recursive: true });

    const fileA = join(recordingsDir, 'a.mp4');
    const fileB = join(recordingsDir, 'b.mp4');
    writeFileSync(fileA, Buffer.alloc(2048, 0));
    writeFileSync(fileB, Buffer.alloc(4096, 0));

    createFileBackedAttachment({
      filename: 'a.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 2048,
      filePath: fileA,
      expiresAt: now - 5000,
    });

    createFileBackedAttachment({
      filename: 'b.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 4096,
      filePath: fileB,
      expiresAt: now - 3000,
    });

    // Also add a non-expired one
    const fileC = join(recordingsDir, 'c.mp4');
    writeFileSync(fileC, Buffer.alloc(1024, 0));
    createFileBackedAttachment({
      filename: 'c.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
      filePath: fileC,
      expiresAt: now + 86400000,
    });

    const result = runCleanupPass();

    expect(result.cleaned).toBe(2);
    expect(result.bytesFreed).toBe(2048 + 4096);

    // Expired files gone
    expect(existsSync(fileA)).toBe(false);
    expect(existsSync(fileB)).toBe(false);

    // Non-expired file still present
    expect(existsSync(fileC)).toBe(true);
  });

  test('returns zeros when no expired attachments exist', () => {
    const result = runCleanupPass();
    expect(result.cleaned).toBe(0);
    expect(result.bytesFreed).toBe(0);
  });

  test('file-backed attachments without expiresAt are never cleaned', () => {
    const recordingsDir = join(testDir, 'recordings-no-expiry');
    mkdirSync(recordingsDir, { recursive: true });

    const filePath = join(recordingsDir, 'permanent.mp4');
    writeFileSync(filePath, Buffer.alloc(256, 0));

    const permanent = createFileBackedAttachment({
      filename: 'permanent.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 256,
      filePath,
      // No expiresAt — should never be cleaned
    });

    const result = runCleanupPass();

    expect(result.cleaned).toBe(0);
    expect(existsSync(filePath)).toBe(true);
    expect(getAttachmentById(permanent.id)).not.toBeNull();
  });
});
