/**
 * Tests for the A2A scope catalog, policy engine, trust gating integration,
 * sendMessage scope check, inbound message scope check, and scope validation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'a2a-scope-policy-test-'));

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

mock.module('../../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module('../../notifications/emit-signal.js', () => ({
  emitNotificationSignal: async () => ({
    signalId: 'test-signal',
    deduplicated: false,
    dispatched: true,
    reason: 'ok',
    deliveryResults: [],
  }),
}));

// Control scope policy flag per test
let scopePolicyEnabled = false;
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
  isValidScopeId,
  validateScopeIds,
  getScopeDefinition,
  getAllScopeDefinitions,
  getValidScopeIds,
} from '../a2a-scope-catalog.js';

import {
  evaluateScope,
  getRequiredScopeForAction,
  getRequiredScopeForTool,
  type A2AScopedAction,
} from '../a2a-scope-policy.js';

import {
  createConnection,
  getConnection,
  updateConnectionCredentials,
  updateConnectionScopes,
  updateConnectionStatus,
} from '../a2a-peer-connection-store.js';

import { generateCredentialPair } from '../a2a-peer-auth.js';

import {
  sendMessage,
  _resetHandshakeSessions,
  _resetIdempotencyStore,
} from '../a2a-connection-service.js';

import { handleA2AMessageInbound } from '../../runtime/routes/a2a-inbound-routes.js';
import {
  signRequest,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  HEADER_NONCE,
  HEADER_CONNECTION_ID,
} from '../a2a-peer-auth.js';
import { createTextMessage } from '../a2a-message-schema.js';

import { getDb, initializeDb, resetDb } from '../../memory/db.js';

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM a2a_peer_connections');
  db.run('DELETE FROM assistant_ingress_invites');
  db.run('DELETE FROM external_conversation_bindings');
}

/** Create an active connection with valid credentials and optionally granted scopes. */
function createActiveConnection(overrides?: { scopes?: string[]; peerGatewayUrl?: string }) {
  const credentials = generateCredentialPair();
  const conn = createConnection({
    peerGatewayUrl: overrides?.peerGatewayUrl ?? 'https://peer.example.com',
    peerAssistantId: 'peer-001',
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
// Scope Catalog Tests
// ===========================================================================

describe('a2a-scope-catalog', () => {
  test('recognizes all 5 declared scope IDs', () => {
    const expected = ['message', 'read_availability', 'create_events', 'read_profile', 'execute_requests'];
    for (const id of expected) {
      expect(isValidScopeId(id)).toBe(true);
    }
  });

  test('rejects unknown scope IDs', () => {
    expect(isValidScopeId('scheduling:read')).toBe(false);
    expect(isValidScopeId('admin')).toBe(false);
    expect(isValidScopeId('')).toBe(false);
    expect(isValidScopeId('MESSAGE')).toBe(false);
  });

  test('validateScopeIds returns valid for known scopes', () => {
    const result = validateScopeIds(['message', 'read_profile']);
    expect(result.valid).toBe(true);
  });

  test('validateScopeIds returns valid for empty array', () => {
    const result = validateScopeIds([]);
    expect(result.valid).toBe(true);
  });

  test('validateScopeIds returns unrecognized scope IDs', () => {
    const result = validateScopeIds(['message', 'invalid_scope', 'also_invalid']);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.unrecognized).toEqual(['invalid_scope', 'also_invalid']);
    }
  });

  test('getScopeDefinition returns metadata for known scopes', () => {
    const def = getScopeDefinition('message');
    expect(def).toBeDefined();
    expect(def!.id).toBe('message');
    expect(def!.label).toBe('Send/receive messages');
    expect(def!.riskLevel).toBe('low');
  });

  test('getScopeDefinition returns undefined for unknown scopes', () => {
    expect(getScopeDefinition('nonexistent')).toBeUndefined();
  });

  test('getAllScopeDefinitions returns all 5 scopes', () => {
    const all = getAllScopeDefinitions();
    expect(all.length).toBe(5);
    const ids = all.map((s) => s.id);
    expect(ids).toContain('message');
    expect(ids).toContain('read_availability');
    expect(ids).toContain('create_events');
    expect(ids).toContain('read_profile');
    expect(ids).toContain('execute_requests');
  });

  test('getValidScopeIds returns a set of all 5 scope IDs', () => {
    const ids = getValidScopeIds();
    expect(ids.size).toBe(5);
    expect(ids.has('message')).toBe(true);
    expect(ids.has('execute_requests')).toBe(true);
  });

  test('risk levels are correctly assigned', () => {
    expect(getScopeDefinition('message')!.riskLevel).toBe('low');
    expect(getScopeDefinition('read_availability')!.riskLevel).toBe('low');
    expect(getScopeDefinition('create_events')!.riskLevel).toBe('medium');
    expect(getScopeDefinition('read_profile')!.riskLevel).toBe('low');
    expect(getScopeDefinition('execute_requests')!.riskLevel).toBe('high');
  });
});

// ===========================================================================
// Scope Policy Engine Tests
// ===========================================================================

describe('a2a-scope-policy', () => {
  describe('evaluateScope', () => {
    test('allows action when required scope is granted', () => {
      const result = evaluateScope(['message', 'read_profile'], 'sendMessage');
      expect(result.allowed).toBe(true);
    });

    test('denies action when required scope is missing', () => {
      const result = evaluateScope(['read_profile'], 'sendMessage');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('message');
        expect(result.reason).toContain('not granted');
      }
    });

    test('denies action with empty scopes', () => {
      const result = evaluateScope([], 'sendMessage');
      expect(result.allowed).toBe(false);
    });

    test('maps all actions to correct scopes', () => {
      const actionScopeMap: Array<[A2AScopedAction, string]> = [
        ['sendMessage', 'message'],
        ['receiveMessage', 'message'],
        ['readAvailability', 'read_availability'],
        ['createEvent', 'create_events'],
        ['readProfile', 'read_profile'],
        ['executeRequest', 'execute_requests'],
      ];

      for (const [action, scope] of actionScopeMap) {
        // Should be allowed when the correct scope is present
        const allowed = evaluateScope([scope], action);
        expect(allowed.allowed).toBe(true);

        // Should be denied when a different scope is present
        const otherScope = scope === 'message' ? 'read_profile' : 'message';
        const denied = evaluateScope([otherScope], action);
        expect(denied.allowed).toBe(false);
      }
    });

    test('receiveMessage and sendMessage both require message scope', () => {
      const sendResult = evaluateScope(['message'], 'sendMessage');
      const receiveResult = evaluateScope(['message'], 'receiveMessage');
      expect(sendResult.allowed).toBe(true);
      expect(receiveResult.allowed).toBe(true);
    });
  });

  describe('getRequiredScopeForAction', () => {
    test('returns scope for known actions', () => {
      expect(getRequiredScopeForAction('sendMessage')).toBe('message');
      expect(getRequiredScopeForAction('receiveMessage')).toBe('message');
      expect(getRequiredScopeForAction('readAvailability')).toBe('read_availability');
      expect(getRequiredScopeForAction('createEvent')).toBe('create_events');
      expect(getRequiredScopeForAction('readProfile')).toBe('read_profile');
      expect(getRequiredScopeForAction('executeRequest')).toBe('execute_requests');
    });

    test('returns undefined for unknown actions', () => {
      expect(getRequiredScopeForAction('deleteEverything')).toBeUndefined();
      expect(getRequiredScopeForAction('')).toBeUndefined();
    });
  });

  describe('getRequiredScopeForTool', () => {
    test('returns undefined for all tools in v1 (no tool-level mappings yet)', () => {
      expect(getRequiredScopeForTool('bash')).toBeUndefined();
      expect(getRequiredScopeForTool('file_read')).toBeUndefined();
      expect(getRequiredScopeForTool('some_tool')).toBeUndefined();
    });
  });
});

