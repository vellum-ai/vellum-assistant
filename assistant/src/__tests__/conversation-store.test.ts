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

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import {
  createConversation,
  getConversation,
  getConversationThreadType,
  getConversationMemoryScopeId,
  addMessage,
  getMessages,
  deleteLastExchange,
  isLastUserMessageToolResult,
  clearAll,
} from '../memory/conversation-store.js';
import {
  uploadAttachment,
  linkAttachmentToMessage,
  getAttachmentsForMessage,
  getAttachmentById,
} from '../memory/attachments-store.js';

// Initialize db once before all tests
initializeDb();

afterAll(() => {
  resetDb();
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

    const stored = uploadAttachment('chart.png', 'image/png', 'iVBOR');
    linkAttachmentToMessage(assistantMsg.id, stored.id, 0);

    // Verify attachment is linked
    expect(getAttachmentsForMessage(assistantMsg.id)).toHaveLength(1);

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

    const shared = uploadAttachment('shared.png', 'image/png', 'AAAA');
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
    const stored = uploadAttachment('doc.pdf', 'application/pdf', 'JVBER');
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
    const linked = uploadAttachment('chart.png', 'image/png', 'iVBOR');
    linkAttachmentToMessage(assistantMsg.id, linked.id, 0);

    // A freshly uploaded attachment not linked to any message (should survive)
    uploadAttachment('pending.png', 'image/png', 'AAAA');

    deleteLastExchange(conv.id);

    const raw = (getDb() as unknown as { $client: import('bun:sqlite').Database }).$client;
    const remaining = raw.query('SELECT COUNT(*) AS c FROM attachments').get() as { c: number };
    expect(remaining.c).toBe(1); // only the unlinked upload survives
  });
});

