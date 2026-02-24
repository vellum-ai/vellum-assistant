import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'call-pointer-messages-test-'));

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
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { conversations } from '../memory/schema.js';
import { getMessages } from '../memory/conversation-store.js';
import { addPointerMessage, formatDuration } from '../calls/call-pointer-messages.js';

initializeDb();

function ensureConversation(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations).values({
    id,
    title: `Conversation ${id}`,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
}

function getLatestAssistantText(conversationId: string): string {
  const rows = getMessages(conversationId).filter((m) => m.role === 'assistant');
  expect(rows.length).toBeGreaterThan(0);
  const latest = rows[rows.length - 1];
  const parsed = JSON.parse(latest.content) as Array<{ type: string; text?: string }>;
  return parsed.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}

describe('formatDuration', () => {
  test('formats seconds-only durations', () => {
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(30000)).toBe('30s');
    expect(formatDuration(59000)).toBe('59s');
  });

  test('formats minutes-only durations', () => {
    expect(formatDuration(60000)).toBe('1m');
    expect(formatDuration(120000)).toBe('2m');
    expect(formatDuration(300000)).toBe('5m');
  });

  test('formats minutes and seconds', () => {
    expect(formatDuration(65000)).toBe('1m 5s');
    expect(formatDuration(90000)).toBe('1m 30s');
    expect(formatDuration(125000)).toBe('2m 5s');
  });

  test('rounds sub-second durations', () => {
    expect(formatDuration(500)).toBe('1s');
    expect(formatDuration(1499)).toBe('1s');
    expect(formatDuration(1500)).toBe('2s');
  });

  test('handles zero duration', () => {
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('addPointerMessage', () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
  });

  test('adds a started pointer message', () => {
    const convId = 'conv-ptr-started';
    ensureConversation(convId);
    addPointerMessage(convId, 'started', '+15551234567');
    const text = getLatestAssistantText(convId);
    expect(text).toContain('Call to +15551234567 started');
    expect(text).toContain('See voice thread');
  });

  test('adds a started pointer message with verification code', () => {
    const convId = 'conv-ptr-started-vc';
    ensureConversation(convId);
    addPointerMessage(convId, 'started', '+15551234567', { verificationCode: '42' });
    const text = getLatestAssistantText(convId);
    expect(text).toContain('Verification code: 42');
  });

  test('adds a completed pointer message without duration', () => {
    const convId = 'conv-ptr-completed';
    ensureConversation(convId);
    addPointerMessage(convId, 'completed', '+15559876543');
    const text = getLatestAssistantText(convId);
    expect(text).toContain('Call to +15559876543 completed');
    expect(text).not.toContain('(');
  });

  test('adds a completed pointer message with duration', () => {
    const convId = 'conv-ptr-completed-d';
    ensureConversation(convId);
    addPointerMessage(convId, 'completed', '+15559876543', { duration: '2m 30s' });
    const text = getLatestAssistantText(convId);
    expect(text).toContain('completed (2m 30s)');
  });

  test('adds a failed pointer message without reason', () => {
    const convId = 'conv-ptr-failed';
    ensureConversation(convId);
    addPointerMessage(convId, 'failed', '+15559876543');
    const text = getLatestAssistantText(convId);
    expect(text).toContain('Call to +15559876543 failed');
  });

  test('adds a failed pointer message with reason', () => {
    const convId = 'conv-ptr-failed-r';
    ensureConversation(convId);
    addPointerMessage(convId, 'failed', '+15559876543', { reason: 'no answer' });
    const text = getLatestAssistantText(convId);
    expect(text).toContain('failed: no answer');
  });
});
