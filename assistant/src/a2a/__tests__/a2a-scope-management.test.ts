/**
 * Tests for A2A scope management via A2AConnectionService:
 *   - updateScopes() with valid/invalid scopes
 *   - getScopes() returns current scopes
 *   - Notification signal emission on scope changes
 *   - Immediate enforcement after scope update
 *   - Audit logging on scope changes
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'a2a-scope-management-test-'));

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that touches mocked modules.
// ---------------------------------------------------------------------------

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
}));

// Capture log calls for audit verification
const logCalls: Array<{ level: string; args: unknown[] }> = [];

mock.module('../../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target, prop) => (...args: unknown[]) => {
        logCalls.push({ level: String(prop), args });
      },
    }),
}));

// Capture notification signals for verification
const emittedSignals: Array<Record<string, unknown>> = [];

mock.module('../../notifications/emit-signal.js', () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emittedSignals.push(params);
    return {
      signalId: 'test-signal',
      deduplicated: false,
      dispatched: true,
      reason: 'ok',
      deliveryResults: [],
    };
  },
}));

// Control scope policy flag per test
let scopePolicyEnabled = true;
mock.module('../../config/assistant-feature-flags.js', () => ({
  isAssistantFeatureFlagEnabled: (key: string) => {
    if (key === 'feature_flags.a2a-scope-policy.enabled') return scopePolicyEnabled;
    return true;
  },
  loadDefaultsRegistry: () => ({}),
}));

mock.module('../../config/loader.js', () => ({
  getConfig: () => ({
    assistantFeatureFlagValues: {},
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  updateScopes,
  getScopes,
  sendMessage,
  _resetHandshakeSessions,
  _resetIdempotencyStore,
} from '../a2a-connection-service.js';

import {
  createConnection,
  getConnection,
  updateConnectionCredentials,
} from '../a2a-peer-connection-store.js';

import { generateCredentialPair } from '../a2a-peer-auth.js';
import { evaluateScope } from '../a2a-scope-policy.js';
import { getDb, initializeDb, resetDb } from '../../memory/db.js';

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM a2a_peer_connections');
  db.run('DELETE FROM assistant_ingress_invites');
  db.run('DELETE FROM external_conversation_bindings');
}

/** Create an active connection with valid credentials and optionally granted scopes. */
function createActiveConnection(overrides?: { scopes?: string[]; peerGatewayUrl?: string; peerAssistantId?: string }) {
  const credentials = generateCredentialPair();
  const conn = createConnection({
    peerGatewayUrl: overrides?.peerGatewayUrl ?? 'https://peer.example.com',
    peerAssistantId: overrides?.peerAssistantId ?? 'peer-001',
    status: 'active',
    scopes: overrides?.scopes,
  });
  updateConnectionCredentials(conn.id, {
    outboundCredentialHash: credentials.outboundCredentialHash,
    outboundCredential: credentials.outboundCredential,
    inboundCredentialHash: credentials.inboundCredentialHash,
    inboundCredential: credentials.inboundCredential,
  });
  return { connection: getConnection(conn.id)!, credentials };
}

// ===========================================================================
// updateScopes Tests
// ===========================================================================

