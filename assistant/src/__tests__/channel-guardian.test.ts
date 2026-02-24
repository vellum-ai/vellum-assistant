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
  getRateLimit,
  recordInvalidAttempt,
  resetRateLimit,
} from '../memory/channel-guardian-store.js';
import {
  createVerificationChallenge,
  validateAndConsumeChallenge,
  getGuardianBinding,
  isGuardian,
  revokeBinding as serviceRevokeBinding,
} from '../runtime/channel-guardian-service.js';
import { handleGuardianVerification } from '../daemon/handlers/config.js';
import type { GuardianVerificationRequest, GuardianVerificationResponse } from '../daemon/ipc-contract.js';
import type { HandlerContext } from '../daemon/handlers/shared.js';
import type * as net from 'node:net';

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
  db.run('DELETE FROM channel_guardian_rate_limits');
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

  test('createVerificationChallenge returns a secret, verifyCommand, ttlSeconds, and instruction', () => {
    const result = createVerificationChallenge('asst-1', 'telegram');

    expect(result.challengeId).toBeDefined();
    expect(result.secret).toBeDefined();
    expect(result.secret.length).toBe(64); // 32 bytes hex-encoded
    expect(result.verifyCommand).toBe(`/guardian_verify ${result.secret}`);
    expect(result.ttlSeconds).toBe(600);
    expect(result.instruction).toBeDefined();
    expect(result.instruction.length).toBeGreaterThan(0);
    expect(result.instruction).toContain('/guardian_verify');
  });

  test('createVerificationChallenge produces a non-empty instruction for telegram channel', () => {
    const result = createVerificationChallenge('asst-1', 'telegram');
    expect(result.instruction).toBeDefined();
    expect(result.instruction.length).toBeGreaterThan(0);
    expect(result.instruction).toContain(result.verifyCommand);
  });

  test('createVerificationChallenge produces a non-empty instruction for sms channel', () => {
    const result = createVerificationChallenge('asst-1', 'sms');
    expect(result.instruction).toBeDefined();
    expect(result.instruction.length).toBeGreaterThan(0);
    expect(result.instruction).toContain('/guardian_verify');
    expect(result.instruction).toContain(result.verifyCommand);
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
      // Composed failure message — check it is non-empty and contains "failed"
      expect(result.reason).toBeDefined();
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason.toLowerCase()).toContain('failed');
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
      // Composed failure message — check it is non-empty and contains "failed"
      expect(result.reason).toBeDefined();
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason.toLowerCase()).toContain('failed');
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

// ═══════════════════════════════════════════════════════════════════════════
// 6. Verification Rate Limiting (Store)
// ═══════════════════════════════════════════════════════════════════════════

