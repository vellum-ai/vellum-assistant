import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'call-store-test-'));

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
import { conversations } from '../memory/schema.js';
import {
  createCallSession,
  getCallSession,
  getCallSessionByCallSid,
  getActiveCallSessionForConversation,
  updateCallSession,
  recordCallEvent,
  getCallEvents,
  createPendingQuestion,
  getPendingQuestion,
  answerPendingQuestion,
  expirePendingQuestions,
} from '../calls/call-store.js';

initializeDb();

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

/** Ensure a conversation row exists for the given ID so FK constraints pass. */
let ensuredConvIds = new Set<string>();
function ensureConversation(id: string): void {
  if (ensuredConvIds.has(id)) return;
  const db = getDb();
  const now = Date.now();
  db.insert(conversations).values({
    id,
    title: `Test conversation ${id}`,
    createdAt: now,
    updatedAt: now,
  }).run();
  ensuredConvIds.add(id);
}

function resetTables() {
  const db = getDb();
  db.run('DELETE FROM call_pending_questions');
  db.run('DELETE FROM call_events');
  db.run('DELETE FROM call_sessions');
  db.run('DELETE FROM conversations');
  ensuredConvIds = new Set();
}

/** Wrapper that ensures the FK conversation row exists before creating a session. */
function createTestCallSession(opts: Parameters<typeof createCallSession>[0]) {
  ensureConversation(opts.conversationId);
  return createCallSession(opts);
}

