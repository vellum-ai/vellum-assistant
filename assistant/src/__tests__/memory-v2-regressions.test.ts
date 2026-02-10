import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'memory-v2-regressions-'));

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
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import { and, eq } from 'drizzle-orm';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { extractAndUpsertMemoryItemsForMessage } from '../memory/items-extractor.js';
import {
  buildMemoryRecall,
  injectMemoryRecallIntoUserMessage,
  stripMemoryRecallMessages,
} from '../memory/retriever.js';
import { conversations, memoryItems, messages } from '../memory/schema.js';

describe('Memory V2 regressions', () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM memory_item_sources');
    db.run('DELETE FROM memory_embeddings');
    db.run('DELETE FROM memory_summaries');
    db.run('DELETE FROM memory_items');
    db.run('DELETE FROM memory_segment_fts');
    db.run('DELETE FROM memory_segments');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
    db.run('DELETE FROM memory_jobs');
    db.run('DELETE FROM memory_checkpoints');
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best effort cleanup
    }
  });

  test('lexical recall accepts punctuation-heavy user queries without degrading', async () => {
    const db = getDb();
    const createdAt = 1_700_000_000_000;
    db.insert(conversations).values({
      id: 'conv-1',
      title: null,
      createdAt,
      updatedAt: createdAt,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      contextSummary: null,
      contextCompactedMessageCount: 0,
      contextCompactedAt: null,
    }).run();
    db.insert(messages).values({
      id: 'msg-1',
      conversationId: 'conv-1',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'error timeout in src index ts' }]),
      createdAt,
    }).run();
    db.run(`
      INSERT INTO memory_segments (
        id, message_id, conversation_id, role, segment_index, text, token_estimate, created_at, updated_at
      ) VALUES (
        'seg-1', 'msg-1', 'conv-1', 'user', 0, 'error timeout in src index ts', 8, ${createdAt}, ${createdAt}
      )
    `);

    const config = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          required: false,
        },
      },
    };

    const recall = await buildMemoryRecall('error: timeout src/index.ts foo-bar', 'conv-1', config);
    expect(recall.degraded).toBe(false);
    expect(recall.lexicalHits).toBeGreaterThan(0);
  });

  test('memory recall injection remains user-role and is stripped from runtime history', () => {
    const originalUserMessage = {
      role: 'user' as const,
      content: [{ type: 'text', text: 'Actual user request' }],
    };
    const injected = injectMemoryRecallIntoUserMessage(
      originalUserMessage,
      '[Memory Recall v1]\n- [item:abc] user prefers concise answers',
    );

    expect(injected.role).toBe('user');
    expect(injected.content[0]).toEqual({
      type: 'text',
      text: '[Memory Recall v1]\n- [item:abc] user prefers concise answers',
    });

    const cleaned = stripMemoryRecallMessages([injected]);
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toEqual(originalUserMessage);
  });

  test('memory item lastSeenAt follows message.createdAt and does not move backwards', () => {
    const db = getDb();
    db.insert(conversations).values({
      id: 'conv-2',
      title: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      contextSummary: null,
      contextCompactedMessageCount: 0,
      contextCompactedAt: null,
    }).run();

    db.insert(messages).values({
      id: 'msg-newer',
      conversationId: 'conv-2',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'We decided to use sqlite for local persistence because reliability matters.' }]),
      createdAt: 1_000,
    }).run();
    db.insert(messages).values({
      id: 'msg-older',
      conversationId: 'conv-2',
      role: 'user',
      content: JSON.stringify([{ type: 'text', text: 'We decided to use sqlite for local persistence because reliability matters.' }]),
      createdAt: 500,
    }).run();

    extractAndUpsertMemoryItemsForMessage('msg-newer');
    extractAndUpsertMemoryItemsForMessage('msg-older');

    const row = db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.kind, 'decision'), eq(memoryItems.status, 'active')))
      .get();

    expect(row).not.toBeNull();
    expect(row?.lastSeenAt).toBe(1_000);
  });
});
