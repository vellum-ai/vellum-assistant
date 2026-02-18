import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'asset-search-test-'));

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
import { uploadAttachment, linkAttachmentToMessage } from '../memory/attachments-store.js';
import { createConversation, addMessage } from '../memory/conversation-store.js';
import { searchAttachments } from '../tools/assets/search.js';
import type { ToolContext } from '../tools/types.js';

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

// Seed data helpers
function seedAttachments() {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000 - 1000;
  const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
  const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;

  // Force createdAt by uploading then manipulating the DB
  const db = getDb();

  const png1 = uploadAttachment('ast-1', 'selfie.png', 'image/png', 'AAAA');
  const jpg1 = uploadAttachment('ast-1', 'photo.jpg', 'image/jpeg', 'BBBB');
  const pdf1 = uploadAttachment('ast-1', 'report.pdf', 'application/pdf', 'CCCC');
  const png2 = uploadAttachment('ast-1', 'screenshot.png', 'image/png', 'DDDD');

  // Backdate some attachments for recency testing
  db.run(`UPDATE attachments SET created_at = ${oneDayAgo} WHERE id = '${jpg1.id}'`);
  db.run(`UPDATE attachments SET created_at = ${tenDaysAgo} WHERE id = '${pdf1.id}'`);
  db.run(`UPDATE attachments SET created_at = ${sixtyDaysAgo} WHERE id = '${png2.id}'`);

  return { png1, jpg1, pdf1, png2, now, oneDayAgo, tenDaysAgo, sixtyDaysAgo };
}

const dummyContext: ToolContext = {
  workingDir: '/tmp',
  sessionId: 'sess-test',
  conversationId: 'conv-test',
};

// ---------------------------------------------------------------------------
// searchAttachments (unit tests on the query function)
// ---------------------------------------------------------------------------