describe('call-store', () => {
  beforeEach(() => {
    resetTables();
  });

  // ── Call Sessions ─────────────────────────────────────────────────

  test('createCallSession creates a session with correct defaults', () => {
    const session = createTestCallSession({
      conversationId: 'conv-1',
      provider: 'twilio',
      fromNumber: '+15551234567',
      toNumber: '+15559876543',
      task: 'Book appointment',
    });

    expect(session.id).toBeDefined();
    expect(session.conversationId).toBe('conv-1');
    expect(session.provider).toBe('twilio');
    expect(session.fromNumber).toBe('+15551234567');
    expect(session.toNumber).toBe('+15559876543');
    expect(session.task).toBe('Book appointment');
    expect(session.status).toBe('initiated');
    expect(session.providerCallSid).toBeNull();
    expect(session.startedAt).toBeNull();
    expect(session.endedAt).toBeNull();
    expect(session.lastError).toBeNull();
    expect(typeof session.createdAt).toBe('number');
    expect(typeof session.updatedAt).toBe('number');
  });

  test('createCallSession defaults task to null when not provided', () => {
    const session = createTestCallSession({
      conversationId: 'conv-2',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    expect(session.task).toBeNull();
  });

  test('getCallSession retrieves by ID', () => {
    const created = createTestCallSession({
      conversationId: 'conv-3',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const retrieved = getCallSession(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.conversationId).toBe('conv-3');
  });

  test('getCallSession returns null for missing ID', () => {
    const result = getCallSession('nonexistent-id');
    expect(result).toBeNull();
  });

  test('getCallSessionByCallSid looks up by provider call SID', () => {
    const session = createTestCallSession({
      conversationId: 'conv-4',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    updateCallSession(session.id, { providerCallSid: 'CA_test_sid_123' });

    const found = getCallSessionByCallSid('CA_test_sid_123');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(session.id);
    expect(found!.providerCallSid).toBe('CA_test_sid_123');
  });

  test('getCallSessionByCallSid returns null for unknown SID', () => {
    const result = getCallSessionByCallSid('CA_unknown');
    expect(result).toBeNull();
  });

  test('getActiveCallSessionForConversation finds non-terminal sessions', () => {
    const session = createTestCallSession({
      conversationId: 'conv-5',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const active = getActiveCallSessionForConversation('conv-5');
    expect(active).not.toBeNull();
    expect(active!.id).toBe(session.id);
  });

  test('getActiveCallSessionForConversation returns null when all sessions are completed', () => {
    const session = createTestCallSession({
      conversationId: 'conv-6',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    updateCallSession(session.id, { status: 'completed' });

    const active = getActiveCallSessionForConversation('conv-6');
    expect(active).toBeNull();
  });

  test('getActiveCallSessionForConversation returns null when all sessions are failed', () => {
    const session = createTestCallSession({
      conversationId: 'conv-7',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    updateCallSession(session.id, { status: 'failed' });

    const active = getActiveCallSessionForConversation('conv-7');
    expect(active).toBeNull();
  });

  test('getActiveCallSessionForConversation returns most recent active session', () => {
    // Create two sessions for the same conversation
    const older = createTestCallSession({
      conversationId: 'conv-8',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });
    // Mark older as completed
    updateCallSession(older.id, { status: 'completed' });

    const newer = createTestCallSession({
      conversationId: 'conv-8',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15553333333',
    });

    const active = getActiveCallSessionForConversation('conv-8');
    expect(active).not.toBeNull();
    expect(active!.id).toBe(newer.id);
  });

  test('updateCallSession updates status, providerCallSid, and timestamps', () => {
    const session = createTestCallSession({
      conversationId: 'conv-9',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const now = Date.now();
    updateCallSession(session.id, {
      status: 'in_progress',
      providerCallSid: 'CA_updated_sid',
      startedAt: now,
    });

    const updated = getCallSession(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('in_progress');
    expect(updated!.providerCallSid).toBe('CA_updated_sid');
    expect(updated!.startedAt).toBe(now);
    // updatedAt should be updated
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(session.updatedAt);
  });

  test('updateCallSession sets endedAt and lastError', () => {
    const session = createTestCallSession({
      conversationId: 'conv-10',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const endTime = Date.now();
    updateCallSession(session.id, {
      status: 'failed',
      endedAt: endTime,
      lastError: 'Network timeout',
    });

    const updated = getCallSession(session.id);
    expect(updated!.status).toBe('failed');
    expect(updated!.endedAt).toBe(endTime);
    expect(updated!.lastError).toBe('Network timeout');
  });

  // ── Call Events ───────────────────────────────────────────────────

  test('recordCallEvent creates events with correct fields', () => {
    const session = createTestCallSession({
      conversationId: 'conv-11',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const event = recordCallEvent(session.id, 'call_started', { twilioStatus: 'initiated' });

    expect(event.id).toBeDefined();
    expect(event.callSessionId).toBe(session.id);
    expect(event.eventType).toBe('call_started');
    expect(typeof event.createdAt).toBe('number');
  });

  test('recordCallEvent stores JSON payload', () => {
    const session = createTestCallSession({
      conversationId: 'conv-12',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const payload = { text: 'Hello, how are you?', lang: 'en-US' };
    const event = recordCallEvent(session.id, 'caller_spoke', payload);

    const parsed = JSON.parse(event.payloadJson);
    expect(parsed.text).toBe('Hello, how are you?');
    expect(parsed.lang).toBe('en-US');
  });

  test('recordCallEvent defaults payload to empty JSON object', () => {
    const session = createTestCallSession({
      conversationId: 'conv-13',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const event = recordCallEvent(session.id, 'call_connected');

    expect(event.payloadJson).toBe('{}');
  });

  test('getCallEvents retrieves events in creation order', () => {
    const session = createTestCallSession({
      conversationId: 'conv-14',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    recordCallEvent(session.id, 'call_started');
    recordCallEvent(session.id, 'call_connected');
    recordCallEvent(session.id, 'caller_spoke', { transcript: 'Hi' });

    const events = getCallEvents(session.id);
    expect(events).toHaveLength(3);
    expect(events[0].eventType).toBe('call_started');
    expect(events[1].eventType).toBe('call_connected');
    expect(events[2].eventType).toBe('caller_spoke');
    // Should be in ascending creation order
    expect(events[0].createdAt).toBeLessThanOrEqual(events[1].createdAt);
    expect(events[1].createdAt).toBeLessThanOrEqual(events[2].createdAt);
  });

  test('getCallEvents returns empty array for session with no events', () => {
    const session = createTestCallSession({
      conversationId: 'conv-15',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const events = getCallEvents(session.id);
    expect(events).toHaveLength(0);
  });

  // ── Pending Questions ─────────────────────────────────────────────

  test('createPendingQuestion creates with status pending', () => {
    const session = createTestCallSession({
      conversationId: 'conv-16',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const question = createPendingQuestion(session.id, 'What is your preferred date?');

    expect(question.id).toBeDefined();
    expect(question.callSessionId).toBe(session.id);
    expect(question.questionText).toBe('What is your preferred date?');
    expect(question.status).toBe('pending');
    expect(typeof question.askedAt).toBe('number');
    expect(question.answeredAt).toBeNull();
    expect(question.answerText).toBeNull();
  });

  test('getPendingQuestion finds pending question for session', () => {
    const session = createTestCallSession({
      conversationId: 'conv-17',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const created = createPendingQuestion(session.id, 'What is your name?');

    const found = getPendingQuestion(session.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.questionText).toBe('What is your name?');
    expect(found!.status).toBe('pending');
  });

  test('getPendingQuestion returns null when no pending questions', () => {
    const session = createTestCallSession({
      conversationId: 'conv-18',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const found = getPendingQuestion(session.id);
    expect(found).toBeNull();
  });

  test('answerPendingQuestion updates status to answered', () => {
    const session = createTestCallSession({
      conversationId: 'conv-19',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const question = createPendingQuestion(session.id, 'What color?');
    answerPendingQuestion(question.id, 'Blue');

    // Should no longer appear as pending
    const pending = getPendingQuestion(session.id);
    expect(pending).toBeNull();

    // Verify the record was updated by querying directly
    const db = getDb();
    const raw = (db as unknown as { $client: import('bun:sqlite').Database }).$client;
    const updated = raw.query('SELECT * FROM call_pending_questions WHERE id = ?').get(question.id) as {
      status: string;
      answer_text: string;
      answered_at: number;
    };
    expect(updated.status).toBe('answered');
    expect(updated.answer_text).toBe('Blue');
    expect(typeof updated.answered_at).toBe('number');
  });

  test('expirePendingQuestions marks all pending questions as expired', () => {
    const session = createTestCallSession({
      conversationId: 'conv-20',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    createPendingQuestion(session.id, 'Question 1');
    createPendingQuestion(session.id, 'Question 2');

    expirePendingQuestions(session.id);

    // No more pending questions
    const pending = getPendingQuestion(session.id);
    expect(pending).toBeNull();

    // Verify both were expired
    const raw = (getDb() as unknown as { $client: import('bun:sqlite').Database }).$client;
    const rows = raw.query('SELECT status FROM call_pending_questions WHERE call_session_id = ?').all(session.id) as Array<{ status: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('expired');
    }
  });

  test('expirePendingQuestions does not affect already-answered questions', () => {
    const session = createTestCallSession({
      conversationId: 'conv-21',
      provider: 'twilio',
      fromNumber: '+15551111111',
      toNumber: '+15552222222',
    });

    const q1 = createPendingQuestion(session.id, 'Question 1');
    createPendingQuestion(session.id, 'Question 2');

    // Answer q1 first
    answerPendingQuestion(q1.id, 'Answer 1');

    // Then expire all pending
    expirePendingQuestions(session.id);

    // q1 should still be answered, not expired
    const raw = (getDb() as unknown as { $client: import('bun:sqlite').Database }).$client;
    const q1Row = raw.query('SELECT status FROM call_pending_questions WHERE id = ?').get(q1.id) as { status: string };
    expect(q1Row.status).toBe('answered');
  });
});
