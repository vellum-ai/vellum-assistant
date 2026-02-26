/**
 * Tests for M4: Verification success → trusted contact activation.
 *
 * When a requester successfully verifies their identity (enters the correct
 * 6-digit code from an identity-bound outbound session), the system should:
 * 1. Upsert an active member record in assistant_ingress_members
 * 2. Allow subsequent messages through the ACL check
 * 3. Scope the member correctly (no cross-assistant leakage)
 * 4. Reactivate previously revoked members on re-verification
 * 5. NOT create a guardian binding (trusted contacts are not guardians)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), 'trusted-contact-verify-test-'));

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
  normalizeAssistantId: (id: string) => id === 'self' ? 'self' : id,
  readHttpToken: () => 'test-bearer-token',
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import { initializeDb, resetDb } from '../memory/db.js';
import {
  createOutboundSession,
  validateAndConsumeChallenge,
} from '../runtime/channel-guardian-service.js';
import {
  findMember,
  upsertMember,
  revokeMember,
} from '../memory/ingress-member-store.js';
import {
  getActiveBinding,
  createBinding,
} from '../memory/channel-guardian-store.js';

initializeDb();

afterAll(() => {
  resetDb();
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetTables(): void {
  const { getDb } = require('../memory/db.js');
  const db = getDb();
  db.run('DELETE FROM channel_guardian_verification_challenges');
  db.run('DELETE FROM channel_guardian_bindings');
  db.run('DELETE FROM channel_guardian_rate_limits');
  db.run('DELETE FROM assistant_ingress_members');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('trusted contact verification → member activation', () => {
  beforeEach(() => {
    resetTables();
  });

  test('successful verification creates active member with allow policy', () => {
    // Simulate M3: guardian approves, outbound session created for the requester
    const session = createOutboundSession({
      assistantId: 'self',
      channel: 'telegram',
      expectedExternalUserId: 'requester-user-123',
      expectedChatId: 'requester-chat-123',
      identityBindingStatus: 'bound',
      destinationAddress: 'requester-chat-123',
      verificationPurpose: 'trusted_contact',
    });

    // Requester enters the 6-digit code
    const result = validateAndConsumeChallenge(
      'self',
      'telegram',
      session.secret,
      'requester-user-123',
      'requester-chat-123',
      'requester_username',
      'Requester Name',
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe('trusted_contact');
    }

    // Simulate the member upsert that inbound-message-handler performs on success
    upsertMember({
      assistantId: 'self',
      sourceChannel: 'telegram',
      externalUserId: 'requester-user-123',
      externalChatId: 'requester-chat-123',
      status: 'active',
      policy: 'allow',
      displayName: 'Requester Name',
      username: 'requester_username',
    });

    // Verify: active member record exists
    const member = findMember({
      assistantId: 'self',
      sourceChannel: 'telegram',
      externalUserId: 'requester-user-123',
    });

    expect(member).not.toBeNull();
    expect(member!.status).toBe('active');
    expect(member!.policy).toBe('allow');
    expect(member!.externalUserId).toBe('requester-user-123');
    expect(member!.externalChatId).toBe('requester-chat-123');
    expect(member!.displayName).toBe('Requester Name');
    expect(member!.username).toBe('requester_username');
    expect(member!.assistantId).toBe('self');
    expect(member!.sourceChannel).toBe('telegram');
  });

  test('post-verify message is accepted (ACL check passes)', () => {
    // Create and verify a trusted contact
    const session = createOutboundSession({
      assistantId: 'self',
      channel: 'telegram',
      expectedExternalUserId: 'requester-user-456',
      expectedChatId: 'requester-chat-456',
      identityBindingStatus: 'bound',
      destinationAddress: 'requester-chat-456',
      verificationPurpose: 'trusted_contact',
    });

    validateAndConsumeChallenge(
      'self', 'telegram', session.secret,
      'requester-user-456', 'requester-chat-456',
    );

    // Simulate member upsert on verification success
    upsertMember({
      assistantId: 'self',
      sourceChannel: 'telegram',
      externalUserId: 'requester-user-456',
      externalChatId: 'requester-chat-456',
      status: 'active',
      policy: 'allow',
    });

    // Simulate the ACL check that inbound-message-handler performs
    const member = findMember({
      assistantId: 'self',
      sourceChannel: 'telegram',
      externalUserId: 'requester-user-456',
      externalChatId: 'requester-chat-456',
    });

    expect(member).not.toBeNull();
    expect(member!.status).toBe('active');
    expect(member!.policy).toBe('allow');
    // ACL check passes: member exists, is active, and has allow policy
  });

  test('no cross-assistant leakage (member scoped correctly)', () => {
    // Create member for assistant 'self'
    const session = createOutboundSession({
      assistantId: 'self',
      channel: 'telegram',
      expectedExternalUserId: 'user-cross-test',
      expectedChatId: 'chat-cross-test',
      identityBindingStatus: 'bound',
      destinationAddress: 'chat-cross-test',
      verificationPurpose: 'trusted_contact',
    });

    validateAndConsumeChallenge(
      'self', 'telegram', session.secret,
      'user-cross-test', 'chat-cross-test',
    );

    upsertMember({
      assistantId: 'self',
      sourceChannel: 'telegram',
      externalUserId: 'user-cross-test',
      externalChatId: 'chat-cross-test',
      status: 'active',
      policy: 'allow',
    });

    // Member should be found for 'self'
    const selfMember = findMember({
      assistantId: 'self',
      sourceChannel: 'telegram',
      externalUserId: 'user-cross-test',
    });
    expect(selfMember).not.toBeNull();
    expect(selfMember!.status).toBe('active');

    // Member should NOT be found for a different assistant
    const otherMember = findMember({
      assistantId: 'other-assistant',
      sourceChannel: 'telegram',
      externalUserId: 'user-cross-test',
    });
    expect(otherMember).toBeNull();
  });

  test('re-verification of previously revoked member reactivates them', () => {
    // Create and activate a member
    const member = upsertMember({
      assistantId: 'self',
      sourceChannel: 'telegram',
      externalUserId: 'user-revoked',
      externalChatId: 'chat-revoked',
      status: 'active',
      policy: 'allow',
      displayName: 'Revoked User',
    });

    // Revoke the member
    const revoked = revokeMember(member.id, 'testing revocation');
    expect(revoked).not.toBeNull();
    expect(revoked!.status).toBe('revoked');

    // Verify the member is indeed revoked (ACL would reject)
    const revokedMember = findMember({
      assistantId: 'self',
      sourceChannel: 'telegram',
      externalUserId: 'user-revoked',
    });
    expect(revokedMember).not.toBeNull();
    expect(revokedMember!.status).toBe('revoked');

    // Guardian re-approves, new outbound session created
    const session = createOutboundSession({
      assistantId: 'self',
      channel: 'telegram',
      expectedExternalUserId: 'user-revoked',
      expectedChatId: 'chat-revoked',
      identityBindingStatus: 'bound',
      destinationAddress: 'chat-revoked',
      verificationPurpose: 'trusted_contact',
    });

    // Requester enters the new code
    const result = validateAndConsumeChallenge(
      'self', 'telegram', session.secret,
      'user-revoked', 'chat-revoked',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe('trusted_contact');
    }

    // upsertMember reactivates the existing record
    upsertMember({
      assistantId: 'self',
      sourceChannel: 'telegram',
      externalUserId: 'user-revoked',
      externalChatId: 'chat-revoked',
      status: 'active',
      policy: 'allow',
    });

    // Verify: member is now active again
    const reactivated = findMember({
      assistantId: 'self',
      sourceChannel: 'telegram',
      externalUserId: 'user-revoked',
    });
    expect(reactivated).not.toBeNull();
    expect(reactivated!.status).toBe('active');
    expect(reactivated!.policy).toBe('allow');
  });

  test('trusted contact verification does NOT create a guardian binding', () => {
    // Ensure there's an existing guardian binding we want to preserve
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'guardian-user-original',
      guardianDeliveryChatId: 'guardian-chat-original',
      verifiedVia: 'challenge',
      metadataJson: null,
    });

    // Create an outbound session for a requester (different user than guardian)
    const session = createOutboundSession({
      assistantId: 'self',
      channel: 'telegram',
      expectedExternalUserId: 'requester-user-789',
      expectedChatId: 'requester-chat-789',
      identityBindingStatus: 'bound',
      destinationAddress: 'requester-chat-789',
      verificationPurpose: 'trusted_contact',
    });

    const result = validateAndConsumeChallenge(
      'self', 'telegram', session.secret,
      'requester-user-789', 'requester-chat-789',
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe('trusted_contact');
      // Should NOT have a bindingId — no guardian binding created
      expect('bindingId' in result).toBe(false);
    }

    // The original guardian binding should remain intact
    const binding = getActiveBinding('self', 'telegram');
    expect(binding).not.toBeNull();
    expect(binding!.guardianExternalUserId).toBe('guardian-user-original');
  });

  test('guardian inbound verification still creates binding (backward compat)', () => {
    // Create an inbound challenge (no expected identity — guardian flow)
    const { createVerificationChallenge } = require('../runtime/channel-guardian-service.js');
    const { secret } = createVerificationChallenge('self', 'telegram');

    const result = validateAndConsumeChallenge(
      'self', 'telegram', secret,
      'guardian-user', 'guardian-chat',
    );

    expect(result.success).toBe(true);
    if (result.success && result.verificationType === 'guardian') {
      expect(result.bindingId).toBeDefined();
    }

    // Guardian binding should be created
    const binding = getActiveBinding('self', 'telegram');
    expect(binding).not.toBeNull();
    expect(binding!.guardianExternalUserId).toBe('guardian-user');
  });
});
