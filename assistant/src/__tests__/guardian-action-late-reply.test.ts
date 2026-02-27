import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'guardian-action-late-reply-test-'));

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

mock.module('../runtime/gateway-client.js', () => ({
  deliverChannelReply: async () => {},
}));

import { createCallSession, createPendingQuestion } from '../calls/call-store.js';
import { getDb, initializeDb, resetDb } from '../memory/db.js';
import {
  createGuardianActionDelivery,
  createGuardianActionRequest,
  expireGuardianActionRequest,
  getExpiredDeliveriesByConversation,
  getExpiredDeliveriesByDestination,
  getExpiredDeliveryByConversation,
  getFollowupDeliveriesByConversation,
  getGuardianActionRequest,
  getPendingDeliveriesByConversation,
  resolveGuardianActionRequest,
  startFollowupFromExpiredRequest,
  updateDeliveryStatus,
} from '../memory/guardian-action-store.js';
import { conversations } from '../memory/schema.js';

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
  db.run('DELETE FROM guardian_action_deliveries');
  db.run('DELETE FROM guardian_action_requests');
  db.run('DELETE FROM call_pending_questions');
  db.run('DELETE FROM call_events');
  db.run('DELETE FROM call_sessions');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
}

function createExpiredRequest(convId: string, opts?: { chatId?: string; externalUserId?: string; conversationId?: string }) {
  ensureConversation(convId);
  const session = createCallSession({
    conversationId: convId,
    provider: 'twilio',
    fromNumber: '+15550001111',
    toNumber: '+15550002222',
  });
  const pq = createPendingQuestion(session.id, 'What is the gate code?');
  const request = createGuardianActionRequest({
    kind: 'ask_guardian',
    sourceChannel: 'voice',
    sourceConversationId: convId,
    callSessionId: session.id,
    pendingQuestionId: pq.id,
    questionText: pq.questionText,
    expiresAt: Date.now() - 10_000, // already expired
  });

  // Create delivery
  const deliveryConvId = opts?.conversationId ?? `delivery-conv-${request.id}`;
  if (opts?.conversationId) {
    ensureConversation(opts.conversationId);
  } else {
    ensureConversation(deliveryConvId);
  }
  const delivery = createGuardianActionDelivery({
    requestId: request.id,
    destinationChannel: 'telegram',
    destinationChatId: opts?.chatId ?? 'chat-123',
    destinationExternalUserId: opts?.externalUserId ?? 'user-456',
    destinationConversationId: deliveryConvId,
  });
  updateDeliveryStatus(delivery.id, 'sent');

  // Expire the request and delivery
  expireGuardianActionRequest(request.id, 'sweep_timeout');

  return { request: getGuardianActionRequest(request.id)!, delivery, deliveryConvId };
}

