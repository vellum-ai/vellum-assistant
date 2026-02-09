import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'conv-store-test-'));

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

import { initializeDb, getDb } from '../memory/db.js';
import {
  createConversation,
  addMessage,
  getMessages,
  deleteLastExchange,
} from '../memory/conversation-store.js';

describe('deleteLastExchange', () => {
  beforeEach(() => {
    // Reset database between tests by dropping and recreating tables
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  // Initialize db once before all tests
  initializeDb();

  afterAll(() => {
    try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
  });

  test('deletes last user message and subsequent assistant messages', () => {
    const conv = createConversation('test');
    addMessage(conv.id, 'user', 'first question');
    addMessage(conv.id, 'assistant', 'first answer');
    addMessage(conv.id, 'user', 'second question');
    addMessage(conv.id, 'assistant', 'second answer');

    const deleted = deleteLastExchange(conv.id);
    expect(deleted).toBe(2);

    const remaining = getMessages(conv.id);
    expect(remaining).toHaveLength(2);
    expect(remaining[0].content).toBe('first question');
    expect(remaining[1].content).toBe('first answer');
  });

  test('returns 0 when no user messages exist', () => {
    const conv = createConversation('test');
    addMessage(conv.id, 'assistant', 'hello');

    const deleted = deleteLastExchange(conv.id);
    expect(deleted).toBe(0);
  });

  test('returns 0 for empty conversation', () => {
    const conv = createConversation('test');
    const deleted = deleteLastExchange(conv.id);
    expect(deleted).toBe(0);
  });

  test('uses rowid ordering so same-timestamp messages are handled correctly', () => {
    const conv = createConversation('test');
    const db = getDb();
    const now = Date.now();

    // Insert three user messages with the exact same timestamp.
    // rowid order determines which is "last", not timestamp.
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m1', '${conv.id}', 'user', 'first', ${now})`,
    );
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m2', '${conv.id}', 'assistant', 'reply1', ${now})`,
    );
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m3', '${conv.id}', 'user', 'second', ${now})`,
    );
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('m4', '${conv.id}', 'assistant', 'reply2', ${now})`,
    );

    // deleteLastExchange should find m3 (the last user message by rowid),
    // then delete m3 and m4 (everything at rowid >= m3's rowid).
    const deleted = deleteLastExchange(conv.id);
    expect(deleted).toBe(2);

    const remaining = getMessages(conv.id);
    expect(remaining).toHaveLength(2);
    expect(remaining[0].content).toBe('first');
    expect(remaining[1].content).toBe('reply1');
  });
});
