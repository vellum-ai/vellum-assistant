import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'attach-content-test-'));

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
} from '../memory/attachments-store.js';
import { handleGetAttachmentContent } from '../runtime/routes/attachment-routes.js';

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
// handleGetAttachmentContent — full file content
// ---------------------------------------------------------------------------

describe('handleGetAttachmentContent — file-backed', () => {
  beforeEach(resetTables);

  test('returns full file content for non-range request', async () => {
    const filePath = join(testDir, 'test-video.mp4');
    const content = Buffer.from('fake video content for testing');
    writeFileSync(filePath, content);

    const attachment = createFileBackedAttachment({
      filename: 'test-video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: content.length,
      filePath,
    });

    const req = new Request('http://localhost/v1/attachments/' + attachment.id + '/content');
    const res = handleGetAttachmentContent(attachment.id, req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(res.headers.get('Content-Length')).toBe(String(content.length));
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Disposition')).toBe('inline');

    const body = await res.arrayBuffer();
    expect(Buffer.from(body).toString()).toBe(content.toString());
  });

  test('returns partial content for range request', async () => {
    const filePath = join(testDir, 'test-range.mp4');
    const content = Buffer.from('0123456789abcdef');
    writeFileSync(filePath, content);

    const attachment = createFileBackedAttachment({
      filename: 'test-range.mp4',
      mimeType: 'video/mp4',
      sizeBytes: content.length,
      filePath,
    });

    const req = new Request('http://localhost/v1/attachments/' + attachment.id + '/content', {
      headers: { Range: 'bytes=4-9' },
    });
    const res = handleGetAttachmentContent(attachment.id, req);

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 4-9/${content.length}`);
    expect(res.headers.get('Content-Length')).toBe('6');

    const body = await res.arrayBuffer();
    expect(Buffer.from(body).toString()).toBe('456789');
  });

  test('returns range with open-ended range header', async () => {
    const filePath = join(testDir, 'test-open-range.mp4');
    const content = Buffer.from('abcdefghij');
    writeFileSync(filePath, content);

    const attachment = createFileBackedAttachment({
      filename: 'test-open-range.mp4',
      mimeType: 'video/mp4',
      sizeBytes: content.length,
      filePath,
    });

    const req = new Request('http://localhost/v1/attachments/' + attachment.id + '/content', {
      headers: { Range: 'bytes=5-' },
    });
    const res = handleGetAttachmentContent(attachment.id, req);

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 5-9/${content.length}`);
    expect(res.headers.get('Content-Length')).toBe('5');

    const body = await res.arrayBuffer();
    expect(Buffer.from(body).toString()).toBe('fghij');
  });

  test('returns 416 for unsatisfiable range', () => {
    const filePath = join(testDir, 'test-416.mp4');
    const content = Buffer.from('short');
    writeFileSync(filePath, content);

    const attachment = createFileBackedAttachment({
      filename: 'test-416.mp4',
      mimeType: 'video/mp4',
      sizeBytes: content.length,
      filePath,
    });

    const req = new Request('http://localhost/v1/attachments/' + attachment.id + '/content', {
      headers: { Range: 'bytes=100-200' },
    });
    const res = handleGetAttachmentContent(attachment.id, req);

    expect(res.status).toBe(416);
  });

  test('returns 404 when file is missing from disk', () => {
    const attachment = createFileBackedAttachment({
      filename: 'missing.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 100,
      filePath: '/nonexistent/path/missing.mp4',
    });

    const req = new Request('http://localhost/v1/attachments/' + attachment.id + '/content');
    const res = handleGetAttachmentContent(attachment.id, req);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// handleGetAttachmentContent — 404 for non-existent
// ---------------------------------------------------------------------------

describe('handleGetAttachmentContent — 404', () => {
  beforeEach(resetTables);

  test('returns 404 for non-existent attachment', () => {
    const req = new Request('http://localhost/v1/attachments/nonexistent/content');
    const res = handleGetAttachmentContent('nonexistent', req);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// handleGetAttachmentContent — inline_base64 fallback
// ---------------------------------------------------------------------------

describe('handleGetAttachmentContent — inline_base64 fallback', () => {
  beforeEach(resetTables);

  test('decodes and returns inline base64 content', async () => {
    const originalText = 'hello world';
    const base64 = Buffer.from(originalText).toString('base64');
    const stored = uploadAttachment('hello.txt', 'text/plain', base64);

    const req = new Request('http://localhost/v1/attachments/' + stored.id + '/content');
    const res = handleGetAttachmentContent(stored.id, req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');

    const body = await res.text();
    expect(body).toBe(originalText);
  });
});
