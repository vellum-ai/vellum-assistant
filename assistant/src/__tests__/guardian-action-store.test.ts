import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'guardian-action-store-test-'));

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
import { createCallSession, createPendingQuestion } from '../calls/call-store.js';
import {
  createGuardianActionRequest,
  createGuardianActionDelivery,
  updateDeliveryStatus,
  cancelGuardianActionRequest,
  getGuardianActionRequest,
  getDeliveriesByRequestId,
} from '../memory/guardian-action-store.js';

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
  db.run('DELETE FROM conversations');
}

describe('guardian-action-store', () => {
  beforeEach(() => {
    resetTables();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  });

  test('cancelGuardianActionRequest cancels both pending and sent deliveries', () => {
    const conversationId = 'conv-guardian-cancel';
    ensureConversation(conversationId);

    const session = createCallSession({
      conversationId,
      provider: 'twilio',
      fromNumber: '+15550001111',
      toNumber: '+15550002222',
    });
    const pendingQuestion = createPendingQuestion(session.id, 'What is our gate code?');

    const request = createGuardianActionRequest({
      kind: 'ask_guardian',
      sourceChannel: 'voice',
      sourceConversationId: conversationId,
      callSessionId: session.id,
      pendingQuestionId: pendingQuestion.id,
      questionText: pendingQuestion.questionText,
      expiresAt: Date.now() + 60_000,
    });

    const pendingDelivery = createGuardianActionDelivery({
      requestId: request.id,
      destinationChannel: 'mac',
      destinationConversationId: 'conv-mac-guardian',
    });
    const sentDelivery = createGuardianActionDelivery({
      requestId: request.id,
      destinationChannel: 'telegram',
      destinationChatId: 'chat-guardian',
      destinationExternalUserId: 'guardian-user',
    });
    updateDeliveryStatus(sentDelivery.id, 'sent');

    cancelGuardianActionRequest(request.id);

    const updatedRequest = getGuardianActionRequest(request.id);
    expect(updatedRequest).not.toBeNull();
    expect(updatedRequest!.status).toBe('cancelled');

    const deliveries = getDeliveriesByRequestId(request.id);
    const pendingAfter = deliveries.find((d) => d.id === pendingDelivery.id);
    const sentAfter = deliveries.find((d) => d.id === sentDelivery.id);
    expect(pendingAfter?.status).toBe('cancelled');
    expect(sentAfter?.status).toBe('cancelled');
  });
});
