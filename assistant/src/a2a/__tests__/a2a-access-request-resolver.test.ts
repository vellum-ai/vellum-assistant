/**
 * Tests for the `a2a_access_request` canonical guardian request kind and
 * its resolver. Covers approve, reject, stale (already-resolved), and
 * identity mismatch paths through applyCanonicalGuardianDecision.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'a2a-access-request-resolver-test-'));

mock.module('../../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
  migrateToDataLayout: () => {},
  migrateToWorkspaceLayout: () => {},
  readHttpToken: () => null,
}));

mock.module('../../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  isDebug: () => false,
  truncateForLog: (value: string) => value,
}));

import {
  applyCanonicalGuardianDecision,
} from '../../approvals/guardian-decision-primitive.js';
import type { ActorContext } from '../../approvals/guardian-request-resolvers.js';
import { getRegisteredKinds, getResolver } from '../../approvals/guardian-request-resolvers.js';
import {
  createCanonicalGuardianRequest,
  getCanonicalGuardianRequest,
} from '../../memory/canonical-guardian-store.js';
import { getDb, initializeDb, resetDb } from '../../memory/db.js';
import {
  A2A_PROTOCOL_VERSION,
  approveConnection,
  decodeInviteCode,
  generateInvite,
  initiateConnection,
  _resetHandshakeSessions,
  _resetIdempotencyStore,
} from '../a2a-connection-service.js';
import { getConnection } from '../a2a-peer-connection-store.js';

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM scoped_approval_grants');
  db.run('DELETE FROM canonical_guardian_deliveries');
  db.run('DELETE FROM canonical_guardian_requests');
  db.run('DELETE FROM a2a_peer_connections');
  db.run('DELETE FROM assistant_ingress_invites');
}

const TEST_PRINCIPAL_ID = 'test-principal-id';
const MOCK_GATEWAY_URL = 'https://my-assistant.example.com';
const PEER_GATEWAY_URL = 'https://peer-assistant.example.com';

function guardianActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    externalUserId: 'guardian-1',
    channel: 'telegram',
    guardianPrincipalId: TEST_PRINCIPAL_ID,
    ...overrides,
  };
}

/**
 * Helper: create a pending A2A connection and return its connectionId.
 */
function createPendingA2AConnection(): string {
  const genResult = generateInvite({ gatewayUrl: MOCK_GATEWAY_URL });
  if (!genResult.ok) throw new Error('Failed to generate invite');
  const decoded = decodeInviteCode(genResult.inviteCode)!;

  const initResult = initiateConnection({
    peerGatewayUrl: PEER_GATEWAY_URL,
    inviteToken: decoded.t,
    protocolVersion: A2A_PROTOCOL_VERSION,
    capabilities: ['scheduling:read'],
  });
  if (!initResult.ok) throw new Error('Failed to initiate connection');
  return initResult.connectionId;
}

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe('a2a_access_request resolver registration', () => {
  test('resolver is registered for a2a_access_request kind', () => {
    const kinds = getRegisteredKinds();
    expect(kinds).toContain('a2a_access_request');
  });

  test('getResolver returns the a2a_access_request resolver', () => {
    const resolver = getResolver('a2a_access_request');
    expect(resolver).toBeDefined();
    expect(resolver!.kind).toBe('a2a_access_request');
  });
});

// ---------------------------------------------------------------------------
// Canonical decision flow tests
// ---------------------------------------------------------------------------

