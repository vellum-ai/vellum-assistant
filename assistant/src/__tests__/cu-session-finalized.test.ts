import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import * as net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'cu-finalized-test-'));

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
import { attachments, messages } from '../memory/schema.js';
import { createConversation, addMessage } from '../memory/conversation-store.js';
import { getAttachmentMetadataForMessage } from '../memory/attachments-store.js';
import { handleRecordingStatus, cuSessionAttachConversationId } from '../daemon/handlers/computer-use.js';
import { eq } from 'drizzle-orm';
import type { RecordingStatus } from '../daemon/ipc-contract/computer-use.js';
import type { HandlerContext } from '../daemon/handlers/shared.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

function resetTables() {
  const db = getDb();
  db.run('DELETE FROM message_attachments');
  db.run('DELETE FROM attachments');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
  cuSessionAttachConversationId.clear();
}

function createMockSocket(): net.Socket {
  return {} as net.Socket;
}

function createMockCtx(): HandlerContext {
  return {
    sessions: new Map(),
    socketToSession: new Map(),
    cuSessions: new Map(),
    socketToCuSession: new Map(),
    cuObservationParseSequence: new Map(),
    socketSandboxOverride: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new Map() as unknown as HandlerContext['debounceTimers'],
    suppressConfigReload: false,
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    send: () => {},
    broadcast: () => {},
    clearAllSessions: () => 0,
    getOrCreateSession: async () => { throw new Error('not implemented'); },
    touchSession: () => {},
  };
}

// ---------------------------------------------------------------------------
// Recording finalization in handleRecordingStatus
// ---------------------------------------------------------------------------

describe('handleRecordingStatus - recording finalization', () => {
  beforeEach(resetTables);

  test('creates file-backed attachment when recording stops with filePath', () => {
    const sessionId = 'test-session-001';
    const conversationId = 'conv-001';

    // Set up the attachToConversationId mapping
    cuSessionAttachConversationId.set(sessionId, conversationId);

    // Create conversation and messages using the target conversationId
    createConversation(conversationId);
    addMessage(conversationId, 'user', 'Start the test');
    addMessage(conversationId, 'assistant', 'Running the test now');

    // Create a real recording file
    const filePath = join(testDir, 'recording-001.mov');
    writeFileSync(filePath, 'fake video data for testing purposes');

    const msg: RecordingStatus = {
      type: 'recording_status',
      sessionId,
      status: 'stopped',
      filePath,
      durationMs: 5000,
    };

    handleRecordingStatus(msg, createMockSocket(), createMockCtx());

    // Check that a file-backed attachment was created
    const db = getDb();
    const rows = db.select().from(attachments).all();

    expect(rows.length).toBe(1);
    expect(rows[0].filePath).toBe(filePath);
    expect(rows[0].dataBase64).toBe('');
    expect(rows[0].mimeType).toBe('video/quicktime');
  });

  test('links attachment to latest assistant message', () => {
    const sessionId = 'test-session-002';
    const conversationId = 'conv-002';

    cuSessionAttachConversationId.set(sessionId, conversationId);

    createConversation(conversationId);
    addMessage(conversationId, 'user', 'Do something');
    const assistantMsg = addMessage(conversationId, 'assistant', 'Done');

    const filePath = join(testDir, 'recording-002.mp4');
    writeFileSync(filePath, 'video content');

    const msg: RecordingStatus = {
      type: 'recording_status',
      sessionId,
      status: 'stopped',
      filePath,
      durationMs: 3000,
    };

    handleRecordingStatus(msg, createMockSocket(), createMockCtx());

    // Verify attachment is linked to the assistant message
    const attachmentMeta = getAttachmentMetadataForMessage(assistantMsg.id);
    expect(attachmentMeta.length).toBe(1);
    expect(attachmentMeta[0].filePath).toBe(filePath);
  });

  test('creates assistant message when none exists in target conversation', () => {
    const sessionId = 'test-session-create-msg';
    const conversationId = 'conv-create-msg';

    cuSessionAttachConversationId.set(sessionId, conversationId);

    // Create conversation with only a user message — no assistant message
    createConversation(conversationId);
    addMessage(conversationId, 'user', 'Start recording');

    const filePath = join(testDir, 'recording-create-msg.mov');
    writeFileSync(filePath, 'video data');

    const msg: RecordingStatus = {
      type: 'recording_status',
      sessionId,
      status: 'stopped',
      filePath,
      durationMs: 2000,
    };

    handleRecordingStatus(msg, createMockSocket(), createMockCtx());

    // A new assistant message should have been created
    const db = getDb();
    const assistantMsgs = db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .all()
      .filter(m => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(1);
    expect(assistantMsgs[0].content).toBe('Screen recording attached.');

    // Attachment should be linked to that new message
    const attachmentMeta = getAttachmentMetadataForMessage(assistantMsgs[0].id);
    expect(attachmentMeta.length).toBe(1);
    expect(attachmentMeta[0].filePath).toBe(filePath);
  });

  test('does not crash when filePath does not exist', () => {
    const sessionId = 'test-session-003';
    const conversationId = 'conv-003';

    cuSessionAttachConversationId.set(sessionId, conversationId);

    createConversation(conversationId);
    addMessage(conversationId, 'assistant', 'test');

    const msg: RecordingStatus = {
      type: 'recording_status',
      sessionId,
      status: 'stopped',
      filePath: join(testDir, 'nonexistent-recording.mov'),
      durationMs: 1000,
    };

    // Should not throw
    expect(() => {
      handleRecordingStatus(msg, createMockSocket(), createMockCtx());
    }).not.toThrow();

    // No attachment should be created
    const db = getDb();
    const rows = db.select().from(attachments).all();
    expect(rows.length).toBe(0);
  });

  test('does not create attachment when no attachToConversationId is set', () => {
    // No mapping entry — simulates a session without attachToConversationId
    const sessionId = 'orphan-session';

    const filePath = join(testDir, 'recording-orphan.mov');
    writeFileSync(filePath, 'video');

    const msg: RecordingStatus = {
      type: 'recording_status',
      sessionId,
      status: 'stopped',
      filePath,
      durationMs: 1000,
    };

    // Should not throw even when there's no mapping
    expect(() => {
      handleRecordingStatus(msg, createMockSocket(), createMockCtx());
    }).not.toThrow();
  });

  test('does not create attachment for non-stopped status', () => {
    const sessionId = 'test-session-started';

    const msg: RecordingStatus = {
      type: 'recording_status',
      sessionId,
      status: 'started',
    };

    handleRecordingStatus(msg, createMockSocket(), createMockCtx());

    const db = getDb();
    const rows = db.select().from(attachments).all();
    expect(rows.length).toBe(0);
  });

  test('does not create attachment for stopped status without filePath', () => {
    const sessionId = 'test-session-no-path';

    const msg: RecordingStatus = {
      type: 'recording_status',
      sessionId,
      status: 'stopped',
    };

    handleRecordingStatus(msg, createMockSocket(), createMockCtx());

    const db = getDb();
    const rows = db.select().from(attachments).all();
    expect(rows.length).toBe(0);
  });
});
