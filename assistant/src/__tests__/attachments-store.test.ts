import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'attach-store-test-'));

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

import { initializeDb, getDb } from '../memory/db.js';
import {
  uploadAttachment,
  deleteAttachment,
  getAttachmentsByIds,
  getAttachmentById,
  linkAttachmentToMessage,
  getAttachmentsForMessage,
  getAttachmentsForMessageUnscoped,
  deleteOrphanAttachments,
} from '../memory/attachments-store.js';
import { createConversation, addMessage } from '../memory/conversation-store.js';

initializeDb();

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

function resetTables() {
  const db = getDb();
  db.run('DELETE FROM message_attachments');
  db.run('DELETE FROM attachments');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
}

// ---------------------------------------------------------------------------
// uploadAttachment
// ---------------------------------------------------------------------------

describe('uploadAttachment', () => {
  beforeEach(resetTables);

  test('stores attachment and returns metadata', () => {
    const stored = uploadAttachment('ast-1', 'chart.png', 'image/png', 'iVBORw0K');

    expect(stored.id).toBeDefined();
    expect(stored.assistantId).toBe('ast-1');
    expect(stored.originalFilename).toBe('chart.png');
    expect(stored.mimeType).toBe('image/png');
    expect(stored.kind).toBe('image');
    expect(stored.sizeBytes).toBeGreaterThan(0);
    expect(stored.createdAt).toBeGreaterThan(0);
  });

  test('classifies image MIME as image kind', () => {
    const stored = uploadAttachment('ast-1', 'pic.jpg', 'image/jpeg', 'AAAA');
    expect(stored.kind).toBe('image');
  });

  test('classifies non-image MIME as document kind', () => {
    const stored = uploadAttachment('ast-1', 'doc.pdf', 'application/pdf', 'JVBER');
    expect(stored.kind).toBe('document');
  });

  test('generates unique IDs for each upload', () => {
    const a = uploadAttachment('ast-1', 'a.txt', 'text/plain', 'AA==');
    const b = uploadAttachment('ast-1', 'b.txt', 'text/plain', 'QQ==');
    expect(a.id).not.toBe(b.id);
  });

  test('computes sizeBytes from base64 correctly', () => {
    // "hello" = "aGVsbG8=" (8 chars, 1 pad → 5 bytes)
    const stored = uploadAttachment('ast-1', 'hello.txt', 'text/plain', 'aGVsbG8=');
    expect(stored.sizeBytes).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// deleteAttachment
// ---------------------------------------------------------------------------

describe('deleteAttachment', () => {
  beforeEach(resetTables);

  test('deletes existing attachment and returns true', () => {
    const stored = uploadAttachment('ast-1', 'file.txt', 'text/plain', 'dGVzdA==');
    const result = deleteAttachment('ast-1', stored.id);
    expect(result).toBe(true);

    const fetched = getAttachmentById('ast-1', stored.id);
    expect(fetched).toBeNull();
  });

  test('returns false for nonexistent attachment', () => {
    const result = deleteAttachment('ast-1', 'nonexistent-id');
    expect(result).toBe(false);
  });

  test('returns false when assistantId does not match', () => {
    const stored = uploadAttachment('ast-owner', 'file.txt', 'text/plain', 'dGVzdA==');
    const result = deleteAttachment('ast-other', stored.id);
    expect(result).toBe(false);

    // Original still exists
    const fetched = getAttachmentById('ast-owner', stored.id);
    expect(fetched).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAttachmentsByIds
// ---------------------------------------------------------------------------

describe('getAttachmentsByIds', () => {
  beforeEach(resetTables);

  test('returns matching attachments with data', () => {
    const a = uploadAttachment('ast-1', 'a.txt', 'text/plain', 'AAAA');
    const b = uploadAttachment('ast-1', 'b.txt', 'text/plain', 'BBBB');

    const results = getAttachmentsByIds('ast-1', [a.id, b.id]);
    expect(results).toHaveLength(2);
    expect(results[0].dataBase64).toBe('AAAA');
    expect(results[1].dataBase64).toBe('BBBB');
  });

  test('returns empty array for empty IDs list', () => {
    const results = getAttachmentsByIds('ast-1', []);
    expect(results).toHaveLength(0);
  });

  test('skips IDs that do not exist', () => {
    const a = uploadAttachment('ast-1', 'a.txt', 'text/plain', 'AAAA');
    const results = getAttachmentsByIds('ast-1', [a.id, 'nonexistent']);
    expect(results).toHaveLength(1);
  });

  test('enforces assistantId scoping', () => {
    const a = uploadAttachment('ast-owner', 'a.txt', 'text/plain', 'AAAA');
    const results = getAttachmentsByIds('ast-other', [a.id]);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getAttachmentById
// ---------------------------------------------------------------------------

describe('getAttachmentById', () => {
  beforeEach(resetTables);

  test('returns attachment with data when found', () => {
    const stored = uploadAttachment('ast-1', 'report.pdf', 'application/pdf', 'JVBER');
    const result = getAttachmentById('ast-1', stored.id);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(stored.id);
    expect(result!.originalFilename).toBe('report.pdf');
    expect(result!.dataBase64).toBe('JVBER');
  });

  test('returns null for wrong assistantId', () => {
    const stored = uploadAttachment('ast-1', 'file.txt', 'text/plain', 'dGVzdA==');
    const result = getAttachmentById('ast-other', stored.id);
    expect(result).toBeNull();
  });

  test('returns null for nonexistent ID', () => {
    const result = getAttachmentById('ast-1', 'no-such-id');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// linkAttachmentToMessage + getAttachmentsForMessage
// ---------------------------------------------------------------------------

describe('linkAttachmentToMessage + getAttachmentsForMessage', () => {
  beforeEach(resetTables);

  test('links attachment and retrieves it by message', () => {
    const conv = createConversation();
    const msg = addMessage(conv.id, 'assistant', 'Here is a chart');
    const stored = uploadAttachment('ast-1', 'chart.png', 'image/png', 'iVBORw0K');

    linkAttachmentToMessage(msg.id, stored.id, 0);

    const linked = getAttachmentsForMessage(msg.id, 'ast-1');
    expect(linked).toHaveLength(1);
    expect(linked[0].id).toBe(stored.id);
    expect(linked[0].originalFilename).toBe('chart.png');
    expect(linked[0].dataBase64).toBe('iVBORw0K');
  });

  test('returns attachments in position order', () => {
    const conv = createConversation();
    const msg = addMessage(conv.id, 'assistant', 'Multiple files');
    const a = uploadAttachment('ast-1', 'first.txt', 'text/plain', 'AAAA');
    const b = uploadAttachment('ast-1', 'second.txt', 'text/plain', 'BBBB');

    // Link in reverse order
    linkAttachmentToMessage(msg.id, b.id, 1);
    linkAttachmentToMessage(msg.id, a.id, 0);

    const linked = getAttachmentsForMessage(msg.id, 'ast-1');
    expect(linked).toHaveLength(2);
    expect(linked[0].originalFilename).toBe('first.txt');
    expect(linked[1].originalFilename).toBe('second.txt');
  });

  test('returns empty for message with no attachments', () => {
    const conv = createConversation();
    const msg = addMessage(conv.id, 'assistant', 'No attachments');

    const linked = getAttachmentsForMessage(msg.id, 'ast-1');
    expect(linked).toHaveLength(0);
  });

  test('enforces assistantId scoping on retrieval', () => {
    const conv = createConversation();
    const msg = addMessage(conv.id, 'assistant', 'Scoped');
    const stored = uploadAttachment('ast-owner', 'secret.txt', 'text/plain', 'c2VjcmV0');

    linkAttachmentToMessage(msg.id, stored.id, 0);

    const wrongScope = getAttachmentsForMessage(msg.id, 'ast-other');
    expect(wrongScope).toHaveLength(0);

    const rightScope = getAttachmentsForMessage(msg.id, 'ast-owner');
    expect(rightScope).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getAttachmentsForMessageUnscoped
// ---------------------------------------------------------------------------

describe('getAttachmentsForMessageUnscoped', () => {
  beforeEach(resetTables);

  test('returns attachments without assistant scoping', () => {
    const conv = createConversation();
    const msg = addMessage(conv.id, 'assistant', 'Desktop history');
    const stored = uploadAttachment('ast-1', 'result.png', 'image/png', 'iVBORw0K');

    linkAttachmentToMessage(msg.id, stored.id, 0);

    const linked = getAttachmentsForMessageUnscoped(msg.id);
    expect(linked).toHaveLength(1);
    expect(linked[0].id).toBe(stored.id);
  });

  test('returns empty for message with no links', () => {
    const conv = createConversation();
    const msg = addMessage(conv.id, 'assistant', 'Nothing here');

    const linked = getAttachmentsForMessageUnscoped(msg.id);
    expect(linked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deleteOrphanAttachments
// ---------------------------------------------------------------------------

describe('deleteOrphanAttachments', () => {
  beforeEach(resetTables);

  test('removes candidate attachments with no message links', () => {
    const stored = uploadAttachment('ast-1', 'orphan.txt', 'text/plain', 'ZGF0YQ==');

    const removed = deleteOrphanAttachments([stored.id]);
    expect(removed).toBe(1);
  });

  test('preserves attachments that are still linked', () => {
    const conv = createConversation();
    const msg = addMessage(conv.id, 'assistant', 'With attachment');
    const stored = uploadAttachment('ast-1', 'linked.txt', 'text/plain', 'ZGF0YQ==');
    linkAttachmentToMessage(msg.id, stored.id, 0);

    const removed = deleteOrphanAttachments([stored.id]);
    expect(removed).toBe(0);

    const fetched = getAttachmentById('ast-1', stored.id);
    expect(fetched).not.toBeNull();
  });

  test('removes only orphans when mixed candidates provided', () => {
    const conv = createConversation();
    const msg = addMessage(conv.id, 'assistant', 'Mixed');
    const linked = uploadAttachment('ast-1', 'linked.txt', 'text/plain', 'AAAA');
    const orphan = uploadAttachment('ast-1', 'orphan.txt', 'text/plain', 'BBBB');
    linkAttachmentToMessage(msg.id, linked.id, 0);

    const removed = deleteOrphanAttachments([linked.id, orphan.id]);
    expect(removed).toBe(1);

    const remaining = getAttachmentById('ast-1', linked.id);
    expect(remaining).not.toBeNull();
  });

  test('returns 0 when no candidates provided', () => {
    const removed = deleteOrphanAttachments([]);
    expect(removed).toBe(0);
  });

  test('does not delete attachments outside the candidate set', () => {
    const unrelated = uploadAttachment('ast-1', 'unrelated.txt', 'text/plain', 'AAAA');
    const candidate = uploadAttachment('ast-1', 'candidate.txt', 'text/plain', 'BBBB');

    const removed = deleteOrphanAttachments([candidate.id]);
    expect(removed).toBe(1);

    // The unrelated attachment should still exist
    const fetched = getAttachmentById('ast-1', unrelated.id);
    expect(fetched).not.toBeNull();
  });
});
