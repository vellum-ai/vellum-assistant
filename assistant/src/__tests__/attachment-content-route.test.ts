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
  uploadFileBackedAttachment,
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
// handleGetAttachmentContent
// ---------------------------------------------------------------------------

describe('handleGetAttachmentContent', () => {
  beforeEach(resetTables);

  test('returns 404 for non-existent attachment', () => {
    const req = new Request('http://localhost/v1/attachments/nonexistent/content');
    const res = handleGetAttachmentContent('nonexistent', req);
    expect(res.status).toBe(404);
  });

  test('returns full content for base64 attachment without Range header', async () => {
    const data = Buffer.from('hello world').toString('base64');
    const stored = uploadAttachment('test.txt', 'text/plain', data);

    const req = new Request('http://localhost/v1/attachments/' + stored.id + '/content');
    const res = handleGetAttachmentContent(stored.id, req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');

    const body = await res.arrayBuffer();
    const text = new TextDecoder().decode(body);
    expect(text).toBe('hello world');
  });

  test('returns full content for file-backed attachment without Range header', async () => {
    const filePath = join(testDir, 'test-video.mp4');
    const content = 'fake video content for testing';
    writeFileSync(filePath, content);

    const stored = uploadFileBackedAttachment('test-video.mp4', 'video/mp4', filePath, content.length);

    const req = new Request('http://localhost/v1/attachments/' + stored.id + '/content');
    const res = handleGetAttachmentContent(stored.id, req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp4');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');

    const body = await res.arrayBuffer();
    const text = new TextDecoder().decode(body);
    expect(text).toBe(content);
  });

  test('returns 206 with correct Content-Range for range request on file-backed attachment', async () => {
    const filePath = join(testDir, 'test-range.mp4');
    const content = 'abcdefghijklmnopqrstuvwxyz';
    writeFileSync(filePath, content);

    const stored = uploadFileBackedAttachment('test-range.mp4', 'video/mp4', filePath, content.length);

    const req = new Request('http://localhost/v1/attachments/' + stored.id + '/content', {
      headers: { Range: 'bytes=0-4' },
    });
    const res = handleGetAttachmentContent(stored.id, req);

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-4/${content.length}`);
    expect(res.headers.get('Content-Length')).toBe('5');

    const body = await res.arrayBuffer();
    const text = new TextDecoder().decode(body);
    expect(text).toBe('abcde');
  });

  test('returns 206 with correct Content-Range for range request on base64 attachment', async () => {
    const originalContent = 'abcdefghijklmnopqrstuvwxyz';
    const data = Buffer.from(originalContent).toString('base64');
    const stored = uploadAttachment('test.txt', 'text/plain', data);

    const req = new Request('http://localhost/v1/attachments/' + stored.id + '/content', {
      headers: { Range: 'bytes=5-9' },
    });
    const res = handleGetAttachmentContent(stored.id, req);

    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 5-9/${originalContent.length}`);
    expect(res.headers.get('Content-Length')).toBe('5');

    const body = await res.arrayBuffer();
    const text = new TextDecoder().decode(body);
    expect(text).toBe('fghij');
  });

  test('returns 416 for invalid range beyond file size', () => {
    const filePath = join(testDir, 'test-small.mp4');
    writeFileSync(filePath, 'small');

    const stored = uploadFileBackedAttachment('test-small.mp4', 'video/mp4', filePath, 5);

    const req = new Request('http://localhost/v1/attachments/' + stored.id + '/content', {
      headers: { Range: 'bytes=100-200' },
    });
    const res = handleGetAttachmentContent(stored.id, req);

    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */5');
  });

  test('returns 416 for malformed Range header', () => {
    const filePath = join(testDir, 'test-malformed.mp4');
    writeFileSync(filePath, 'content');

    const stored = uploadFileBackedAttachment('test-malformed.mp4', 'video/mp4', filePath, 7);

    const req = new Request('http://localhost/v1/attachments/' + stored.id + '/content', {
      headers: { Range: 'invalid-range' },
    });
    const res = handleGetAttachmentContent(stored.id, req);

    expect(res.status).toBe(416);
  });
});
