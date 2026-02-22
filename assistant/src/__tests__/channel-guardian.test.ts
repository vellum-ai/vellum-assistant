import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), 'channel-guardian-test-'));

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
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
  createBinding,
  getActiveBinding,
  revokeBinding,
  createChallenge,
  findPendingChallengeByHash,
  consumeChallenge,
  createApprovalRequest,
  getPendingApprovalForRun,
  getPendingApprovalByGuardianChat,
  updateApprovalDecision,
} from '../memory/channel-guardian-store.js';
import {
  createVerificationChallenge,
  validateAndConsumeChallenge,
  getGuardianBinding,
  isGuardian,
  revokeBinding as serviceRevokeBinding,
} from '../runtime/channel-guardian-service.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM channel_guardian_bindings');
  db.run('DELETE FROM channel_guardian_verification_challenges');
  db.run('DELETE FROM channel_guardian_approval_requests');
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Guardian Binding CRUD (Store)
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian binding CRUD', () => {
  beforeEach(() => {
    resetTables();
  });

  test('createBinding creates an active binding with correct fields', () => {
    const binding = createBinding({
      assistantId: 'asst-1',
      channel: 'telegram',
      guardianExternalUserId: 'user-42',
      guardianDeliveryChatId: 'chat-42',
    });

    expect(binding.id).toBeDefined();
    expect(binding.assistantId).toBe('asst-1');
    expect(binding.channel).toBe('telegram');
    expect(binding.guardianExternalUserId).toBe('user-42');
    expect(binding.guardianDeliveryChatId).toBe('chat-42');
    expect(binding.status).toBe('active');
    expect(binding.verifiedVia).toBe('challenge');
    expect(binding.verifiedAt).toBeGreaterThan(0);
    expect(binding.createdAt).toBeGreaterThan(0);
    expect(binding.updatedAt).toBeGreaterThan(0);
  });

  test('getActiveBinding returns the active binding', () => {
    createBinding({
      assistantId: 'asst-1',
      channel: 'telegram',
      guardianExternalUserId: 'user-42',
      guardianDeliveryChatId: 'chat-42',
    });

    const found = getActiveBinding('asst-1', 'telegram');
    expect(found).not.toBeNull();
    expect(found!.guardianExternalUserId).toBe('user-42');
  });

  test('getActiveBinding returns null when no binding exists', () => {
    const found = getActiveBinding('asst-1', 'telegram');
    expect(found).toBeNull();
  });

  test('getActiveBinding returns null for different assistant', () => {
    createBinding({
      assistantId: 'asst-1',
      channel: 'telegram',
      guardianExternalUserId: 'user-42',
      guardianDeliveryChatId: 'chat-42',
    });

    const found = getActiveBinding('asst-2', 'telegram');
    expect(found).toBeNull();
  });

  test('getActiveBinding returns null for different channel', () => {
    createBinding({
      assistantId: 'asst-1',
      channel: 'telegram',
      guardianExternalUserId: 'user-42',
      guardianDeliveryChatId: 'chat-42',
    });

    const found = getActiveBinding('asst-1', 'slack');
    expect(found).toBeNull();
  });

  test('revokeBinding transitions active binding to revoked', () => {
    createBinding({
      assistantId: 'asst-1',
      channel: 'telegram',
      guardianExternalUserId: 'user-42',
      guardianDeliveryChatId: 'chat-42',
    });

    const result = revokeBinding('asst-1', 'telegram');
    expect(result).toBe(true);

    const found = getActiveBinding('asst-1', 'telegram');
    expect(found).toBeNull();
  });

  test('revokeBinding returns false when no active binding exists', () => {
    const result = revokeBinding('asst-1', 'telegram');
    expect(result).toBe(false);
  });

  test('revokeBinding does not affect bindings on other channels', () => {
    createBinding({
      assistantId: 'asst-1',
      channel: 'telegram',
      guardianExternalUserId: 'user-42',
      guardianDeliveryChatId: 'chat-42',
    });
    createBinding({
      assistantId: 'asst-1',
      channel: 'slack',
      guardianExternalUserId: 'user-99',
      guardianDeliveryChatId: 'chat-99',
    });

    revokeBinding('asst-1', 'telegram');

    expect(getActiveBinding('asst-1', 'telegram')).toBeNull();
    expect(getActiveBinding('asst-1', 'slack')).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Verification Challenge Lifecycle (Store)
// ═══════════════════════════════════════════════════════════════════════════

describe('verification challenge lifecycle', () => {
  beforeEach(() => {
    resetTables();
  });

  test('createChallenge creates a pending challenge', () => {
    const challenge = createChallenge({
      id: 'chal-1',
      assistantId: 'asst-1',
      channel: 'telegram',
      challengeHash: 'abc123hash',
      expiresAt: Date.now() + 600_000,
    });

    expect(challenge.id).toBe('chal-1');
    expect(challenge.status).toBe('pending');
    expect(challenge.challengeHash).toBe('abc123hash');
    expect(challenge.consumedByExternalUserId).toBeNull();
    expect(challenge.consumedByChatId).toBeNull();
  });

  test('findPendingChallengeByHash finds a matching pending challenge', () => {
    createChallenge({
      id: 'chal-1',
      assistantId: 'asst-1',
      channel: 'telegram',
      challengeHash: 'abc123hash',
      expiresAt: Date.now() + 600_000,
    });

    const found = findPendingChallengeByHash('asst-1', 'telegram', 'abc123hash');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('chal-1');
  });

  test('findPendingChallengeByHash returns null for wrong hash', () => {
    createChallenge({
      id: 'chal-1',
      assistantId: 'asst-1',
      channel: 'telegram',
      challengeHash: 'abc123hash',
      expiresAt: Date.now() + 600_000,
    });

    const found = findPendingChallengeByHash('asst-1', 'telegram', 'wrong-hash');
    expect(found).toBeNull();
  });

  test('findPendingChallengeByHash returns null for expired challenge', () => {
    createChallenge({
      id: 'chal-1',
      assistantId: 'asst-1',
      channel: 'telegram',
      challengeHash: 'abc123hash',
      expiresAt: Date.now() - 1000, // already expired
    });

    const found = findPendingChallengeByHash('asst-1', 'telegram', 'abc123hash');
    expect(found).toBeNull();
  });

  test('consumeChallenge marks challenge as consumed', () => {
    createChallenge({
      id: 'chal-1',
      assistantId: 'asst-1',
      channel: 'telegram',
      challengeHash: 'abc123hash',
      expiresAt: Date.now() + 600_000,
    });

    consumeChallenge('chal-1', 'user-42', 'chat-42');

    // After consumption, findPendingChallengeByHash should return null
    const found = findPendingChallengeByHash('asst-1', 'telegram', 'abc123hash');
    expect(found).toBeNull();
  });

  test('consumed challenge cannot be found again (replay prevention)', () => {
    createChallenge({
      id: 'chal-1',
      assistantId: 'asst-1',
      channel: 'telegram',
      challengeHash: 'abc123hash',
      expiresAt: Date.now() + 600_000,
    });

    // First consumption succeeds
    const found1 = findPendingChallengeByHash('asst-1', 'telegram', 'abc123hash');
    expect(found1).not.toBeNull();
    consumeChallenge('chal-1', 'user-42', 'chat-42');

    // Second lookup returns null because challenge is consumed
    const found2 = findPendingChallengeByHash('asst-1', 'telegram', 'abc123hash');
    expect(found2).toBeNull();
  });

  test('findPendingChallengeByHash scoped to assistant and channel', () => {
    createChallenge({
      id: 'chal-1',
      assistantId: 'asst-1',
      channel: 'telegram',
      challengeHash: 'abc123hash',
      expiresAt: Date.now() + 600_000,
    });

    // Different assistant
    expect(findPendingChallengeByHash('asst-2', 'telegram', 'abc123hash')).toBeNull();
    // Different channel
    expect(findPendingChallengeByHash('asst-1', 'slack', 'abc123hash')).toBeNull();
    // Correct match
    expect(findPendingChallengeByHash('asst-1', 'telegram', 'abc123hash')).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Guardian Service — Challenge Validation
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian service challenge validation', () => {
  beforeEach(() => {
    resetTables();
  });

  test('createVerificationChallenge returns a secret and instruction', () => {
    const result = createVerificationChallenge('asst-1', 'telegram');

    expect(result.challengeId).toBeDefined();
    expect(result.secret).toBeDefined();
    expect(result.secret.length).toBe(64); // 32 bytes hex-encoded
    expect(result.instruction).toContain('/guardian_verify');
    expect(result.instruction).toContain(result.secret);
  });

  test('createVerificationChallenge instruction mentions Telegram for telegram channel', () => {
    const result = createVerificationChallenge('asst-1', 'telegram');
    expect(result.instruction).toContain('via Telegram');
    expect(result.instruction).not.toContain('via SMS');
  });

  test('createVerificationChallenge instruction mentions SMS for sms channel', () => {
    const result = createVerificationChallenge('asst-1', 'sms');
    expect(result.instruction).toContain('via SMS');
    expect(result.instruction).not.toContain('via Telegram');
    expect(result.instruction).toContain('/guardian_verify');
    expect(result.instruction).toContain(result.secret);
  });

  test('validateAndConsumeChallenge succeeds with correct secret', () => {
    const { secret } = createVerificationChallenge('asst-1', 'telegram');

    const result = validateAndConsumeChallenge(
      'asst-1',
      'telegram',
      secret,
      'user-42',
      'chat-42',
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.bindingId).toBeDefined();
    }
  });

  test('validateAndConsumeChallenge creates a guardian binding', () => {
    const { secret } = createVerificationChallenge('asst-1', 'telegram');

    validateAndConsumeChallenge('asst-1', 'telegram', secret, 'user-42', 'chat-42');

    const binding = getActiveBinding('asst-1', 'telegram');
    expect(binding).not.toBeNull();
    expect(binding!.guardianExternalUserId).toBe('user-42');
    expect(binding!.guardianDeliveryChatId).toBe('chat-42');
    expect(binding!.verifiedVia).toBe('challenge');
  });

  test('validateAndConsumeChallenge fails with wrong secret', () => {
    createVerificationChallenge('asst-1', 'telegram');

    const result = validateAndConsumeChallenge(
      'asst-1',
      'telegram',
      'wrong-secret',
      'user-42',
      'chat-42',
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toContain('Invalid or expired');
    }
  });

  test('validateAndConsumeChallenge fails with expired challenge', () => {
    // Create a challenge that is already expired by inserting directly
    const secret = 'test-secret-expired';
    const challengeHash = createHash('sha256').update(secret).digest('hex');
    createChallenge({
      id: 'chal-expired',
      assistantId: 'asst-1',
      channel: 'telegram',
      challengeHash,
      expiresAt: Date.now() - 1000, // already expired
    });

    const result = validateAndConsumeChallenge(
      'asst-1',
      'telegram',
      secret,
      'user-42',
      'chat-42',
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toContain('Invalid or expired');
    }
  });

  test('consumed challenge cannot be reused', () => {
    const { secret } = createVerificationChallenge('asst-1', 'telegram');

    // First use succeeds
    const result1 = validateAndConsumeChallenge(
      'asst-1',
      'telegram',
      secret,
      'user-42',
      'chat-42',
    );
    expect(result1.success).toBe(true);

    // Second use with same secret fails (replay prevention)
    const result2 = validateAndConsumeChallenge(
      'asst-1',
      'telegram',
      secret,
      'user-99',
      'chat-99',
    );
    expect(result2.success).toBe(false);
  });

  test('validateAndConsumeChallenge succeeds with sms channel', () => {
    const { secret } = createVerificationChallenge('asst-1', 'sms');

    const result = validateAndConsumeChallenge(
      'asst-1',
      'sms',
      secret,
      'phone-user-1',
      'sms-chat-1',
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.bindingId).toBeDefined();
    }

    // Verify the binding was created for the sms channel
    const binding = getActiveBinding('asst-1', 'sms');
    expect(binding).not.toBeNull();
    expect(binding!.guardianExternalUserId).toBe('phone-user-1');
    expect(binding!.guardianDeliveryChatId).toBe('sms-chat-1');
    expect(binding!.channel).toBe('sms');
  });

  test('sms and telegram guardian challenges are independent', () => {
    const telegramChallenge = createVerificationChallenge('asst-1', 'telegram');
    const smsChallenge = createVerificationChallenge('asst-1', 'sms');

    // Validate SMS challenge against telegram channel should fail
    const crossResult = validateAndConsumeChallenge(
      'asst-1',
      'telegram',
      smsChallenge.secret,
      'user-1',
      'chat-1',
    );
    expect(crossResult.success).toBe(false);

    // Validate SMS challenge against correct channel should succeed
    const smsResult = validateAndConsumeChallenge(
      'asst-1',
      'sms',
      smsChallenge.secret,
      'user-1',
      'chat-1',
    );
    expect(smsResult.success).toBe(true);

    // Telegram challenge should still be valid
    const telegramResult = validateAndConsumeChallenge(
      'asst-1',
      'telegram',
      telegramChallenge.secret,
      'user-2',
      'chat-2',
    );
    expect(telegramResult.success).toBe(true);
  });

  test('validateAndConsumeChallenge revokes existing binding before creating new one', () => {
    // Create initial guardian binding
    createBinding({
      assistantId: 'asst-1',
      channel: 'telegram',
      guardianExternalUserId: 'old-user',
      guardianDeliveryChatId: 'old-chat',
    });

    const oldBinding = getActiveBinding('asst-1', 'telegram');
    expect(oldBinding).not.toBeNull();
    expect(oldBinding!.guardianExternalUserId).toBe('old-user');

    // Verify with a new user
    const { secret } = createVerificationChallenge('asst-1', 'telegram');
    validateAndConsumeChallenge('asst-1', 'telegram', secret, 'new-user', 'new-chat');

    // The old binding should be revoked, new one active
    const newBinding = getActiveBinding('asst-1', 'telegram');
    expect(newBinding).not.toBeNull();
    expect(newBinding!.guardianExternalUserId).toBe('new-user');
    expect(newBinding!.guardianDeliveryChatId).toBe('new-chat');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Guardian Identity Check (Service)
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian identity check', () => {
  beforeEach(() => {
    resetTables();
  });

  test('isGuardian returns true for matching user', () => {
    createBinding({
      assistantId: 'asst-1',
      channel: 'telegram',
      guardianExternalUserId: 'user-42',
      guardianDeliveryChatId: 'chat-42',
    });

    expect(isGuardian('asst-1', 'telegram', 'user-42')).toBe(true);
  });

  test('isGuardian returns false for non-matching user', () => {
    createBinding({
      assistantId: 'asst-1',
      channel: 'telegram',
      guardianExternalUserId: 'user-42',
      guardianDeliveryChatId: 'chat-42',
    });

    expect(isGuardian('asst-1', 'telegram', 'user-99')).toBe(false);
  });

  test('isGuardian returns false when no binding exists', () => {
    expect(isGuardian('asst-1', 'telegram', 'user-42')).toBe(false);
  });

  test('isGuardian returns false after binding is revoked', () => {
    createBinding({
      assistantId: 'asst-1',
      channel: 'telegram',
      guardianExternalUserId: 'user-42',
      guardianDeliveryChatId: 'chat-42',
    });

    revokeBinding('asst-1', 'telegram');

    expect(isGuardian('asst-1', 'telegram', 'user-42')).toBe(false);
  });

  test('getGuardianBinding returns the active binding', () => {
    createBinding({
      assistantId: 'asst-1',
      channel: 'telegram',
      guardianExternalUserId: 'user-42',
      guardianDeliveryChatId: 'chat-42',
    });

    const binding = getGuardianBinding('asst-1', 'telegram');
    expect(binding).not.toBeNull();
    expect(binding!.guardianExternalUserId).toBe('user-42');
  });

  test('getGuardianBinding returns null when no binding exists', () => {
    const binding = getGuardianBinding('asst-1', 'telegram');
    expect(binding).toBeNull();
  });

  test('isGuardian works for sms channel', () => {
    createBinding({
      assistantId: 'asst-1',
      channel: 'sms',
      guardianExternalUserId: 'phone-user-1',
      guardianDeliveryChatId: 'sms-chat-1',
    });

    expect(isGuardian('asst-1', 'sms', 'phone-user-1')).toBe(true);
    expect(isGuardian('asst-1', 'sms', 'phone-user-2')).toBe(false);
    // Telegram guardian should not match sms channel
    expect(isGuardian('asst-1', 'telegram', 'phone-user-1')).toBe(false);
  });

  test('serviceRevokeBinding revokes the active binding', () => {
    createBinding({
      assistantId: 'asst-1',
      channel: 'telegram',
      guardianExternalUserId: 'user-42',
      guardianDeliveryChatId: 'chat-42',
    });

    const result = serviceRevokeBinding('asst-1', 'telegram');
    expect(result).toBe(true);
    expect(getGuardianBinding('asst-1', 'telegram')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Approval Request CRUD (Store)
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian approval request CRUD', () => {
  beforeEach(() => {
    resetTables();
  });

  test('createApprovalRequest creates a pending request', () => {
    const request = createApprovalRequest({
      runId: 'run-1',
      conversationId: 'conv-1',
      channel: 'telegram',
      requesterExternalUserId: 'user-99',
      requesterChatId: 'chat-99',
      guardianExternalUserId: 'user-42',
      guardianChatId: 'chat-42',
      toolName: 'shell',
      riskLevel: 'high',
      reason: 'Executing rm command',
      expiresAt: Date.now() + 300_000,
    });

    expect(request.id).toBeDefined();
    expect(request.runId).toBe('run-1');
    expect(request.status).toBe('pending');
    expect(request.toolName).toBe('shell');
    expect(request.riskLevel).toBe('high');
    expect(request.reason).toBe('Executing rm command');
    expect(request.decidedByExternalUserId).toBeNull();
  });

  test('getPendingApprovalForRun returns the pending request', () => {
    createApprovalRequest({
      runId: 'run-1',
      conversationId: 'conv-1',
      channel: 'telegram',
      requesterExternalUserId: 'user-99',
      requesterChatId: 'chat-99',
      guardianExternalUserId: 'user-42',
      guardianChatId: 'chat-42',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    const found = getPendingApprovalForRun('run-1');
    expect(found).not.toBeNull();
    expect(found!.runId).toBe('run-1');
    expect(found!.status).toBe('pending');
  });

  test('getPendingApprovalForRun returns null when no pending request exists', () => {
    const found = getPendingApprovalForRun('run-nonexistent');
    expect(found).toBeNull();
  });

  test('getPendingApprovalByGuardianChat returns pending request for guardian chat', () => {
    createApprovalRequest({
      runId: 'run-1',
      conversationId: 'conv-1',
      channel: 'telegram',
      requesterExternalUserId: 'user-99',
      requesterChatId: 'chat-99',
      guardianExternalUserId: 'user-42',
      guardianChatId: 'chat-42',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    const found = getPendingApprovalByGuardianChat('telegram', 'chat-42');
    expect(found).not.toBeNull();
    expect(found!.guardianChatId).toBe('chat-42');
  });

  test('getPendingApprovalByGuardianChat returns null for wrong channel', () => {
    createApprovalRequest({
      runId: 'run-1',
      conversationId: 'conv-1',
      channel: 'telegram',
      requesterExternalUserId: 'user-99',
      requesterChatId: 'chat-99',
      guardianExternalUserId: 'user-42',
      guardianChatId: 'chat-42',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    const found = getPendingApprovalByGuardianChat('slack', 'chat-42');
    expect(found).toBeNull();
  });

  test('updateApprovalDecision updates status to approved', () => {
    const request = createApprovalRequest({
      runId: 'run-1',
      conversationId: 'conv-1',
      channel: 'telegram',
      requesterExternalUserId: 'user-99',
      requesterChatId: 'chat-99',
      guardianExternalUserId: 'user-42',
      guardianChatId: 'chat-42',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    updateApprovalDecision(request.id, {
      status: 'approved',
      decidedByExternalUserId: 'user-42',
    });

    // After approval, getPendingApprovalForRun should return null
    const found = getPendingApprovalForRun('run-1');
    expect(found).toBeNull();
  });

  test('updateApprovalDecision updates status to denied', () => {
    const request = createApprovalRequest({
      runId: 'run-1',
      conversationId: 'conv-1',
      channel: 'telegram',
      requesterExternalUserId: 'user-99',
      requesterChatId: 'chat-99',
      guardianExternalUserId: 'user-42',
      guardianChatId: 'chat-42',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    updateApprovalDecision(request.id, {
      status: 'denied',
      decidedByExternalUserId: 'user-42',
    });

    const found = getPendingApprovalForRun('run-1');
    expect(found).toBeNull();
  });

  test('multiple approval requests for different runs are independent', () => {
    createApprovalRequest({
      runId: 'run-1',
      conversationId: 'conv-1',
      channel: 'telegram',
      requesterExternalUserId: 'user-99',
      requesterChatId: 'chat-99',
      guardianExternalUserId: 'user-42',
      guardianChatId: 'chat-42',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    createApprovalRequest({
      runId: 'run-2',
      conversationId: 'conv-2',
      channel: 'telegram',
      requesterExternalUserId: 'user-88',
      requesterChatId: 'chat-88',
      guardianExternalUserId: 'user-42',
      guardianChatId: 'chat-42',
      toolName: 'browser',
      expiresAt: Date.now() + 300_000,
    });

    const found1 = getPendingApprovalForRun('run-1');
    const found2 = getPendingApprovalForRun('run-2');
    expect(found1).not.toBeNull();
    expect(found2).not.toBeNull();
    expect(found1!.toolName).toBe('shell');
    expect(found2!.toolName).toBe('browser');
  });

  test('createApprovalRequest works for sms channel', () => {
    const request = createApprovalRequest({
      runId: 'run-sms-1',
      conversationId: 'conv-sms-1',
      channel: 'sms',
      requesterExternalUserId: 'phone-user-99',
      requesterChatId: 'sms-chat-99',
      guardianExternalUserId: 'phone-user-42',
      guardianChatId: 'sms-chat-42',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    expect(request.id).toBeDefined();
    expect(request.runId).toBe('run-sms-1');
    expect(request.channel).toBe('sms');
    expect(request.status).toBe('pending');

    const found = getPendingApprovalForRun('run-sms-1');
    expect(found).not.toBeNull();
    expect(found!.channel).toBe('sms');
  });

  test('getPendingApprovalByGuardianChat works for sms channel', () => {
    createApprovalRequest({
      runId: 'run-sms-2',
      conversationId: 'conv-sms-2',
      channel: 'sms',
      requesterExternalUserId: 'phone-user-99',
      requesterChatId: 'sms-chat-99',
      guardianExternalUserId: 'phone-user-42',
      guardianChatId: 'sms-chat-42',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    const found = getPendingApprovalByGuardianChat('sms', 'sms-chat-42');
    expect(found).not.toBeNull();
    expect(found!.channel).toBe('sms');

    // Should not find it under a different channel
    const notFound = getPendingApprovalByGuardianChat('telegram', 'sms-chat-42');
    expect(notFound).toBeNull();
  });

  test('createApprovalRequest with optional fields omitted defaults to null', () => {
    const request = createApprovalRequest({
      runId: 'run-1',
      conversationId: 'conv-1',
      channel: 'telegram',
      requesterExternalUserId: 'user-99',
      requesterChatId: 'chat-99',
      guardianExternalUserId: 'user-42',
      guardianChatId: 'chat-42',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });

    expect(request.riskLevel).toBeNull();
    expect(request.reason).toBeNull();
  });
});