describe('verification rate limiting store', () => {
  beforeEach(() => {
    resetTables();
  });

  test('getRateLimit returns null when no record exists', () => {
    const rl = getRateLimit('asst-1', 'telegram', 'user-42', 'chat-42');
    expect(rl).toBeNull();
  });

  test('recordInvalidAttempt creates a new record on first failure', () => {
    const rl = recordInvalidAttempt('asst-1', 'telegram', 'user-42', 'chat-42', 900_000, 5, 1_800_000);
    expect(rl.invalidAttempts).toBe(1);
    expect(rl.lockedUntil).toBeNull();
    expect(rl.assistantId).toBe('asst-1');
    expect(rl.channel).toBe('telegram');
    expect(rl.actorExternalUserId).toBe('user-42');
  });

  test('recordInvalidAttempt increments counter on subsequent failures', () => {
    recordInvalidAttempt('asst-1', 'telegram', 'user-42', 'chat-42', 900_000, 5, 1_800_000);
    recordInvalidAttempt('asst-1', 'telegram', 'user-42', 'chat-42', 900_000, 5, 1_800_000);
    const rl = recordInvalidAttempt('asst-1', 'telegram', 'user-42', 'chat-42', 900_000, 5, 1_800_000);
    expect(rl.invalidAttempts).toBe(3);
    expect(rl.lockedUntil).toBeNull();
  });

  test('recordInvalidAttempt sets lockedUntil when max attempts reached', () => {
    for (let i = 0; i < 4; i++) {
      recordInvalidAttempt('asst-1', 'telegram', 'user-42', 'chat-42', 900_000, 5, 1_800_000);
    }
    const rl = recordInvalidAttempt('asst-1', 'telegram', 'user-42', 'chat-42', 900_000, 5, 1_800_000);
    expect(rl.invalidAttempts).toBe(5);
    expect(rl.lockedUntil).not.toBeNull();
    expect(rl.lockedUntil!).toBeGreaterThan(Date.now());
  });

  test('resetRateLimit clears the counter and lockout', () => {
    for (let i = 0; i < 5; i++) {
      recordInvalidAttempt('asst-1', 'telegram', 'user-42', 'chat-42', 900_000, 5, 1_800_000);
    }
    const locked = getRateLimit('asst-1', 'telegram', 'user-42', 'chat-42');
    expect(locked).not.toBeNull();
    expect(locked!.lockedUntil).not.toBeNull();

    resetRateLimit('asst-1', 'telegram', 'user-42', 'chat-42');

    const after = getRateLimit('asst-1', 'telegram', 'user-42', 'chat-42');
    expect(after).not.toBeNull();
    expect(after!.invalidAttempts).toBe(0);
    expect(after!.lockedUntil).toBeNull();
  });

  test('rate limits are scoped per actor and channel', () => {
    recordInvalidAttempt('asst-1', 'telegram', 'user-42', 'chat-42', 900_000, 5, 1_800_000);
    recordInvalidAttempt('asst-1', 'telegram', 'user-99', 'chat-99', 900_000, 5, 1_800_000);

    const rl42 = getRateLimit('asst-1', 'telegram', 'user-42', 'chat-42');
    const rl99 = getRateLimit('asst-1', 'telegram', 'user-99', 'chat-99');
    const rlSms = getRateLimit('asst-1', 'sms', 'user-42', 'chat-42');

    expect(rl42).not.toBeNull();
    expect(rl42!.invalidAttempts).toBe(1);
    expect(rl99).not.toBeNull();
    expect(rl99!.invalidAttempts).toBe(1);
    expect(rlSms).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Verification Rate Limiting (Service — end-to-end)
// ═══════════════════════════════════════════════════════════════════════════

describe('guardian service rate limiting', () => {
  beforeEach(() => {
    resetTables();
  });

  test('repeated invalid submissions hit rate limit', () => {
    // Create a valid challenge so there is a pending challenge
    createVerificationChallenge('asst-1', 'telegram');

    // Submit wrong codes repeatedly
    for (let i = 0; i < 5; i++) {
      const result = validateAndConsumeChallenge(
        'asst-1', 'telegram', `wrong-secret-${i}`, 'user-42', 'chat-42',
      );
      expect(result.success).toBe(false);
    }

    // The 6th attempt should be rate-limited even without a new challenge
    const result = validateAndConsumeChallenge(
      'asst-1', 'telegram', 'another-wrong', 'user-42', 'chat-42',
    );
    expect(result.success).toBe(false);
    expect((result as { reason: string }).reason).toBeDefined();
    expect((result as { reason: string }).reason.length).toBeGreaterThan(0);
    expect((result as { reason: string }).reason.toLowerCase()).toContain('failed');

    // Verify the rate limit record
    const rl = getRateLimit('asst-1', 'telegram', 'user-42', 'chat-42');
    expect(rl).not.toBeNull();
    expect(rl!.lockedUntil).not.toBeNull();
  });

  test('valid challenge still succeeds when under threshold', () => {
    // Record a couple invalid attempts
    const { secret: _secret } = createVerificationChallenge('asst-1', 'telegram');
    validateAndConsumeChallenge('asst-1', 'telegram', 'wrong-1', 'user-42', 'chat-42');
    validateAndConsumeChallenge('asst-1', 'telegram', 'wrong-2', 'user-42', 'chat-42');

    // Valid attempt should still succeed (under the 5-attempt threshold)
    // Need a new challenge since the old one is still pending but the secret was never consumed
    const { secret: secret2 } = createVerificationChallenge('asst-1', 'telegram');
    const result = validateAndConsumeChallenge(
      'asst-1', 'telegram', secret2, 'user-42', 'chat-42',
    );
    expect(result.success).toBe(true);

    // Rate limit should be reset after success
    const rl = getRateLimit('asst-1', 'telegram', 'user-42', 'chat-42');
    expect(rl).not.toBeNull();
    expect(rl!.invalidAttempts).toBe(0);
    expect(rl!.lockedUntil).toBeNull();
  });

  test('rate-limit uses generic failure message (no oracle leakage)', () => {
    createVerificationChallenge('asst-1', 'telegram');

    // Capture a normal invalid-code failure response
    const normalFailure = validateAndConsumeChallenge(
      'asst-1', 'telegram', 'wrong-first', 'user-42', 'chat-42',
    );
    expect(normalFailure.success).toBe(false);
    const normalReason = (normalFailure as { reason: string }).reason;

    // Trigger rate limit (4 more attempts to reach 5 total)
    for (let i = 0; i < 4; i++) {
      validateAndConsumeChallenge(
        'asst-1', 'telegram', `wrong-${i}`, 'user-42', 'chat-42',
      );
    }

    // Verify lockout is actually active before making the rate-limited call
    const rl = getRateLimit('asst-1', 'telegram', 'user-42', 'chat-42');
    expect(rl).not.toBeNull();
    expect(rl!.lockedUntil).not.toBeNull();

    // The rate-limited response should be indistinguishable from normal failure
    const rateLimitedResult = validateAndConsumeChallenge(
      'asst-1', 'telegram', 'anything', 'user-42', 'chat-42',
    );
    expect(rateLimitedResult.success).toBe(false);
    const rateLimitedReason = (rateLimitedResult as { reason: string }).reason;

    // Anti-oracle: both responses must be identical
    expect(rateLimitedReason).toBe(normalReason);

    // Neither should reveal rate-limiting info
    expect(rateLimitedReason).not.toContain('rate limit');
    expect(normalReason).not.toContain('rate limit');
  });

  test('rate limit does not affect different actors', () => {
    // Rate-limit user-42
    createVerificationChallenge('asst-1', 'telegram');
    for (let i = 0; i < 5; i++) {
      validateAndConsumeChallenge('asst-1', 'telegram', `wrong-${i}`, 'user-42', 'chat-42');
    }

    // user-99 should still be able to verify
    const { secret } = createVerificationChallenge('asst-1', 'telegram');
    const result = validateAndConsumeChallenge(
      'asst-1', 'telegram', secret, 'user-99', 'chat-99',
    );
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Assistant-scoped guardian resolution
// ═══════════════════════════════════════════════════════════════════════════

describe('assistant-scoped guardian resolution', () => {
  beforeEach(() => {
    resetTables();
  });

  test('isGuardian resolves independently per assistantId', () => {
    // Create guardian binding for asst-A on telegram
    createBinding({
      assistantId: 'asst-A',
      channel: 'telegram',
      guardianExternalUserId: 'user-alpha',
      guardianDeliveryChatId: 'chat-alpha',
    });
    // Create guardian binding for asst-B on telegram with a different user
    createBinding({
      assistantId: 'asst-B',
      channel: 'telegram',
      guardianExternalUserId: 'user-beta',
      guardianDeliveryChatId: 'chat-beta',
    });

    // user-alpha is guardian for asst-A but not asst-B
    expect(isGuardian('asst-A', 'telegram', 'user-alpha')).toBe(true);
    expect(isGuardian('asst-B', 'telegram', 'user-alpha')).toBe(false);

    // user-beta is guardian for asst-B but not asst-A
    expect(isGuardian('asst-B', 'telegram', 'user-beta')).toBe(true);
    expect(isGuardian('asst-A', 'telegram', 'user-beta')).toBe(false);
  });

  test('getGuardianBinding returns different bindings for different assistants', () => {
    createBinding({
      assistantId: 'asst-A',
      channel: 'telegram',
      guardianExternalUserId: 'user-alpha',
      guardianDeliveryChatId: 'chat-alpha',
    });
    createBinding({
      assistantId: 'asst-B',
      channel: 'telegram',
      guardianExternalUserId: 'user-beta',
      guardianDeliveryChatId: 'chat-beta',
    });

    const bindingA = getGuardianBinding('asst-A', 'telegram');
    const bindingB = getGuardianBinding('asst-B', 'telegram');

    expect(bindingA).not.toBeNull();
    expect(bindingB).not.toBeNull();
    expect(bindingA!.guardianExternalUserId).toBe('user-alpha');
    expect(bindingB!.guardianExternalUserId).toBe('user-beta');
  });

  test('revoking binding for one assistant does not affect another', () => {
    createBinding({
      assistantId: 'asst-A',
      channel: 'telegram',
      guardianExternalUserId: 'user-alpha',
      guardianDeliveryChatId: 'chat-alpha',
    });
    createBinding({
      assistantId: 'asst-B',
      channel: 'telegram',
      guardianExternalUserId: 'user-beta',
      guardianDeliveryChatId: 'chat-beta',
    });

    serviceRevokeBinding('asst-A', 'telegram');

    expect(getGuardianBinding('asst-A', 'telegram')).toBeNull();
    expect(getGuardianBinding('asst-B', 'telegram')).not.toBeNull();
  });

  test('validateAndConsumeChallenge scoped to assistantId', () => {
    // Create challenge for asst-A
    const { secret: secretA } = createVerificationChallenge('asst-A', 'telegram');
    // Create challenge for asst-B
    const { secret: secretB } = createVerificationChallenge('asst-B', 'telegram');

    // Attempting to consume asst-A challenge with asst-B should fail
    const crossResult = validateAndConsumeChallenge(
      'asst-B', 'telegram', secretA, 'user-1', 'chat-1',
    );
    expect(crossResult.success).toBe(false);

    // Consuming with correct assistantId should succeed
    const resultA = validateAndConsumeChallenge(
      'asst-A', 'telegram', secretA, 'user-1', 'chat-1',
    );
    expect(resultA.success).toBe(true);

    const resultB = validateAndConsumeChallenge(
      'asst-B', 'telegram', secretB, 'user-2', 'chat-2',
    );
    expect(resultB.success).toBe(true);

    // Verify bindings are scoped correctly
    const bindingA = getGuardianBinding('asst-A', 'telegram');
    const bindingB = getGuardianBinding('asst-B', 'telegram');
    expect(bindingA!.guardianExternalUserId).toBe('user-1');
    expect(bindingB!.guardianExternalUserId).toBe('user-2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Assistant-scoped approval request lookups
// ═══════════════════════════════════════════════════════════════════════════

describe('assistant-scoped approval request lookups', () => {
  beforeEach(() => {
    resetTables();
  });

  test('createApprovalRequest stores assistantId and defaults to self', () => {
    const reqWithoutId = createApprovalRequest({
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
    expect(reqWithoutId.assistantId).toBe('self');

    const reqWithId = createApprovalRequest({
      runId: 'run-2',
      conversationId: 'conv-2',
      assistantId: 'asst-A',
      channel: 'telegram',
      requesterExternalUserId: 'user-99',
      requesterChatId: 'chat-99',
      guardianExternalUserId: 'user-42',
      guardianChatId: 'chat-42',
      toolName: 'browser',
      expiresAt: Date.now() + 300_000,
    });
    expect(reqWithId.assistantId).toBe('asst-A');
  });

  test('approval requests from different assistants are independent', () => {
    createApprovalRequest({
      runId: 'run-A',
      conversationId: 'conv-A',
      assistantId: 'asst-A',
      channel: 'telegram',
      requesterExternalUserId: 'user-99',
      requesterChatId: 'chat-99',
      guardianExternalUserId: 'user-42',
      guardianChatId: 'chat-42',
      toolName: 'shell',
      expiresAt: Date.now() + 300_000,
    });
    createApprovalRequest({
      runId: 'run-B',
      conversationId: 'conv-B',
      assistantId: 'asst-B',
      channel: 'telegram',
      requesterExternalUserId: 'user-88',
      requesterChatId: 'chat-88',
      guardianExternalUserId: 'user-42',
      guardianChatId: 'chat-42',
      toolName: 'browser',
      expiresAt: Date.now() + 300_000,
    });

    const foundA = getPendingApprovalForRun('run-A');
    const foundB = getPendingApprovalForRun('run-B');
    expect(foundA).not.toBeNull();
    expect(foundB).not.toBeNull();
    expect(foundA!.assistantId).toBe('asst-A');
    expect(foundB!.assistantId).toBe('asst-B');
    expect(foundA!.toolName).toBe('shell');
    expect(foundB!.toolName).toBe('browser');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. IPC handler — channel-aware guardian status response
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a minimal mock HandlerContext that captures the response sent via ctx.send().
 */
function createMockCtx(): { ctx: HandlerContext; lastResponse: () => GuardianVerificationResponse | null } {
  let captured: GuardianVerificationResponse | null = null;
  const ctx = {
    sessions: new Map(),
    socketToSession: new Map(),
    cuSessions: new Map(),
    socketToCuSession: new Map(),
    cuObservationParseSequence: new Map(),
    socketSandboxOverride: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: { schedule: () => {}, cancel: () => {} } as unknown as HandlerContext['debounceTimers'],
    suppressConfigReload: false,
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    send: (_socket: net.Socket, msg: unknown) => { captured = msg as GuardianVerificationResponse; },
    broadcast: () => {},
    clearAllSessions: () => 0,
    getOrCreateSession: () => Promise.resolve({} as never),
    touchSession: () => {},
  } as unknown as HandlerContext;
  return { ctx, lastResponse: () => captured };
}

const mockSocket = {} as net.Socket;

describe('IPC handler channel-aware guardian status', () => {
  beforeEach(() => {
    resetTables();
  });

  test('status action for telegram returns channel and assistantId fields', () => {
    const { ctx, lastResponse } = createMockCtx();
    const msg: GuardianVerificationRequest = {
      type: 'guardian_verification',
      action: 'status',
      channel: 'telegram',
      assistantId: 'self',
    };

    handleGuardianVerification(msg, mockSocket, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.channel).toBe('telegram');
    expect(resp!.assistantId).toBe('self');
    expect(resp!.bound).toBe(false);
    expect(resp!.guardianDeliveryChatId).toBeUndefined();
  });

  test('status action for sms returns channel: sms and assistantId: self', () => {
    const { ctx, lastResponse } = createMockCtx();
    const msg: GuardianVerificationRequest = {
      type: 'guardian_verification',
      action: 'status',
      channel: 'sms',
      assistantId: 'self',
    };

    handleGuardianVerification(msg, mockSocket, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.channel).toBe('sms');
    expect(resp!.assistantId).toBe('self');
    expect(resp!.bound).toBe(false);
  });

  test('status action returns guardianDeliveryChatId when bound', () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'user-42',
      guardianDeliveryChatId: 'chat-42',
    });

    const { ctx, lastResponse } = createMockCtx();
    const msg: GuardianVerificationRequest = {
      type: 'guardian_verification',
      action: 'status',
      channel: 'telegram',
      assistantId: 'self',
    };

    handleGuardianVerification(msg, mockSocket, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.bound).toBe(true);
    expect(resp!.guardianExternalUserId).toBe('user-42');
    expect(resp!.guardianDeliveryChatId).toBe('chat-42');
    expect(resp!.channel).toBe('telegram');
    expect(resp!.assistantId).toBe('self');
  });

  test('status action returns guardian username/displayName from binding metadata', () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'user-43',
      guardianDeliveryChatId: 'chat-43',
      metadataJson: JSON.stringify({ username: 'guardian_handle', displayName: 'Guardian Name' }),
    });

    const { ctx, lastResponse } = createMockCtx();
    const msg: GuardianVerificationRequest = {
      type: 'guardian_verification',
      action: 'status',
      channel: 'telegram',
      assistantId: 'self',
    };

    handleGuardianVerification(msg, mockSocket, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.guardianUsername).toBe('guardian_handle');
    expect(resp!.guardianDisplayName).toBe('Guardian Name');
  });

  test('status action defaults channel to telegram when omitted (backward compat)', () => {
    const { ctx, lastResponse } = createMockCtx();
    const msg: GuardianVerificationRequest = {
      type: 'guardian_verification',
      action: 'status',
      // channel omitted — should default to 'telegram'
    };

    handleGuardianVerification(msg, mockSocket, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.channel).toBe('telegram');
    expect(resp!.assistantId).toBe('self');
  });

  test('status action defaults assistantId to self when omitted (backward compat)', () => {
    const { ctx, lastResponse } = createMockCtx();
    const msg: GuardianVerificationRequest = {
      type: 'guardian_verification',
      action: 'status',
      channel: 'sms',
      // assistantId omitted — should default to 'self'
    };

    handleGuardianVerification(msg, mockSocket, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.assistantId).toBe('self');
    expect(resp!.channel).toBe('sms');
  });

  test('status action with custom assistantId returns correct value', () => {
    createBinding({
      assistantId: 'asst-custom',
      channel: 'telegram',
      guardianExternalUserId: 'user-77',
      guardianDeliveryChatId: 'chat-77',
    });

    const { ctx, lastResponse } = createMockCtx();
    const msg: GuardianVerificationRequest = {
      type: 'guardian_verification',
      action: 'status',
      channel: 'telegram',
      assistantId: 'asst-custom',
    };

    handleGuardianVerification(msg, mockSocket, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.bound).toBe(true);
    expect(resp!.assistantId).toBe('asst-custom');
    expect(resp!.channel).toBe('telegram');
    expect(resp!.guardianExternalUserId).toBe('user-77');
    expect(resp!.guardianDeliveryChatId).toBe('chat-77');
  });

  test('status action for unbound sms does not return guardianDeliveryChatId', () => {
    const { ctx, lastResponse } = createMockCtx();
    const msg: GuardianVerificationRequest = {
      type: 'guardian_verification',
      action: 'status',
      channel: 'sms',
    };

    handleGuardianVerification(msg, mockSocket, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.bound).toBe(false);
    expect(resp!.guardianDeliveryChatId).toBeUndefined();
    expect(resp!.guardianExternalUserId).toBeUndefined();
  });
});
