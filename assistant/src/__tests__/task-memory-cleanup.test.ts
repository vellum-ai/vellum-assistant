import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

import { DEFAULT_CONFIG } from '../config/defaults.js';

const testDir = mkdtempSync(join(tmpdir(), 'task-memory-cleanup-'));

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

mock.module('../memory/qdrant-client.js', () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
}));

const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
  },
};

mock.module('../config/loader.js', () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

import { getDb, initializeDb, resetDb } from '../memory/db.js';
import { conversations, memoryItems, memoryItemSources, messages } from '../memory/schema.js';
import { invalidateAssistantInferredItemsForConversation } from '../memory/task-memory-cleanup.js';

describe('invalidateAssistantInferredItemsForConversation', () => {
  const now = 1_701_100_000_000;
  const convId = 'conv-task-cleanup';
  const otherConvId = 'conv-other';

  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM memory_item_sources');
    db.run('DELETE FROM memory_items');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best effort
    }
  });

  function seedConversations() {
    const db = getDb();
    for (const id of [convId, otherConvId]) {
      db.insert(conversations).values({
        id,
        title: null,
        createdAt: now,
        updatedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
      }).run();
    }
  }

  function seedMessages() {
    const db = getDb();
    db.insert(messages).values([
      { id: 'msg-task-1', conversationId: convId, role: 'assistant', content: '[]', createdAt: now + 10 },
      { id: 'msg-task-2', conversationId: convId, role: 'user', content: '[]', createdAt: now + 20 },
      { id: 'msg-other', conversationId: otherConvId, role: 'assistant', content: '[]', createdAt: now + 30 },
    ]).run();
  }

  function seedMemoryItems() {
    const db = getDb();
    db.insert(memoryItems).values([
      {
        id: 'item-assistant-inferred',
        kind: 'fact',
        subject: 'DMV appointment',
        statement: 'Booked a DMV appointment at 9 AM.',
        status: 'active',
        confidence: 0.8,
        importance: 0.7,
        fingerprint: 'fp-assistant-inferred',
        verificationState: 'assistant_inferred',
        scopeId: 'default',
        firstSeenAt: now + 10,
        lastSeenAt: now + 10,
      },
      {
        id: 'item-user-reported',
        kind: 'preference',
        subject: 'notification pref',
        statement: 'User prefers email notifications.',
        status: 'active',
        confidence: 0.9,
        importance: 0.8,
        fingerprint: 'fp-user-reported',
        verificationState: 'user_reported',
        scopeId: 'default',
        firstSeenAt: now + 20,
        lastSeenAt: now + 20,
      },
      {
        id: 'item-other-conv',
        kind: 'fact',
        subject: 'weather check',
        statement: 'Checked weather for tomorrow.',
        status: 'active',
        confidence: 0.7,
        importance: 0.5,
        fingerprint: 'fp-other-conv',
        verificationState: 'assistant_inferred',
        scopeId: 'default',
        firstSeenAt: now + 30,
        lastSeenAt: now + 30,
      },
      {
        id: 'item-already-superseded',
        kind: 'fact',
        subject: 'old claim',
        statement: 'Old assistant claim already superseded.',
        status: 'superseded',
        confidence: 0.6,
        importance: 0.4,
        fingerprint: 'fp-already-superseded',
        verificationState: 'assistant_inferred',
        scopeId: 'default',
        firstSeenAt: now + 5,
        lastSeenAt: now + 5,
      },
    ]).run();

    db.insert(memoryItemSources).values([
      { memoryItemId: 'item-assistant-inferred', messageId: 'msg-task-1', evidence: 'booking claim', createdAt: now + 10 },
      { memoryItemId: 'item-user-reported', messageId: 'msg-task-2', evidence: 'user stated', createdAt: now + 20 },
      { memoryItemId: 'item-other-conv', messageId: 'msg-other', evidence: 'weather', createdAt: now + 30 },
      { memoryItemId: 'item-already-superseded', messageId: 'msg-task-1', evidence: 'old claim', createdAt: now + 5 },
    ]).run();
  }

  test('only invalidates assistant_inferred items, not user_reported', () => {
    seedConversations();
    seedMessages();
    seedMemoryItems();

    const affected = invalidateAssistantInferredItemsForConversation(convId);

    expect(affected).toBe(1);

    const db = getDb();
    const assistantItem = db.select().from(memoryItems).where(eq(memoryItems.id, 'item-assistant-inferred')).get();
    expect(assistantItem?.status).toBe('invalidated');
    expect(assistantItem?.invalidAt).not.toBeNull();

    const userItem = db.select().from(memoryItems).where(eq(memoryItems.id, 'item-user-reported')).get();
    expect(userItem?.status).toBe('active');
    expect(userItem?.invalidAt).toBeNull();
  });

  test('does not affect items from other conversations', () => {
    seedConversations();
    seedMessages();
    seedMemoryItems();

    invalidateAssistantInferredItemsForConversation(convId);

    const db = getDb();
    const otherItem = db.select().from(memoryItems).where(eq(memoryItems.id, 'item-other-conv')).get();
    expect(otherItem?.status).toBe('active');
    expect(otherItem?.invalidAt).toBeNull();
  });

  test('does not invalidate items also sourced from another conversation', () => {
    seedConversations();
    seedMessages();
    seedMemoryItems();

    // Add a second source from the other conversation to the assistant-inferred item.
    // This simulates deduplication: the same fact was extracted from both conversations.
    const db = getDb();
    db.insert(memoryItemSources).values({
      memoryItemId: 'item-assistant-inferred',
      messageId: 'msg-other',
      evidence: 'corroborating source from other conversation',
      createdAt: now + 40,
    }).run();

    const affected = invalidateAssistantInferredItemsForConversation(convId);

    // The item has sources from both conversations, so it should NOT be invalidated.
    expect(affected).toBe(0);

    const item = db.select().from(memoryItems).where(eq(memoryItems.id, 'item-assistant-inferred')).get();
    expect(item?.status).toBe('active');
    expect(item?.invalidAt).toBeNull();
  });

  test('does not affect already-superseded items', () => {
    seedConversations();
    seedMessages();
    seedMemoryItems();

    invalidateAssistantInferredItemsForConversation(convId);

    const db = getDb();
    const supersededItem = db.select().from(memoryItems).where(eq(memoryItems.id, 'item-already-superseded')).get();
    expect(supersededItem?.status).toBe('superseded');
  });

  test('returns 0 when no matching items exist', () => {
    seedConversations();
    seedMessages();
    // No memory items seeded

    const affected = invalidateAssistantInferredItemsForConversation(convId);
    expect(affected).toBe(0);
  });

  test('returns 0 for unknown conversation', () => {
    seedConversations();
    seedMessages();
    seedMemoryItems();

    const affected = invalidateAssistantInferredItemsForConversation('conv-nonexistent');
    expect(affected).toBe(0);
  });
});