describe('conversation thread metadata defaults', () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test('new conversation has threadType defaulting to standard', () => {
    const conv = createConversation('test');
    expect(conv.threadType).toBe('standard');
  });

  test('new conversation has memoryScopeId defaulting to default', () => {
    const conv = createConversation('test');
    expect(conv.memoryScopeId).toBe('default');
  });

  test('defaults are persisted and retrievable from DB', () => {
    const conv = createConversation('test');
    const loaded = getConversation(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.threadType).toBe('standard');
    expect(loaded!.memoryScopeId).toBe('default');
  });

  test('existing conversations without explicit values get defaults via migration', () => {
    // Insert a conversation row directly without the new columns
    // (simulates a pre-migration row — the ALTER TABLE DEFAULT handles it)
    const db = getDb();
    const now = Date.now();
    const id = 'legacy-conv-' + now;
    db.run(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('${id}', 'legacy', ${now}, ${now})`,
    );

    const loaded = getConversation(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.threadType).toBe('standard');
    expect(loaded!.memoryScopeId).toBe('default');
  });
});

describe('createConversation with thread type option', () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test('standard create with string title uses defaults', () => {
    const conv = createConversation('hello');
    expect(conv.title).toBe('hello');
    expect(conv.threadType).toBe('standard');
    expect(conv.memoryScopeId).toBe('default');
  });

  test('standard create with options object uses defaults', () => {
    const conv = createConversation({ title: 'hello', threadType: 'standard' });
    expect(conv.threadType).toBe('standard');
    expect(conv.memoryScopeId).toBe('default');
  });

  test('private create sets threadType and derives memoryScopeId', () => {
    const conv = createConversation({ title: 'secret', threadType: 'private' });
    expect(conv.threadType).toBe('private');
    expect(conv.memoryScopeId).toBe(`private:${conv.id}`);
  });

  test('private create memoryScopeId is persisted', () => {
    const conv = createConversation({ threadType: 'private' });
    const loaded = getConversation(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.threadType).toBe('private');
    expect(loaded!.memoryScopeId).toBe(`private:${conv.id}`);
  });

  test('no-arg create uses defaults', () => {
    const conv = createConversation();
    expect(conv.threadType).toBe('standard');
    expect(conv.memoryScopeId).toBe('default');
  });
});

describe('conversation metadata read helpers', () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test('getConversationThreadType returns standard for standard conversation', () => {
    const conv = createConversation('test');
    expect(getConversationThreadType(conv.id)).toBe('standard');
  });

  test('getConversationThreadType returns private for private conversation', () => {
    const conv = createConversation({ threadType: 'private' });
    expect(getConversationThreadType(conv.id)).toBe('private');
  });

  test('getConversationThreadType returns standard for missing conversation', () => {
    expect(getConversationThreadType('nonexistent-id')).toBe('standard');
  });

  test('getConversationMemoryScopeId returns default for standard conversation', () => {
    const conv = createConversation('test');
    expect(getConversationMemoryScopeId(conv.id)).toBe('default');
  });

  test('getConversationMemoryScopeId returns private scope for private conversation', () => {
    const conv = createConversation({ threadType: 'private' });
    expect(getConversationMemoryScopeId(conv.id)).toBe(`private:${conv.id}`);
  });

  test('getConversationMemoryScopeId returns default for missing conversation', () => {
    expect(getConversationMemoryScopeId('nonexistent-id')).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// Baseline: attachment reuse across threads
// ---------------------------------------------------------------------------

describe('attachment reuse across thread lifecycles', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM message_attachments');
    db.run('DELETE FROM attachments');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  test('attachment uploaded in conversation A is retrievable by ID without any conversation reference', () => {
    const convA = createConversation('Thread A');
    const msgA = addMessage(convA.id, 'assistant', 'Here is a file');
    const stored = uploadAttachment('report.pdf', 'application/pdf', 'JVBER');
    linkAttachmentToMessage(msgA.id, stored.id, 0);

    // Create a completely separate conversation
    const convB = createConversation('Thread B');
    addMessage(convB.id, 'user', 'hello');

    // The attachment is retrievable by ID regardless of which conversation is active.
    const fetched = getAttachmentById(stored.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(stored.id);
    expect(fetched!.originalFilename).toBe('report.pdf');
    expect(fetched!.dataBase64).toBe('JVBER');
  });

  test('attachment can be linked to messages in different conversations', () => {
    const convA = createConversation('Thread A');
    const convB = createConversation('Thread B');

    const msgA = addMessage(convA.id, 'assistant', 'Original file');
    const msgB = addMessage(convB.id, 'assistant', 'Reused file');

    // Upload once, link to both conversations
    const stored = uploadAttachment('shared.png', 'image/png', 'iVBORw0K');
    linkAttachmentToMessage(msgA.id, stored.id, 0);
    linkAttachmentToMessage(msgB.id, stored.id, 0);

    // Both messages see the attachment
    const linkedA = getAttachmentsForMessage(msgA.id);
    expect(linkedA).toHaveLength(1);
    expect(linkedA[0].id).toBe(stored.id);

    const linkedB = getAttachmentsForMessage(msgB.id);
    expect(linkedB).toHaveLength(1);
    expect(linkedB[0].id).toBe(stored.id);
  });

  test('deleting conversation A does not orphan attachment reused in conversation B', () => {
    const convA = createConversation('Thread A');
    const convB = createConversation('Thread B');

    // deleteLastExchange deletes from the last user message onward,
    // so we need a user message before the assistant message that carries the attachment.
    addMessage(convA.id, 'user', 'Please generate a chart');
    const msgA = addMessage(convA.id, 'assistant', 'Original');
    addMessage(convB.id, 'user', 'Show me the chart');
    const msgB = addMessage(convB.id, 'assistant', 'Reused');

    const stored = uploadAttachment('chart.png', 'image/png', 'AAAA');
    linkAttachmentToMessage(msgA.id, stored.id, 0);
    linkAttachmentToMessage(msgB.id, stored.id, 0);

    // Delete conversation A's exchange
    deleteLastExchange(convA.id);

    // Attachment survives because convB still references it
    const fetched = getAttachmentById(stored.id);
    expect(fetched).not.toBeNull();

    // convB's message still has the attachment linked
    const linkedB = getAttachmentsForMessage(msgB.id);
    expect(linkedB).toHaveLength(1);
    expect(linkedB[0].id).toBe(stored.id);
  });

  test('content-hash dedup works across conversations', () => {
    const convA = createConversation('Thread A');
    const convB = createConversation('Thread B');

    addMessage(convA.id, 'user', 'upload in A');
    addMessage(convB.id, 'user', 'upload in B');

    // Same content uploaded in two different conversation contexts
    const first = uploadAttachment('photo.png', 'image/png', 'DEDUPCROSS');
    const second = uploadAttachment('photo.png', 'image/png', 'DEDUPCROSS');

    // Dedup returns the same attachment row
    expect(second.id).toBe(first.id);
  });
});

// ---------------------------------------------------------------------------
// Baseline: no private-thread visibility boundary for attachments
// ---------------------------------------------------------------------------

describe('no private-thread attachment visibility boundary', () => {
  beforeEach(() => {
    const db = getDb();
    db.run('DELETE FROM message_attachments');
    db.run('DELETE FROM attachments');
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
  });

  test('attachment from a private thread is visible via getAttachmentById (no thread scoping)', () => {
    const privateConv = createConversation({ title: 'Secret', threadType: 'private' });
    expect(privateConv.threadType).toBe('private');

    const msg = addMessage(privateConv.id, 'assistant', 'Private content');
    const stored = uploadAttachment('secret.pdf', 'application/pdf', 'JVBER');
    linkAttachmentToMessage(msg.id, stored.id, 0);

    // Attachment is globally visible by ID — no thread-type filter exists
    const fetched = getAttachmentById(stored.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.originalFilename).toBe('secret.pdf');
  });

  test('attachment from private thread can be linked to a standard thread message', () => {
    const privateConv = createConversation({ title: 'Private', threadType: 'private' });
    const standardConv = createConversation({ title: 'Standard', threadType: 'standard' });

    const privateMsg = addMessage(privateConv.id, 'assistant', 'Private file');
    const standardMsg = addMessage(standardConv.id, 'assistant', 'Reusing private file');

    const stored = uploadAttachment('private-doc.png', 'image/png', 'PRIVDATA');
    linkAttachmentToMessage(privateMsg.id, stored.id, 0);
    linkAttachmentToMessage(standardMsg.id, stored.id, 0);

    // Both threads can see the attachment
    const linkedPrivate = getAttachmentsForMessage(privateMsg.id);
    expect(linkedPrivate).toHaveLength(1);

    const linkedStandard = getAttachmentsForMessage(standardMsg.id);
    expect(linkedStandard).toHaveLength(1);
    expect(linkedStandard[0].id).toBe(stored.id);
  });

  test('getAttachmentsForMessage returns private thread attachments', () => {
    const privateConv = createConversation({ title: 'Private', threadType: 'private' });
    const msg = addMessage(privateConv.id, 'assistant', 'Private media');
    const stored = uploadAttachment('photo.jpg', 'image/jpeg', 'AAAA');
    linkAttachmentToMessage(msg.id, stored.id, 0);

    const linked = getAttachmentsForMessage(msg.id);
    expect(linked).toHaveLength(1);
    expect(linked[0].id).toBe(stored.id);
  });

  test('content-hash dedup works across private and standard threads', () => {
    createConversation({ title: 'Private', threadType: 'private' });
    createConversation({ title: 'Standard', threadType: 'standard' });

    // Same content uploaded in private and standard contexts
    const fromPrivate = uploadAttachment('file.png', 'image/png', 'CROSSTHREAD');
    const fromStandard = uploadAttachment('file.png', 'image/png', 'CROSSTHREAD');

    // Dedup returns the same row — no thread-type isolation
    expect(fromStandard.id).toBe(fromPrivate.id);
  });

  test('clearAll removes attachments from both private and standard threads', () => {
    const privateConv = createConversation({ title: 'Private', threadType: 'private' });
    const standardConv = createConversation({ title: 'Standard', threadType: 'standard' });

    const privateMsg = addMessage(privateConv.id, 'assistant', 'Private file');
    const standardMsg = addMessage(standardConv.id, 'assistant', 'Standard file');

    const att1 = uploadAttachment('private.png', 'image/png', 'PRIV');
    const att2 = uploadAttachment('standard.png', 'image/png', 'STD');
    linkAttachmentToMessage(privateMsg.id, att1.id, 0);
    linkAttachmentToMessage(standardMsg.id, att2.id, 0);

    clearAll();

    const raw = (getDb() as unknown as { $client: import('bun:sqlite').Database }).$client;
    const attachmentCount = raw.query('SELECT COUNT(*) AS c FROM attachments').get() as { c: number };
    expect(attachmentCount.c).toBe(0);
  });
});
