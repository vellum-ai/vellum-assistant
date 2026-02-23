import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'file-backed-attach-test-'));

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
  getAttachmentById,
  getAttachmentsByIds,
  createFileBackedAttachment,
  getExpiredFileAttachments,
  deleteFileBackedAttachment,
} from '../memory/attachments-store.js';

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
// createFileBackedAttachment
// ---------------------------------------------------------------------------

describe('createFileBackedAttachment', () => {
  beforeEach(resetTables);

  test('creates correct DB record with file metadata', () => {
    const result = createFileBackedAttachment({
      filename: 'recording.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 50_000_000,
      filePath: '/data/recordings/recording.mp4',
      sha256: 'abc123def456',
      expiresAt: Date.now() + 86400000,
    });

    expect(result.id).toBeDefined();
    expect(result.originalFilename).toBe('recording.mp4');
    expect(result.mimeType).toBe('video/mp4');
    expect(result.sizeBytes).toBe(50_000_000);
    expect(result.kind).toBe('video');
    expect(result.storageKind).toBe('file');
    expect(result.filePath).toBe('/data/recordings/recording.mp4');
    expect(result.sha256).toBe('abc123def456');
    expect(result.expiresAt).toBeGreaterThan(0);
    expect(result.createdAt).toBeGreaterThan(0);
  });

  test('handles optional fields gracefully', () => {
    const result = createFileBackedAttachment({
      filename: 'screenshot.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      filePath: '/data/screenshots/shot.png',
    });

    expect(result.sha256).toBeNull();
    expect(result.expiresAt).toBeNull();
    expect(result.thumbnailBase64).toBeNull();
  });

  test('stores thumbnail when provided', () => {
    const result = createFileBackedAttachment({
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 10_000,
      filePath: '/data/video.mp4',
      thumbnailBase64: 'iVBORw0KGgoAAAANSUh',
    });

    expect(result.thumbnailBase64).toBe('iVBORw0KGgoAAAANSUh');
  });

  test('classifies kind from mime type', () => {
    const image = createFileBackedAttachment({
      filename: 'pic.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      filePath: '/data/pic.png',
    });
    expect(image.kind).toBe('image');

    const video = createFileBackedAttachment({
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 100,
      filePath: '/data/clip.mp4',
    });
    expect(video.kind).toBe('video');

    const doc = createFileBackedAttachment({
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      filePath: '/data/doc.pdf',
    });
    expect(doc.kind).toBe('document');
  });
});

// ---------------------------------------------------------------------------
// getAttachmentById returns file metadata for file-backed attachments
// ---------------------------------------------------------------------------

describe('getAttachmentById with file-backed attachments', () => {
  beforeEach(resetTables);

  test('returns file metadata for file-backed attachments', () => {
    const created = createFileBackedAttachment({
      filename: 'recording.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 50_000_000,
      filePath: '/data/recording.mp4',
      sha256: 'abc123',
      expiresAt: 1234567890,
    });

    const fetched = getAttachmentById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.storageKind).toBe('file');
    expect(fetched!.filePath).toBe('/data/recording.mp4');
    expect(fetched!.sha256).toBe('abc123');
    expect(fetched!.expiresAt).toBe(1234567890);
    expect(fetched!.dataBase64).toBe('');
  });

  test('returns inline_base64 for traditional attachments', () => {
    const created = uploadAttachment('chart.png', 'image/png', 'iVBORw0K');

    const fetched = getAttachmentById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.storageKind).toBe('inline_base64');
    expect(fetched!.filePath).toBeNull();
    expect(fetched!.sha256).toBeNull();
    expect(fetched!.expiresAt).toBeNull();
    expect(fetched!.dataBase64).toBe('iVBORw0K');
  });
});

// ---------------------------------------------------------------------------
// getAttachmentsByIds with mixed types
// ---------------------------------------------------------------------------

describe('getAttachmentsByIds with mixed types', () => {
  beforeEach(resetTables);

  test('returns both inline and file-backed attachments', () => {
    const inline = uploadAttachment('doc.pdf', 'application/pdf', 'JVBER');
    const fileBacked = createFileBackedAttachment({
      filename: 'video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 5000,
      filePath: '/data/video.mp4',
    });

    const results = getAttachmentsByIds([inline.id, fileBacked.id]);
    expect(results).toHaveLength(2);

    const inlineResult = results.find((r) => r.id === inline.id);
    expect(inlineResult!.storageKind).toBe('inline_base64');
    expect(inlineResult!.dataBase64).toBe('JVBER');

    const fileResult = results.find((r) => r.id === fileBacked.id);
    expect(fileResult!.storageKind).toBe('file');
    expect(fileResult!.filePath).toBe('/data/video.mp4');
  });
});

// ---------------------------------------------------------------------------
// getExpiredFileAttachments
// ---------------------------------------------------------------------------

describe('getExpiredFileAttachments', () => {
  beforeEach(resetTables);

  test('returns only expired file attachments', () => {
    const now = Date.now();

    // Expired
    createFileBackedAttachment({
      filename: 'old.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 100,
      filePath: '/data/old.mp4',
      expiresAt: now - 10000,
    });

    // Not expired
    createFileBackedAttachment({
      filename: 'new.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 100,
      filePath: '/data/new.mp4',
      expiresAt: now + 86400000,
    });

    // No expiry
    createFileBackedAttachment({
      filename: 'permanent.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 100,
      filePath: '/data/permanent.mp4',
    });

    // Inline base64 (should never be returned)
    uploadAttachment('inline.txt', 'text/plain', 'AAAA');

    const expired = getExpiredFileAttachments();
    expect(expired).toHaveLength(1);
    expect(expired[0].filePath).toBe('/data/old.mp4');
  });

  test('returns empty when no expired attachments', () => {
    createFileBackedAttachment({
      filename: 'future.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 100,
      filePath: '/data/future.mp4',
      expiresAt: Date.now() + 86400000,
    });

    const expired = getExpiredFileAttachments();
    expect(expired).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deleteFileBackedAttachment
// ---------------------------------------------------------------------------

describe('deleteFileBackedAttachment', () => {
  beforeEach(resetTables);

  test('deletes existing file-backed attachment', () => {
    const created = createFileBackedAttachment({
      filename: 'recording.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 100,
      filePath: '/data/recording.mp4',
    });

    const result = deleteFileBackedAttachment(created.id);
    expect(result).toBe('deleted');

    const fetched = getAttachmentById(created.id);
    expect(fetched).toBeNull();
  });

  test('returns not_found for nonexistent attachment', () => {
    const result = deleteFileBackedAttachment('nonexistent-id');
    expect(result).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: existing base64 attachments still work
// ---------------------------------------------------------------------------

describe('backward compatibility', () => {
  beforeEach(resetTables);

  test('existing uploadAttachment still works correctly', () => {
    const stored = uploadAttachment('chart.png', 'image/png', 'iVBORw0K');
    expect(stored.id).toBeDefined();
    expect(stored.storageKind).toBe('inline_base64');
    expect(stored.filePath).toBeNull();

    const fetched = getAttachmentById(stored.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.dataBase64).toBe('iVBORw0K');
    expect(fetched!.storageKind).toBe('inline_base64');
  });

  test('deduplication still works for inline base64', () => {
    const first = uploadAttachment('a.png', 'image/png', 'DUPEDATA');
    const second = uploadAttachment('b.png', 'image/png', 'DUPEDATA');
    expect(first.id).toBe(second.id);
  });
});