describe('applyCanonicalGuardianDecision with a2a_access_request', () => {
  beforeEach(() => {
    resetTables();
    _resetHandshakeSessions();
    _resetIdempotencyStore();
  });

  // ── Approve path ──────────────────────────────────────────────────────

  test('approve: calls approveConnection and returns verification code in reply text', async () => {
    const connectionId = createPendingA2AConnection();

    const req = createCanonicalGuardianRequest({
      kind: 'a2a_access_request',
      sourceType: 'channel',
      sourceChannel: 'telegram',
      guardianExternalUserId: 'guardian-1',
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      followupState: connectionId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.resolverFailed).toBeUndefined();
    expect(result.resolverReplyText).toBeDefined();
    expect(result.resolverReplyText!).toContain('Verification code:');

    // Canonical request is approved
    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe('approved');
    expect(resolved!.decidedByExternalUserId).toBe('guardian-1');

    // Connection is still pending (awaiting verification code submission)
    const conn = getConnection(connectionId);
    expect(conn).not.toBeNull();
    expect(conn!.status).toBe('pending');
  });

  // ── Reject path ───────────────────────────────────────────────────────

  test('reject: calls approveConnection with deny and revokes connection', async () => {
    const connectionId = createPendingA2AConnection();

    const req = createCanonicalGuardianRequest({
      kind: 'a2a_access_request',
      sourceType: 'channel',
      sourceChannel: 'telegram',
      guardianExternalUserId: 'guardian-1',
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      followupState: connectionId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'reject',
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.resolverFailed).toBeUndefined();
    expect(result.resolverReplyText).toBe('A2A connection request denied.');

    // Canonical request is denied
    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe('denied');

    // Connection is revoked
    const conn = getConnection(connectionId);
    expect(conn).not.toBeNull();
    expect(conn!.status).toBe('revoked');
  });

  // ── Stale / already-resolved ──────────────────────────────────────────

  test('stale: second decision fails with already_resolved', async () => {
    const connectionId = createPendingA2AConnection();

    const req = createCanonicalGuardianRequest({
      kind: 'a2a_access_request',
      sourceType: 'channel',
      sourceChannel: 'telegram',
      guardianExternalUserId: 'guardian-1',
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      followupState: connectionId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // First decision succeeds
    const first = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor(),
    });
    expect(first.applied).toBe(true);

    // Second decision fails — request is no longer pending
    const second = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'reject',
      actorContext: guardianActor(),
    });
    expect(second.applied).toBe(false);
    if (second.applied) return;
    expect(second.reason).toBe('already_resolved');

    // First decision stuck — canonical request is approved
    const final = getCanonicalGuardianRequest(req.id);
    expect(final!.status).toBe('approved');
  });

  // ── Identity mismatch ─────────────────────────────────────────────────

  test('identity mismatch: wrong principal is rejected', async () => {
    const connectionId = createPendingA2AConnection();

    const req = createCanonicalGuardianRequest({
      kind: 'a2a_access_request',
      sourceType: 'channel',
      sourceChannel: 'telegram',
      guardianExternalUserId: 'guardian-1',
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      followupState: connectionId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor({ guardianPrincipalId: 'wrong-principal' }),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe('identity_mismatch');

    // Request remains pending
    const unchanged = getCanonicalGuardianRequest(req.id);
    expect(unchanged!.status).toBe('pending');

    // Connection is still pending (no side effects applied)
    const conn = getConnection(connectionId);
    expect(conn!.status).toBe('pending');
  });

  test('identity mismatch: actor missing principal is rejected', async () => {
    const connectionId = createPendingA2AConnection();

    const req = createCanonicalGuardianRequest({
      kind: 'a2a_access_request',
      sourceType: 'channel',
      sourceChannel: 'telegram',
      guardianExternalUserId: 'guardian-1',
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      followupState: connectionId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor({ guardianPrincipalId: undefined }),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe('identity_mismatch');
  });

  // ── Missing connectionId in followupState ─────────────────────────────

  test('resolver fails when followupState is missing', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'a2a_access_request',
      sourceType: 'channel',
      sourceChannel: 'telegram',
      guardianExternalUserId: 'guardian-1',
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      // No followupState — missing connectionId
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor(),
    });

    // CAS resolution succeeds but resolver fails
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.resolverFailed).toBe(true);
    expect(result.resolverFailureReason).toContain('missing connectionId');
  });

  // ── Invalid connectionId ──────────────────────────────────────────────

  test('resolver fails when connectionId points to nonexistent connection', async () => {
    const req = createCanonicalGuardianRequest({
      kind: 'a2a_access_request',
      sourceType: 'channel',
      sourceChannel: 'telegram',
      guardianExternalUserId: 'guardian-1',
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      followupState: 'nonexistent-connection-id',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor(),
    });

    // CAS resolution succeeds but resolver fails
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.resolverFailed).toBe(true);
    expect(result.resolverFailureReason).toContain('a2a_approve_failed');
  });

  // ── approve_always downgrade ──────────────────────────────────────────

  test('approve_always is downgraded to approve_once', async () => {
    const connectionId = createPendingA2AConnection();

    const req = createCanonicalGuardianRequest({
      kind: 'a2a_access_request',
      sourceType: 'channel',
      sourceChannel: 'telegram',
      guardianExternalUserId: 'guardian-1',
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      followupState: connectionId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_always',
      actorContext: guardianActor(),
    });

    // Should succeed — approve_always silently downgraded to approve_once
    expect(result.applied).toBe(true);

    const resolved = getCanonicalGuardianRequest(req.id);
    expect(resolved!.status).toBe('approved');
  });

  // ── Expired request ───────────────────────────────────────────────────

  test('rejects decision on expired request', async () => {
    const connectionId = createPendingA2AConnection();

    const req = createCanonicalGuardianRequest({
      kind: 'a2a_access_request',
      sourceType: 'channel',
      sourceChannel: 'telegram',
      guardianExternalUserId: 'guardian-1',
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      followupState: connectionId,
      expiresAt: new Date(Date.now() - 10_000).toISOString(), // already expired
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe('expired');
  });

  // ── Not found ─────────────────────────────────────────────────────────

  test('returns not_found for nonexistent request', async () => {
    const result = await applyCanonicalGuardianDecision({
      requestId: 'nonexistent-id',
      action: 'approve_once',
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(false);
    if (result.applied) return;
    expect(result.reason).toBe('not_found');
  });

  // ── Decisionable guard ────────────────────────────────────────────────

  test('creation requires guardianPrincipalId (decisionable kind guard)', () => {
    expect(() => {
      createCanonicalGuardianRequest({
        kind: 'a2a_access_request',
        sourceType: 'channel',
        sourceChannel: 'telegram',
        // No guardianPrincipalId — should throw
      });
    }).toThrow(/guardianPrincipalId/);
  });

  // ── No grant minted (A2A requests have no tool metadata) ──────────────

  test('no grant is minted for a2a_access_request (no tool metadata)', async () => {
    const connectionId = createPendingA2AConnection();

    const req = createCanonicalGuardianRequest({
      kind: 'a2a_access_request',
      sourceType: 'channel',
      sourceChannel: 'telegram',
      guardianExternalUserId: 'guardian-1',
      guardianPrincipalId: TEST_PRINCIPAL_ID,
      followupState: connectionId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const result = await applyCanonicalGuardianDecision({
      requestId: req.id,
      action: 'approve_once',
      actorContext: guardianActor(),
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.grantMinted).toBe(false);
  });
});