describe('updateScopes', () => {
  beforeEach(() => {
    resetTables();
    _resetHandshakeSessions();
    _resetIdempotencyStore();
    emittedSignals.length = 0;
    logCalls.length = 0;
    scopePolicyEnabled = true;
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  });

  test('updates scopes with valid scope IDs', () => {
    const { connection } = createActiveConnection({ scopes: ['message'] });

    const result = updateScopes({
      connectionId: connection.id,
      scopes: ['message', 'read_profile', 'read_availability'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.previousScopes).toEqual(['message']);
      expect(result.newScopes).toEqual(['message', 'read_profile', 'read_availability']);
      expect(result.connection.scopes).toEqual(['message', 'read_profile', 'read_availability']);
    }
  });

  test('rejects invalid/undeclared scope IDs', () => {
    const { connection } = createActiveConnection({ scopes: ['message'] });

    const result = updateScopes({
      connectionId: connection.id,
      scopes: ['message', 'fake_scope', 'another_fake'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_scopes');
      expect(result.detail).toContain('fake_scope');
      expect(result.detail).toContain('another_fake');
    }

    // Original scopes unchanged
    const current = getConnection(connection.id);
    expect(current!.scopes).toEqual(['message']);
  });

  test('returns not_found for nonexistent connection', () => {
    const result = updateScopes({
      connectionId: 'nonexistent-id',
      scopes: ['message'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
    }
  });

  test('returns not_active for revoked connection', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'revoked',
    });

    const result = updateScopes({
      connectionId: conn.id,
      scopes: ['message'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_active');
    }
  });

  test('returns not_active for pending connection', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'pending',
    });

    const result = updateScopes({
      connectionId: conn.id,
      scopes: ['message'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_active');
    }
  });

  test('allows setting empty scopes (revoke all)', () => {
    const { connection } = createActiveConnection({ scopes: ['message', 'read_profile'] });

    const result = updateScopes({
      connectionId: connection.id,
      scopes: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.previousScopes).toEqual(['message', 'read_profile']);
      expect(result.newScopes).toEqual([]);
      expect(result.connection.scopes).toEqual([]);
    }
  });

  test('allows setting all 5 catalog scopes', () => {
    const { connection } = createActiveConnection({ scopes: [] });

    const allScopes = ['message', 'read_availability', 'create_events', 'read_profile', 'execute_requests'];
    const result = updateScopes({
      connectionId: connection.id,
      scopes: allScopes,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.newScopes).toEqual(allScopes);
    }
  });

  // ---- Notification signal emission ----

  test('emits a2a.scopes_changed notification signal', () => {
    const { connection } = createActiveConnection({ scopes: ['message'] });

    updateScopes({
      connectionId: connection.id,
      scopes: ['message', 'read_profile'],
    });

    const scopeSignal = emittedSignals.find(
      (s) => s.sourceEventName === 'a2a.scopes_changed',
    );
    expect(scopeSignal).toBeDefined();
    expect(scopeSignal!.sourceChannel).toBe('a2a');
    expect(scopeSignal!.sourceSessionId).toBe(connection.id);

    const payload = scopeSignal!.contextPayload as Record<string, unknown>;
    expect(payload.connectionId).toBe(connection.id);
    expect(payload.previousScopes).toEqual(['message']);
    expect(payload.newScopes).toEqual(['message', 'read_profile']);
    expect(payload.peerAssistantId).toBe('peer-001');
    expect(typeof payload.timestamp).toBe('number');
  });

  test('does not emit notification signal on failure', () => {
    emittedSignals.length = 0;

    updateScopes({
      connectionId: 'nonexistent-id',
      scopes: ['message'],
    });

    const scopeSignal = emittedSignals.find(
      (s) => s.sourceEventName === 'a2a.scopes_changed',
    );
    expect(scopeSignal).toBeUndefined();
  });

  // ---- Audit logging ----

  test('logs scope change for audit', () => {
    const { connection } = createActiveConnection({
      scopes: ['message'],
      peerAssistantId: 'peer-audit-test',
    });
    logCalls.length = 0;

    updateScopes({
      connectionId: connection.id,
      scopes: ['message', 'read_profile'],
    });

    const infoLogs = logCalls.filter((c) => c.level === 'info');
    const auditLog = infoLogs.find((c) => {
      const msg = c.args[1];
      return typeof msg === 'string' && msg.includes('scope change');
    });
    expect(auditLog).toBeDefined();

    const logData = auditLog!.args[0] as Record<string, unknown>;
    expect(logData.connectionId).toBe(connection.id);
    expect(logData.peerAssistantId).toBe('peer-audit-test');
    expect(logData.previousScopes).toEqual(['message']);
    expect(logData.newScopes).toEqual(['message', 'read_profile']);
    expect(typeof logData.timestamp).toBe('number');
  });

  // ---- Immediate enforcement ----

  test('scope narrowing is immediately enforced on next scope check', () => {
    const { connection } = createActiveConnection({ scopes: ['message', 'read_profile'] });

    // Before narrowing: message scope is allowed
    let evalResult = evaluateScope(getConnection(connection.id)!.scopes, 'sendMessage');
    expect(evalResult.allowed).toBe(true);

    // Narrow scopes: remove message
    const result = updateScopes({
      connectionId: connection.id,
      scopes: ['read_profile'],
    });
    expect(result.ok).toBe(true);

    // After narrowing: message scope is denied (read from store)
    evalResult = evaluateScope(getConnection(connection.id)!.scopes, 'sendMessage');
    expect(evalResult.allowed).toBe(false);
  });

  test('scope widening is immediately enforced on next scope check', () => {
    const { connection } = createActiveConnection({ scopes: ['read_profile'] });

    // Before widening: message scope is denied
    let evalResult = evaluateScope(getConnection(connection.id)!.scopes, 'sendMessage');
    expect(evalResult.allowed).toBe(false);

    // Widen scopes: add message
    const result = updateScopes({
      connectionId: connection.id,
      scopes: ['read_profile', 'message'],
    });
    expect(result.ok).toBe(true);

    // After widening: message scope is allowed
    evalResult = evaluateScope(getConnection(connection.id)!.scopes, 'sendMessage');
    expect(evalResult.allowed).toBe(true);
  });

  test('revoking all scopes immediately blocks sendMessage', async () => {
    scopePolicyEnabled = true;
    const { connection } = createActiveConnection({ scopes: ['message'] });

    // Revoke all scopes
    const result = updateScopes({
      connectionId: connection.id,
      scopes: [],
    });
    expect(result.ok).toBe(true);

    // sendMessage should fail with scope_denied
    const sendResult = await sendMessage({
      connectionId: connection.id,
      content: { type: 'text', text: 'should be blocked' },
    });

    expect(sendResult.ok).toBe(false);
    if (!sendResult.ok) {
      expect(sendResult.reason).toBe('scope_denied');
    }
  });
});

// ===========================================================================
// getScopes Tests
// ===========================================================================

describe('getScopes', () => {
  beforeEach(() => {
    resetTables();
    _resetHandshakeSessions();
    _resetIdempotencyStore();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  });

  test('returns current scopes for active connection', () => {
    const { connection } = createActiveConnection({ scopes: ['message', 'read_profile'] });

    const result = getScopes({ connectionId: connection.id });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopes).toEqual(['message', 'read_profile']);
      expect(result.connectionId).toBe(connection.id);
    }
  });

  test('returns empty array when no scopes are set', () => {
    const { connection } = createActiveConnection({ scopes: [] });

    const result = getScopes({ connectionId: connection.id });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopes).toEqual([]);
    }
  });

  test('returns not_found for nonexistent connection', () => {
    const result = getScopes({ connectionId: 'nonexistent-id' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
    }
  });

  test('returns not_active for non-active connection', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'revoked',
      scopes: ['message'],
    });

    const result = getScopes({ connectionId: conn.id });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_active');
    }
  });

  test('reflects updated scopes after updateScopes()', () => {
    const { connection } = createActiveConnection({ scopes: ['message'] });

    // Update scopes
    updateScopes({
      connectionId: connection.id,
      scopes: ['message', 'create_events'],
    });

    // getScopes should reflect the change
    const result = getScopes({ connectionId: connection.id });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopes).toEqual(['message', 'create_events']);
    }
  });
});