describe('searchAttachments', () => {
  beforeEach(resetTables);

  test('returns all attachments when no filters provided', () => {
    seedAttachments();
    const results = searchAttachments({});
    expect(results.length).toBe(4);
  });

  test('filters by exact MIME type', () => {
    seedAttachments();
    const results = searchAttachments({ mime_type: 'application/pdf' });
    expect(results.length).toBe(1);
    expect(results[0].mimeType).toBe('application/pdf');
  });

  test('filters by MIME type wildcard (image/*)', () => {
    seedAttachments();
    const results = searchAttachments({ mime_type: 'image/*' });
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.mimeType.startsWith('image/')).toBe(true);
    }
  });

  test('filters by filename substring', () => {
    seedAttachments();
    const results = searchAttachments({ filename: 'selfie' });
    expect(results.length).toBe(1);
    expect(results[0].originalFilename).toBe('selfie.png');
  });

  test('filename search is case-insensitive via LIKE', () => {
    seedAttachments();
    // SQLite LIKE is case-insensitive for ASCII by default
    const results = searchAttachments({ filename: 'SELFIE' });
    expect(results.length).toBe(1);
  });

  test('filters by recency: last_24_hours', () => {
    seedAttachments();
    const results = searchAttachments({ recency: 'last_24_hours' });
    // Only selfie.png was uploaded "now" (not backdated past 24h)
    expect(results.length).toBe(1);
    expect(results[0].originalFilename).toBe('selfie.png');
  });

  test('filters by recency: last_7_days', () => {
    seedAttachments();
    const results = searchAttachments({ recency: 'last_7_days' });
    // selfie.png (now) and photo.jpg (1 day ago)
    expect(results.length).toBe(2);
  });

  test('filters by recency: last_30_days', () => {
    seedAttachments();
    const results = searchAttachments({ recency: 'last_30_days' });
    // selfie.png (now), photo.jpg (1 day ago), report.pdf (10 days ago)
    expect(results.length).toBe(3);
  });

  test('filters by recency: last_90_days', () => {
    seedAttachments();
    const results = searchAttachments({ recency: 'last_90_days' });
    // All 4 attachments are within 90 days
    expect(results.length).toBe(4);
  });

  test('combines mime_type and filename filters', () => {
    seedAttachments();
    const results = searchAttachments({ mime_type: 'image/*', filename: 'selfie' });
    expect(results.length).toBe(1);
    expect(results[0].originalFilename).toBe('selfie.png');
  });

  test('combines mime_type and recency filters', () => {
    seedAttachments();
    const results = searchAttachments({ mime_type: 'image/*', recency: 'last_24_hours' });
    expect(results.length).toBe(1);
    expect(results[0].originalFilename).toBe('selfie.png');
  });

  test('respects limit parameter', () => {
    seedAttachments();
    const results = searchAttachments({ limit: 2 });
    expect(results.length).toBe(2);
  });

  test('caps limit at MAX_RESULTS (100)', () => {
    seedAttachments();
    const results = searchAttachments({ limit: 500 });
    // We only have 4 attachments so we just verify it doesn't error
    expect(results.length).toBe(4);
  });

  test('returns results ordered by createdAt desc (most recent first)', () => {
    seedAttachments();
    const results = searchAttachments({});
    // selfie.png is most recent (now), then photo.jpg (1 day ago), etc.
    expect(results[0].originalFilename).toBe('selfie.png');
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].createdAt).toBeGreaterThanOrEqual(results[i].createdAt);
    }
  });

  test('returns empty array when no matches', () => {
    seedAttachments();
    const results = searchAttachments({ filename: 'nonexistent' });
    expect(results.length).toBe(0);
  });

  test('does not return base64 data in results', () => {
    seedAttachments();
    const results = searchAttachments({}) as Array<Record<string, unknown>>;
    for (const r of results) {
      expect(r.dataBase64).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// searchAttachments with conversation_id
// ---------------------------------------------------------------------------

describe('searchAttachments with conversation_id', () => {
  beforeEach(resetTables);

  test('returns only attachments linked to the specified conversation', () => {
    const png1 = uploadAttachment('ast-1', 'in-conv.png', 'image/png', 'AAAA');
    const png2 = uploadAttachment('ast-1', 'other-conv.png', 'image/png', 'BBBB');

    const conv1 = createConversation();
    const conv2 = createConversation();
    const msg1 = addMessage(conv1.id, 'user', 'First conv');
    const msg2 = addMessage(conv2.id, 'user', 'Second conv');

    linkAttachmentToMessage(msg1.id, png1.id, 0);
    linkAttachmentToMessage(msg2.id, png2.id, 0);

    const results = searchAttachments({ conversation_id: conv1.id });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(png1.id);
  });

  test('returns empty when conversation has no attachments', () => {
    uploadAttachment('ast-1', 'orphan.png', 'image/png', 'AAAA');
    const conv = createConversation();
    addMessage(conv.id, 'user', 'No attachments here');

    const results = searchAttachments({ conversation_id: conv.id });
    expect(results.length).toBe(0);
  });

  test('returns empty for nonexistent conversation_id', () => {
    uploadAttachment('ast-1', 'file.png', 'image/png', 'AAAA');
    const results = searchAttachments({ conversation_id: 'conv-nonexistent' });
    expect(results.length).toBe(0);
  });

  test('combines conversation_id with mime_type filter', () => {
    const png = uploadAttachment('ast-1', 'image.png', 'image/png', 'AAAA');
    const pdf = uploadAttachment('ast-1', 'doc.pdf', 'application/pdf', 'BBBB');

    const conv = createConversation();
    const msg = addMessage(conv.id, 'user', 'Both types');

    linkAttachmentToMessage(msg.id, png.id, 0);
    linkAttachmentToMessage(msg.id, pdf.id, 1);

    const results = searchAttachments({ conversation_id: conv.id, mime_type: 'image/*' });
    expect(results.length).toBe(1);
    expect(results[0].mimeType).toBe('image/png');
  });

  test('combines conversation_id with filename filter', () => {
    const a = uploadAttachment('ast-1', 'target.png', 'image/png', 'AAAA');
    const b = uploadAttachment('ast-1', 'other.png', 'image/png', 'BBBB');

    const conv = createConversation();
    const msg = addMessage(conv.id, 'user', 'Both');

    linkAttachmentToMessage(msg.id, a.id, 0);
    linkAttachmentToMessage(msg.id, b.id, 1);

    const results = searchAttachments({ conversation_id: conv.id, filename: 'target' });
    expect(results.length).toBe(1);
    expect(results[0].originalFilename).toBe('target.png');
  });
});

// ---------------------------------------------------------------------------
// AssetSearchTool.execute (integration test via tool interface)
// ---------------------------------------------------------------------------

describe('AssetSearchTool.execute', () => {
  beforeEach(resetTables);

  // Import the tool instance
  let tool: import('../tools/types.js').Tool;
  beforeEach(async () => {
    const mod = await import('../tools/assets/search.js');
    tool = mod.assetSearchTool;
  });

  test('returns formatted results for matching assets', async () => {
    uploadAttachment('ast-1', 'selfie.png', 'image/png', 'AAAA');
    const result = await tool.execute({}, dummyContext);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('selfie.png');
    expect(result.content).toContain('Found 1 asset(s)');
  });

  test('returns no-match message when nothing found', async () => {
    const result = await tool.execute({ filename: 'nonexistent' }, dummyContext);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('No assets found');
  });

  test('returns error for invalid recency value', async () => {
    const result = await tool.execute({ recency: 'last_year' }, dummyContext);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid recency value');
  });

  test('returns error for invalid limit', async () => {
    const result = await tool.execute({ limit: -1 }, dummyContext);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('limit must be a positive number');
  });

  test('includes attachment ID in output', async () => {
    const stored = uploadAttachment('ast-1', 'chart.png', 'image/png', 'AAAA');
    const result = await tool.execute({}, dummyContext);
    expect(result.isError).toBe(false);
    expect(result.content).toContain(stored.id);
  });

  test('includes MIME type and kind in output', async () => {
    uploadAttachment('ast-1', 'chart.png', 'image/png', 'AAAA');
    const result = await tool.execute({}, dummyContext);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('image/png');
    expect(result.content).toContain('image');
  });

  test('tool definition has correct name and schema', () => {
    const def = tool.getDefinition();
    expect(def.name).toBe('asset_search');
    expect(def.input_schema.properties).toHaveProperty('mime_type');
    expect(def.input_schema.properties).toHaveProperty('filename');
    expect(def.input_schema.properties).toHaveProperty('recency');
    expect(def.input_schema.properties).toHaveProperty('conversation_id');
    expect(def.input_schema.properties).toHaveProperty('limit');
    expect(def.input_schema.required).toEqual([]);
  });

  test('tool has LOW risk level', () => {
    expect(tool.defaultRiskLevel).toBe('low');
  });

  test('tool category is assets', () => {
    expect(tool.category).toBe('assets');
  });
});
