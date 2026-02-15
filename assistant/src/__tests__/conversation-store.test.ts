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
  isLastUserMessageToolResult,
  clearAll,
} from '../memory/conversation-store.js';
import {
  uploadAttachment,
  linkAttachmentToMessage,
  getAttachmentsForMessageUnscoped,
  deleteOrphanAttachments as _deleteOrphanAttachments,
} from '../memory/attachments-store.js';

// Initialize db once before all tests
initializeDb();

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

describe('deleteLastExchange', () => {
  beforeEach(() => {
    // Reset database between tests by dropping and recreating tables
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
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

describe('isLastUserMessageToolResult', () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test('returns true when last user message is tool_result only', () => {
    const conv = createConversation('test');
    addMessage(conv.id, 'user', 'hello');
    addMessage(conv.id, 'assistant', JSON.stringify([{ type: 'tool_use', id: 'tu1', name: 'bash', input: {} }]));
    addMessage(conv.id, 'user', JSON.stringify([{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]));

    expect(isLastUserMessageToolResult(conv.id)).toBe(true);
  });

  test('returns false when last user message is plain text', () => {
    const conv = createConversation('test');
    addMessage(conv.id, 'user', 'hello');

    expect(isLastUserMessageToolResult(conv.id)).toBe(false);
  });

  test('returns false when no user messages exist', () => {
    const conv = createConversation('test');
    expect(isLastUserMessageToolResult(conv.id)).toBe(false);
  });

  test('returns false when last user message has mixed content types', () => {
    const conv = createConversation('test');
    addMessage(conv.id, 'user', JSON.stringify([
      { type: 'text', text: 'hello' },
      { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
    ]));

    expect(isLastUserMessageToolResult(conv.id)).toBe(false);
  });
});

describe('deleteLastExchange with tool_result messages', () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test('looping deleteLastExchange cleans up tool_result user messages', () => {
    const conv = createConversation('test');
    // Simulate: user asks question -> assistant uses tool -> tool_result -> assistant responds
    addMessage(conv.id, 'user', 'What files are in /tmp?');
    addMessage(conv.id, 'assistant', JSON.stringify([{ type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'ls /tmp' } }]));
    addMessage(conv.id, 'user', JSON.stringify([{ type: 'tool_result', tool_use_id: 'tu1', content: 'file1.txt' }]));
    addMessage(conv.id, 'assistant', JSON.stringify([{ type: 'text', text: 'There is file1.txt in /tmp' }]));

    // First deleteLastExchange removes the tool_result user msg + final assistant msg
    let deleted = deleteLastExchange(conv.id);
    expect(deleted).toBe(2);

    // After deleting the tool_result user + assistant, the remaining are:
    // user: "What files are in /tmp?" and assistant: tool_use
    let remaining = getMessages(conv.id);
    expect(remaining).toHaveLength(2);

    // The last user message is the real one, so isLastUserMessageToolResult should be false
    expect(isLastUserMessageToolResult(conv.id)).toBe(false);

    // Now delete again to remove the real user message + tool_use assistant
    deleted = deleteLastExchange(conv.id);
    expect(deleted).toBe(2);

    remaining = getMessages(conv.id);
    expect(remaining).toHaveLength(0);
  });

  test('looping pattern handles multiple tool uses in sequence', () => {
    const conv = createConversation('test');
    // user -> assistant(tool_use) -> user(tool_result) -> assistant(tool_use) -> user(tool_result) -> assistant(text)
    addMessage(conv.id, 'user', 'Do two things');
    addMessage(conv.id, 'assistant', JSON.stringify([{ type: 'tool_use', id: 'tu1', name: 'bash', input: {} }]));
    addMessage(conv.id, 'user', JSON.stringify([{ type: 'tool_result', tool_use_id: 'tu1', content: 'result1' }]));
    addMessage(conv.id, 'assistant', JSON.stringify([{ type: 'tool_use', id: 'tu2', name: 'bash', input: {} }]));
    addMessage(conv.id, 'user', JSON.stringify([{ type: 'tool_result', tool_use_id: 'tu2', content: 'result2' }]));
    addMessage(conv.id, 'assistant', JSON.stringify([{ type: 'text', text: 'Done both' }]));

    // First delete: removes last tool_result user (row 5) + final assistant (row 6)
    deleteLastExchange(conv.id);
    // Last user is now row 3 (tool_result tu1)
    expect(isLastUserMessageToolResult(conv.id)).toBe(true);

    // Second delete: removes tool_result user (row 3) + assistant tool_use (row 4)
    deleteLastExchange(conv.id);
    // Last user is now row 1 (real user message)
    expect(isLastUserMessageToolResult(conv.id)).toBe(false);

    // Final delete removes the real user message + assistant tool_use
    deleteLastExchange(conv.id);

    const remaining = getMessages(conv.id);
    expect(remaining).toHaveLength(0);
  });
});

describe('attachment orphan cleanup', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM message_attachments');
    db.run('DELETE FROM attachments');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  test('deleteLastExchange cleans up orphaned attachments', () => {
    const conv = createConversation('test');
    addMessage(conv.id, 'user', 'hello');
    const assistantMsg = addMessage(conv.id, 'assistant', 'Here is a file');

    const stored = uploadAttachment('ast-1', 'chart.png', 'image/png', 'iVBOR');
    linkAttachmentToMessage(assistantMsg.id, stored.id, 0);

    // Verify attachment is linked
    expect(getAttachmentsForMessageUnscoped(assistantMsg.id)).toHaveLength(1);

    // Delete the exchange — should also clean up orphaned attachments
    deleteLastExchange(conv.id);

    // Attachment row should be gone
    const raw = (getDb() as unknown as { $client: import('bun:sqlite').Database }).$client;
    const remaining = raw.query('SELECT COUNT(*) AS c FROM attachments').get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  test('deleteLastExchange preserves attachments still linked to other messages', () => {
    const conv = createConversation('test');
    const msg1 = addMessage(conv.id, 'assistant', 'first');
    addMessage(conv.id, 'user', 'question');
    const msg2 = addMessage(conv.id, 'assistant', 'second');

    const shared = uploadAttachment('ast-1', 'shared.png', 'image/png', 'AAAA');
    linkAttachmentToMessage(msg1.id, shared.id, 0);
    linkAttachmentToMessage(msg2.id, shared.id, 0);

    // Delete last exchange (removes msg2 + user question)
    deleteLastExchange(conv.id);

    // Attachment should survive because msg1 still links to it
    const raw = (getDb() as unknown as { $client: import('bun:sqlite').Database }).$client;
    const remaining = raw.query('SELECT COUNT(*) AS c FROM attachments').get() as { c: number };
    expect(remaining.c).toBe(1);
  });

  test('clearAll removes all attachments', () => {
    const conv = createConversation('test');
    const msg = addMessage(conv.id, 'assistant', 'file');
    const stored = uploadAttachment('ast-1', 'doc.pdf', 'application/pdf', 'JVBER');
    linkAttachmentToMessage(msg.id, stored.id, 0);

    clearAll();

    const raw = (getDb() as unknown as { $client: import('bun:sqlite').Database }).$client;
    const attachmentCount = raw.query('SELECT COUNT(*) AS c FROM attachments').get() as { c: number };
    const linkCount = raw.query('SELECT COUNT(*) AS c FROM message_attachments').get() as { c: number };
    expect(attachmentCount.c).toBe(0);
    expect(linkCount.c).toBe(0);
  });

  test('deleteLastExchange does not delete unlinked user uploads', () => {
    const conv = createConversation('test');
    addMessage(conv.id, 'user', 'hello');
    const assistantMsg = addMessage(conv.id, 'assistant', 'Here is a file');

    // An attachment linked to the assistant message (should be cleaned up)
    const linked = uploadAttachment('ast-1', 'chart.png', 'image/png', 'iVBOR');
    linkAttachmentToMessage(assistantMsg.id, linked.id, 0);

    // A freshly uploaded attachment not linked to any message (should survive)
    uploadAttachment('ast-1', 'pending.png', 'image/png', 'AAAA');

    deleteLastExchange(conv.id);

    const raw = (getDb() as unknown as { $client: import('bun:sqlite').Database }).$client;
    const remaining = raw.query('SELECT COUNT(*) AS c FROM attachments').get() as { c: number };
    expect(remaining.c).toBe(1); // only the unlinked upload survives
  });
});