// ===========================================================================
// sendMessage Scope Check Tests
// ===========================================================================

describe('sendMessage scope check', () => {
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

  test('returns scope_denied when connection lacks message scope', async () => {
    scopePolicyEnabled = true;
    // Connection with no scopes
    const { connection } = createActiveConnection({ scopes: [] });

    const result = await sendMessage({
      connectionId: connection.id,
      content: { type: 'text', text: 'hello' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('scope_denied');
      expect(result.detail).toContain('message');
    }
  });

  test('proceeds past scope check when connection has message scope', async () => {
    scopePolicyEnabled = true;
    // Connection with message scope
    const { connection } = createActiveConnection({ scopes: ['message'] });

    const result = await sendMessage({
      connectionId: connection.id,
      content: { type: 'text', text: 'hello' },
    });

    // It should proceed past scope check — will fail at delivery (no actual server)
    if (!result.ok) {
      expect(result.reason).not.toBe('scope_denied');
      expect(result.reason).not.toBe('not_enabled');
    }
  });

  test('returns not_enabled when feature flag is off (ignores scopes)', async () => {
    scopePolicyEnabled = false;
    const { connection } = createActiveConnection({ scopes: ['message'] });

    const result = await sendMessage({
      connectionId: connection.id,
      content: { type: 'text', text: 'hello' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_enabled');
    }
  });

  test('scope_denied when connection has other scopes but not message', async () => {
    scopePolicyEnabled = true;
    const { connection } = createActiveConnection({
      scopes: ['read_profile', 'read_availability'],
    });

    const result = await sendMessage({
      connectionId: connection.id,
      content: { type: 'text', text: 'hello' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('scope_denied');
    }
  });
});

// ===========================================================================
// Inbound Message Scope Check Tests
// ===========================================================================

describe('handleA2AMessageInbound scope check', () => {
  beforeEach(() => {
    resetTables();
  });

  function createSignedRequest(
    envelope: ReturnType<typeof createTextMessage>,
    credential: string,
  ): Request {
    const bodyText = JSON.stringify(envelope);
    const headers = signRequest(envelope.connectionId, credential, bodyText);

    return new Request('http://localhost/v1/a2a/messages/inbound', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [HEADER_SIGNATURE]: headers[HEADER_SIGNATURE],
        [HEADER_TIMESTAMP]: headers[HEADER_TIMESTAMP],
        [HEADER_NONCE]: headers[HEADER_NONCE],
        [HEADER_CONNECTION_ID]: headers[HEADER_CONNECTION_ID],
      },
      body: bodyText,
    });
  }

  test('allows inbound message when scope policy is off (backwards compatible)', async () => {
    scopePolicyEnabled = false;
    const { connection, credentials } = createActiveConnection({ scopes: [] });

    const envelope = createTextMessage({
      connectionId: connection.id,
      senderAssistantId: 'peer-001',
      text: 'hello from peer',
    });

    const req = createSignedRequest(envelope, credentials.inboundCredential);
    let processMessageCalled = false;
    const mockProcessor = async () => {
      processMessageCalled = true;
      return {};
    };

    const response = await handleA2AMessageInbound(req, mockProcessor as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(processMessageCalled).toBe(true);
  });

  test('denies inbound message when scope policy is on and message scope missing', async () => {
    scopePolicyEnabled = true;
    const { connection, credentials } = createActiveConnection({ scopes: [] });

    const envelope = createTextMessage({
      connectionId: connection.id,
      senderAssistantId: 'peer-001',
      text: 'hello from peer',
    });

    const req = createSignedRequest(envelope, credentials.inboundCredential);

    const response = await handleA2AMessageInbound(req);
    expect(response.status).toBe(403);

    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.message).toContain('Scope not granted');
  });

  test('allows inbound message when scope policy is on and message scope granted', async () => {
    scopePolicyEnabled = true;
    const { connection, credentials } = createActiveConnection({ scopes: ['message'] });

    const envelope = createTextMessage({
      connectionId: connection.id,
      senderAssistantId: 'peer-001',
      text: 'hello from peer',
    });

    const req = createSignedRequest(envelope, credentials.inboundCredential);
    let processMessageCalled = false;
    const mockProcessor = async () => {
      processMessageCalled = true;
      return {};
    };

    const response = await handleA2AMessageInbound(req, mockProcessor as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(processMessageCalled).toBe(true);
  });
});

// ===========================================================================
// Scope Validation on updateConnectionScopes Tests
// ===========================================================================

describe('updateConnectionScopes validation', () => {
  beforeEach(() => {
    resetTables();
  });

  test('accepts valid catalog scope IDs', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
    });

    const result = updateConnectionScopes(conn.id, ['message', 'read_profile']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.scopes).toEqual(['message', 'read_profile']);
    }
  });

  test('rejects undeclared scope IDs', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
    });

    const result = updateConnectionScopes(conn.id, ['message', 'fake_scope']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_scopes');
      expect(result.detail).toContain('fake_scope');
    }
  });

  test('rejects all undeclared scope IDs in a batch', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
    });

    const result = updateConnectionScopes(conn.id, ['bad_one', 'bad_two']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_scopes');
      expect(result.detail).toContain('bad_one');
      expect(result.detail).toContain('bad_two');
    }
  });

  test('does not modify scopes when validation fails', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      scopes: ['message'],
    });

    updateConnectionScopes(conn.id, ['message', 'invalid_scope']);

    // Scopes should remain unchanged
    const current = getConnection(conn.id);
    expect(current!.scopes).toEqual(['message']);
  });

  test('accepts all 5 catalog scopes at once', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
    });

    const result = updateConnectionScopes(conn.id, [
      'message',
      'read_availability',
      'create_events',
      'read_profile',
      'execute_requests',
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.scopes.length).toBe(5);
    }
  });

  test('accepts empty scope array (revoke all)', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      scopes: ['message'],
    });

    const result = updateConnectionScopes(conn.id, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.scopes).toEqual([]);
    }
  });
});