describe('guardian-action-late-reply', () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
  });

  // ── getExpiredDeliveriesByDestination ──────────────────────────────

  test('getExpiredDeliveriesByDestination returns expired deliveries for follow-up eligible requests', () => {
    const { request } = createExpiredRequest('conv-late-1', { chatId: 'chat-abc', externalUserId: 'user-xyz' });

    const deliveries = getExpiredDeliveriesByDestination('self', 'telegram', 'chat-abc');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].requestId).toBe(request.id);
    expect(deliveries[0].status).toBe('expired');
  });

  test('getExpiredDeliveriesByDestination returns empty for non-matching channel', () => {
    createExpiredRequest('conv-late-2', { chatId: 'chat-abc' });

    const deliveries = getExpiredDeliveriesByDestination('self', 'sms', 'chat-abc');
    expect(deliveries).toHaveLength(0);
  });

  test('getExpiredDeliveriesByDestination returns empty when followup already started', () => {
    const { request } = createExpiredRequest('conv-late-3', { chatId: 'chat-started' });

    // Start a follow-up, transitioning followup_state from 'none' to 'awaiting_guardian_choice'
    startFollowupFromExpiredRequest(request.id, 'late answer text');

    const deliveries = getExpiredDeliveriesByDestination('self', 'telegram', 'chat-started');
    expect(deliveries).toHaveLength(0);
  });

  // ── getExpiredDeliveryByConversation ───────────────────────────────

  test('getExpiredDeliveryByConversation returns expired delivery for mac channel', () => {
    const { delivery, deliveryConvId } = createExpiredRequest('conv-late-4', { conversationId: 'mac-conv-1' });

    const found = getExpiredDeliveryByConversation(deliveryConvId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(delivery.id);
  });

  test('getExpiredDeliveryByConversation returns null for non-matching conversation', () => {
    createExpiredRequest('conv-late-5', { conversationId: 'mac-conv-2' });

    const found = getExpiredDeliveryByConversation('nonexistent-conv');
    expect(found).toBeNull();
  });

  test('getExpiredDeliveryByConversation returns null when followup already started', () => {
    const { request, deliveryConvId } = createExpiredRequest('conv-late-6', { conversationId: 'mac-conv-3' });

    startFollowupFromExpiredRequest(request.id, 'already answered');

    const found = getExpiredDeliveryByConversation(deliveryConvId);
    expect(found).toBeNull();
  });

  // ── startFollowupFromExpiredRequest ───────────────────────────────

  test('startFollowupFromExpiredRequest transitions to awaiting_guardian_choice and records late answer', () => {
    const { request } = createExpiredRequest('conv-late-7');

    const updated = startFollowupFromExpiredRequest(request.id, 'The gate code is 1234');
    expect(updated).not.toBeNull();
    expect(updated!.followupState).toBe('awaiting_guardian_choice');
    expect(updated!.lateAnswerText).toBe('The gate code is 1234');
    expect(updated!.lateAnsweredAt).toBeGreaterThan(0);
  });

  test('startFollowupFromExpiredRequest returns null if followup already started', () => {
    const { request } = createExpiredRequest('conv-late-8');

    // First call succeeds
    const first = startFollowupFromExpiredRequest(request.id, 'answer 1');
    expect(first).not.toBeNull();

    // Second call fails — already in awaiting_guardian_choice
    const second = startFollowupFromExpiredRequest(request.id, 'answer 2');
    expect(second).toBeNull();
  });

  test('startFollowupFromExpiredRequest returns null for pending requests (not expired)', () => {
    const convId = 'conv-late-9';
    ensureConversation(convId);
    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'Still pending question');
    const request = createGuardianActionRequest({
      kind: 'ask_guardian',
      sourceChannel: 'voice',
      sourceConversationId: convId,
      callSessionId: session.id,
      pendingQuestionId: pq.id,
      questionText: pq.questionText,
      expiresAt: Date.now() + 60_000, // not expired
    });

    const result = startFollowupFromExpiredRequest(request.id, 'late answer');
    expect(result).toBeNull();
  });

  // ── Follow-up flow for already-answered requests ──────────────────

  test('already-answered requests do not appear in expired delivery queries', () => {
    const convId = 'conv-late-10';
    ensureConversation(convId);
    const session = createCallSession({
      conversationId: convId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pq = createPendingQuestion(session.id, 'Already answered question');
    const request = createGuardianActionRequest({
      kind: 'ask_guardian',
      sourceChannel: 'voice',
      sourceConversationId: convId,
      callSessionId: session.id,
      pendingQuestionId: pq.id,
      questionText: pq.questionText,
      expiresAt: Date.now() + 60_000,
    });

    const answeredConvId = 'answered-conv-1';
    ensureConversation(answeredConvId);
    const delivery = createGuardianActionDelivery({
      requestId: request.id,
      destinationChannel: 'telegram',
      destinationChatId: 'chat-answered',
      destinationExternalUserId: 'user-answered',
      destinationConversationId: answeredConvId,
    });
    updateDeliveryStatus(delivery.id, 'sent');

    // Answer the request (transitions to 'answered', not 'expired')
    resolveGuardianActionRequest(request.id, 'the code is 5678', 'telegram', 'user-answered');

    // Should not appear in expired queries
    const expiredByDest = getExpiredDeliveriesByDestination('self', 'telegram', 'chat-answered');
    expect(expiredByDest).toHaveLength(0);

    const expiredByConv = getExpiredDeliveryByConversation(answeredConvId);
    expect(expiredByConv).toBeNull();
  });

  // ── Composed follow-up text verification ──────────────────────────

  test('composeGuardianActionMessageGenerative produces follow-up text for late answer scenario', async () => {
    // The composer is tested directly rather than through the handler
    const { composeGuardianActionMessageGenerative } = await import('../runtime/guardian-action-message-composer.js');

    const text = await composeGuardianActionMessageGenerative({
      scenario: 'guardian_late_answer_followup',
      questionText: 'What is the gate code?',
      lateAnswerText: 'The gate code is 1234',
    });

    // In test mode, the deterministic fallback is used
    expect(text).toContain('called earlier');
    expect(text).toContain('call them back');
  });

  test('composeGuardianActionMessageGenerative produces stale text for expired scenario', async () => {
    const { composeGuardianActionMessageGenerative } = await import('../runtime/guardian-action-message-composer.js');

    const text = await composeGuardianActionMessageGenerative({
      scenario: 'guardian_stale_expired',
    });

    expect(text).toContain('expired');
  });

  // ── Multiple deliveries in one conversation (disambiguation) ──────

  describe('multi-delivery disambiguation in reused conversations', () => {
    // Helper to create a pending request with delivery in a shared conversation
    function createPendingInSharedConv(sourceConvId: string, sharedDeliveryConvId: string) {
      ensureConversation(sourceConvId);
      const session = createCallSession({
        conversationId: sourceConvId,
        provider: 'twilio',
        fromNumber: '+15550001111',
        toNumber: '+15550002222',
      });
      const pq = createPendingQuestion(session.id, `Question from ${sourceConvId}`);
      const request = createGuardianActionRequest({
        kind: 'ask_guardian',
        sourceChannel: 'voice',
        sourceConversationId: sourceConvId,
        callSessionId: session.id,
        pendingQuestionId: pq.id,
        questionText: pq.questionText,
        expiresAt: Date.now() + 60_000,
      });
      const delivery = createGuardianActionDelivery({
        requestId: request.id,
        destinationChannel: 'vellum',
        destinationConversationId: sharedDeliveryConvId,
      });
      updateDeliveryStatus(delivery.id, 'sent');
      return { request, delivery };
    }

    test('multiple pending deliveries in same conversation are returned by getPendingDeliveriesByConversation', () => {
      const sharedConv = 'shared-reused-conv-pending';
      ensureConversation(sharedConv);

      const { request: req1 } = createPendingInSharedConv('src-p1', sharedConv);
      const { request: req2 } = createPendingInSharedConv('src-p2', sharedConv);

      const deliveries = getPendingDeliveriesByConversation(sharedConv);
      expect(deliveries).toHaveLength(2);

      const requestIds = deliveries.map((d) => d.requestId);
      expect(requestIds).toContain(req1.id);
      expect(requestIds).toContain(req2.id);
    });

    test('request codes are unique across multiple requests in same conversation', () => {
      const sharedConv = 'shared-reused-conv-codes';
      ensureConversation(sharedConv);

      const { request: req1 } = createPendingInSharedConv('src-code1', sharedConv);
      const { request: req2 } = createPendingInSharedConv('src-code2', sharedConv);

      expect(req1.requestCode).not.toBe(req2.requestCode);
      expect(req1.requestCode).toHaveLength(6);
      expect(req2.requestCode).toHaveLength(6);
    });

    test('multiple expired deliveries in same conversation are returned by getExpiredDeliveriesByConversation', () => {
      const sharedConv = 'shared-reused-conv-expired';
      ensureConversation(sharedConv);

      const { request: req1 } = createPendingInSharedConv('src-e1', sharedConv);
      const { request: req2 } = createPendingInSharedConv('src-e2', sharedConv);

      expireGuardianActionRequest(req1.id, 'sweep_timeout');
      expireGuardianActionRequest(req2.id, 'sweep_timeout');

      const deliveries = getExpiredDeliveriesByConversation(sharedConv);
      expect(deliveries).toHaveLength(2);

      const requestIds = deliveries.map((d) => d.requestId);
      expect(requestIds).toContain(req1.id);
      expect(requestIds).toContain(req2.id);
    });

    test('multiple followup deliveries in same conversation are returned by getFollowupDeliveriesByConversation', () => {
      const sharedConv = 'shared-reused-conv-followup';
      ensureConversation(sharedConv);

      const { request: req1 } = createPendingInSharedConv('src-fu1', sharedConv);
      const { request: req2 } = createPendingInSharedConv('src-fu2', sharedConv);

      expireGuardianActionRequest(req1.id, 'sweep_timeout');
      expireGuardianActionRequest(req2.id, 'sweep_timeout');
      startFollowupFromExpiredRequest(req1.id, 'late answer 1');
      startFollowupFromExpiredRequest(req2.id, 'late answer 2');

      const deliveries = getFollowupDeliveriesByConversation(sharedConv);
      expect(deliveries).toHaveLength(2);

      const requestIds = deliveries.map((d) => d.requestId);
      expect(requestIds).toContain(req1.id);
      expect(requestIds).toContain(req2.id);
    });

    test('resolving one pending request leaves the other still pending in shared conversation', () => {
      const sharedConv = 'shared-reused-conv-resolve-one';
      ensureConversation(sharedConv);

      const { request: req1 } = createPendingInSharedConv('src-r1', sharedConv);
      const { request: req2 } = createPendingInSharedConv('src-r2', sharedConv);

      resolveGuardianActionRequest(req1.id, 'answer to first', 'vellum');

      const remaining = getPendingDeliveriesByConversation(sharedConv);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].requestId).toBe(req2.id);
    });

    test('request code prefix matching is case-insensitive', () => {
      const sharedConv = 'shared-reused-conv-case';
      ensureConversation(sharedConv);

      const { request: req1 } = createPendingInSharedConv('src-case1', sharedConv);
      const code = req1.requestCode; // e.g. "A1B2C3"

      // Simulate case-insensitive prefix matching as done in session-process.ts
      const userInput = `${code.toLowerCase()} the answer is 42`;
      const matched = userInput.toUpperCase().startsWith(code);
      expect(matched).toBe(true);

      // After stripping the code prefix, the answer text is extracted
      const answerText = userInput.slice(code.length).trim();
      expect(answerText).toBe('the answer is 42');
    });
  });
});
