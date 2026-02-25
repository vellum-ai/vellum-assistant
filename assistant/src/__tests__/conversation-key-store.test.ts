import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const testDir = mkdtempSync(join(tmpdir(), 'conversation-key-store-test-'));
const queueGenerateConversationTitleMock = mock((_params: unknown) => {});

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

mock.module('../memory/conversation-title-service.js', () => ({
  GENERATING_TITLE: 'Generating title...',
  queueGenerateConversationTitle: (params: unknown) => queueGenerateConversationTitleMock(params),
}));

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { getOrCreateConversation } from '../memory/conversation-key-store.js';
import { conversations } from '../memory/schema.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

describe('conversation-key-store title generation', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM conversation_keys');
    db.run('DELETE FROM conversations');
    queueGenerateConversationTitleMock.mockClear();
  });

  test('queues title generation on first create when context is provided', () => {
    const context = {
      origin: 'runtime_api' as const,
      sourceChannel: 'telegram',
      assistantId: 'self',
      externalChatId: 'chat-1',
    };

    const result = getOrCreateConversation('telegram:chat-1', context);
    expect(result.created).toBe(true);
    expect(queueGenerateConversationTitleMock).toHaveBeenCalledTimes(1);
    expect(queueGenerateConversationTitleMock).toHaveBeenCalledWith({
      conversationId: result.conversationId,
      context: {
        ...context,
        conversationKey: 'telegram:chat-1',
      },
    });

    const db = getDb();
    const row = db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, result.conversationId))
      .get();

    expect(row?.title).toBe('Generating title...');
  });

  test('does not queue title generation when mapping already exists', () => {
    const context = { origin: 'runtime_api' as const };
    const first = getOrCreateConversation('runtime:key-1', context);
    expect(first.created).toBe(true);
    queueGenerateConversationTitleMock.mockClear();

    const second = getOrCreateConversation('runtime:key-1', context);
    expect(second.created).toBe(false);
    expect(second.conversationId).toBe(first.conversationId);
    expect(queueGenerateConversationTitleMock).not.toHaveBeenCalled();
  });

  test('does not queue title generation when no context is provided', () => {
    const result = getOrCreateConversation('runtime:key-2');
    expect(result.created).toBe(true);
    expect(queueGenerateConversationTitleMock).not.toHaveBeenCalled();
  });
});
