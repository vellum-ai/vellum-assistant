import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = mkdtempSync(join(tmpdir(), 'a2a-peer-auth-test-'));

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

import {
  CREDENTIAL_BYTE_LENGTH,
  DEFAULT_REPLAY_WINDOW_MS,
  HEADER_CONNECTION_ID,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  NonceStore,
  buildSigningPayload,
  computeHmac,
  generateCredentialPair,
  generateCredentialToken,
  revokeCredentials,
  rotateCredentials,
  signRequest,
  verifyRequest,
  verifySignature,
} from '../a2a-peer-auth.js';
import { hashHandshakeSecret } from '../a2a-handshake.js';
import {
  createConnection,
  getConnection,
  updateConnectionStatus,
} from '../a2a-peer-connection-store.js';
import { getDb, initializeDb, resetDb } from '../../memory/db.js';

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run('DELETE FROM a2a_peer_connections');
}

// ---------------------------------------------------------------------------
// Credential generation
// ---------------------------------------------------------------------------

describe('generateCredentialToken', () => {
  test('produces a hex string of expected length', () => {
    const token = generateCredentialToken();
    // 32 bytes = 64 hex characters
    expect(token).toHaveLength(CREDENTIAL_BYTE_LENGTH * 2);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  test('generates unique tokens on successive calls', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      tokens.add(generateCredentialToken());
    }
    expect(tokens.size).toBe(50);
  });
});

describe('generateCredentialPair', () => {
  test('returns inbound and outbound credentials with their hashes', () => {
    const pair = generateCredentialPair();

    expect(pair.inboundCredential).toHaveLength(CREDENTIAL_BYTE_LENGTH * 2);
    expect(pair.outboundCredential).toHaveLength(CREDENTIAL_BYTE_LENGTH * 2);
    expect(pair.inboundCredentialHash).toHaveLength(64); // SHA-256 hex
    expect(pair.outboundCredentialHash).toHaveLength(64);
  });

  test('hashes match the raw credentials', () => {
    const pair = generateCredentialPair();

    expect(pair.inboundCredentialHash).toBe(hashHandshakeSecret(pair.inboundCredential));
    expect(pair.outboundCredentialHash).toBe(hashHandshakeSecret(pair.outboundCredential));
  });

  test('inbound and outbound credentials are different', () => {
    const pair = generateCredentialPair();
    expect(pair.inboundCredential).not.toBe(pair.outboundCredential);
  });

  test('successive pairs are unique', () => {
    const pair1 = generateCredentialPair();
    const pair2 = generateCredentialPair();

    expect(pair1.inboundCredential).not.toBe(pair2.inboundCredential);
    expect(pair1.outboundCredential).not.toBe(pair2.outboundCredential);
  });
});

// ---------------------------------------------------------------------------
// HMAC signing primitives
// ---------------------------------------------------------------------------

describe('buildSigningPayload', () => {
  test('concatenates timestamp, nonce, and body with colons', () => {
    const payload = buildSigningPayload('1700000000000', 'nonce-abc', '{"hello":"world"}');
    expect(payload).toBe('1700000000000:nonce-abc:{"hello":"world"}');
  });

  test('handles empty body', () => {
    const payload = buildSigningPayload('123', 'n', '');
    expect(payload).toBe('123:n:');
  });
});

describe('computeHmac', () => {
  test('produces a hex string', () => {
    const hmac = computeHmac('secret-key', 'some payload');
    expect(hmac).toMatch(/^[0-9a-f]+$/);
    // HMAC-SHA256 produces 32 bytes = 64 hex chars
    expect(hmac).toHaveLength(64);
  });

  test('same inputs produce same output (deterministic)', () => {
    const a = computeHmac('key', 'data');
    const b = computeHmac('key', 'data');
    expect(a).toBe(b);
  });

  test('different keys produce different signatures', () => {
    const a = computeHmac('key-1', 'data');
    const b = computeHmac('key-2', 'data');
    expect(a).not.toBe(b);
  });

  test('different data produces different signatures', () => {
    const a = computeHmac('key', 'data-1');
    const b = computeHmac('key', 'data-2');
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Request signing
// ---------------------------------------------------------------------------

describe('signRequest', () => {
  test('returns all required headers', () => {
    const headers = signRequest('conn-1', 'my-credential', '{"test":true}');

    expect(headers[HEADER_SIGNATURE]).toBeTruthy();
    expect(headers[HEADER_TIMESTAMP]).toBeTruthy();
    expect(headers[HEADER_NONCE]).toBeTruthy();
    expect(headers[HEADER_CONNECTION_ID]).toBe('conn-1');
  });

  test('signature is a valid HMAC-SHA256 hex string', () => {
    const headers = signRequest('conn-1', 'cred', 'body');
    expect(headers[HEADER_SIGNATURE]).toMatch(/^[0-9a-f]{64}$/);
  });

  test('nonce is a UUID', () => {
    const headers = signRequest('conn-1', 'cred', 'body');
    expect(headers[HEADER_NONCE]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test('uses provided timestamp when given', () => {
    const headers = signRequest('conn-1', 'cred', 'body', 1700000000000);
    expect(headers[HEADER_TIMESTAMP]).toBe('1700000000000');
  });

  test('signature is verifiable', () => {
    const credential = generateCredentialToken();
    const body = '{"message":"hello"}';
    const now = Date.now();

    const headers = signRequest('conn-1', credential, body, now);

    // Manually verify the signature
    const payload = buildSigningPayload(headers[HEADER_TIMESTAMP], headers[HEADER_NONCE], body);
    const expectedSig = computeHmac(credential, payload);
    expect(headers[HEADER_SIGNATURE]).toBe(expectedSig);
  });

  test('different calls produce different nonces', () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const headers = signRequest('conn-1', 'cred', 'body');
      nonces.add(headers[HEADER_NONCE]);
    }
    expect(nonces.size).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// NonceStore
// ---------------------------------------------------------------------------

describe('NonceStore', () => {
  test('new nonce returns false (not seen)', () => {
    const store = new NonceStore();
    expect(store.hasBeenSeen('nonce-1')).toBe(false);
  });

  test('repeated nonce returns true (seen)', () => {
    const store = new NonceStore();
    store.hasBeenSeen('nonce-1');
    expect(store.hasBeenSeen('nonce-1')).toBe(true);
  });

  test('different nonces are tracked independently', () => {
    const store = new NonceStore();
    expect(store.hasBeenSeen('a')).toBe(false);
    expect(store.hasBeenSeen('b')).toBe(false);
    expect(store.hasBeenSeen('a')).toBe(true);
    expect(store.hasBeenSeen('b')).toBe(true);
    expect(store.hasBeenSeen('c')).toBe(false);
  });

  test('size tracks the number of stored nonces', () => {
    const store = new NonceStore();
    expect(store.size).toBe(0);

    store.hasBeenSeen('a');
    expect(store.size).toBe(1);

    store.hasBeenSeen('b');
    expect(store.size).toBe(2);

    // Duplicate does not increase size
    store.hasBeenSeen('a');
    expect(store.size).toBe(2);
  });

  test('sweep evicts nonces older than the replay window', () => {
    const store = new NonceStore(1000); // 1-second window
    const baseTime = 1000000;

    store.hasBeenSeen('old-nonce', baseTime);
    store.hasBeenSeen('new-nonce', baseTime + 1500);
    expect(store.size).toBe(2);

    // Sweep at time where old-nonce is expired but new-nonce is not
    const evicted = store.sweep(baseTime + 2000);
    expect(evicted).toBe(1);
    expect(store.size).toBe(1);

    // Verify old-nonce was evicted (can be re-used)
    expect(store.hasBeenSeen('old-nonce', baseTime + 2000)).toBe(false);
    // new-nonce is still tracked
    expect(store.hasBeenSeen('new-nonce', baseTime + 2000)).toBe(true);
  });

  test('opportunistic sweep triggers after replay window interval', () => {
    const store = new NonceStore(1000); // 1-second window
    const baseTime = 1000000;

    store.hasBeenSeen('old', baseTime);
    expect(store.size).toBe(1);

    // This call triggers an opportunistic sweep because enough time has passed
    store.hasBeenSeen('new', baseTime + 2000);
    // old should have been evicted, new is added
    expect(store.size).toBe(1);
  });

  test('clear resets the store', () => {
    const store = new NonceStore();
    store.hasBeenSeen('a');
    store.hasBeenSeen('b');
    expect(store.size).toBe(2);

    store.clear();
    expect(store.size).toBe(0);
    expect(store.hasBeenSeen('a')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifySignature (stateless — no DB)
// ---------------------------------------------------------------------------

describe('verifySignature', () => {
  test('valid signature passes', () => {
    const credential = generateCredentialToken();
    const body = '{"test":true}';
    const now = Date.now();
    const nonceStore = new NonceStore();

    const headers = signRequest('conn-1', credential, body, now);

    const result = verifySignature({
      signature: headers[HEADER_SIGNATURE],
      timestamp: headers[HEADER_TIMESTAMP],
      nonce: headers[HEADER_NONCE],
      body,
      credential,
      nonceStore,
      now,
    });

    expect(result.ok).toBe(true);
  });

  test('tampered body fails verification', () => {
    const credential = generateCredentialToken();
    const body = '{"test":true}';
    const now = Date.now();
    const nonceStore = new NonceStore();

    const headers = signRequest('conn-1', credential, body, now);

    const result = verifySignature({
      signature: headers[HEADER_SIGNATURE],
      timestamp: headers[HEADER_TIMESTAMP],
      nonce: headers[HEADER_NONCE],
      body: '{"test":false}', // tampered
      credential,
      nonceStore,
      now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature');
  });

  test('wrong credential fails verification', () => {
    const realCredential = generateCredentialToken();
    const wrongCredential = generateCredentialToken();
    const body = '{"data":"hello"}';
    const now = Date.now();
    const nonceStore = new NonceStore();

    const headers = signRequest('conn-1', realCredential, body, now);

    const result = verifySignature({
      signature: headers[HEADER_SIGNATURE],
      timestamp: headers[HEADER_TIMESTAMP],
      nonce: headers[HEADER_NONCE],
      body,
      credential: wrongCredential,
      nonceStore,
      now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature');
  });

  test('expired timestamp rejected', () => {
    const credential = generateCredentialToken();
    const body = 'body';
    const oldTime = Date.now() - DEFAULT_REPLAY_WINDOW_MS - 1000;
    const nonceStore = new NonceStore();

    const headers = signRequest('conn-1', credential, body, oldTime);

    const result = verifySignature({
      signature: headers[HEADER_SIGNATURE],
      timestamp: headers[HEADER_TIMESTAMP],
      nonce: headers[HEADER_NONCE],
      body,
      credential,
      nonceStore,
      now: Date.now(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timestamp_expired');
  });

  test('future timestamp beyond replay window rejected', () => {
    const credential = generateCredentialToken();
    const body = 'body';
    const futureTime = Date.now() + DEFAULT_REPLAY_WINDOW_MS + 1000;
    const nonceStore = new NonceStore();

    const headers = signRequest('conn-1', credential, body, futureTime);

    const result = verifySignature({
      signature: headers[HEADER_SIGNATURE],
      timestamp: headers[HEADER_TIMESTAMP],
      nonce: headers[HEADER_NONCE],
      body,
      credential,
      nonceStore,
      now: Date.now(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timestamp_expired');
  });

  test('duplicate nonce rejected', () => {
    const credential = generateCredentialToken();
    const body = 'body';
    const now = Date.now();
    const nonceStore = new NonceStore();

    const headers = signRequest('conn-1', credential, body, now);

    // First verification succeeds
    const result1 = verifySignature({
      signature: headers[HEADER_SIGNATURE],
      timestamp: headers[HEADER_TIMESTAMP],
      nonce: headers[HEADER_NONCE],
      body,
      credential,
      nonceStore,
      now,
    });
    expect(result1.ok).toBe(true);

    // Replay with same nonce fails
    const result2 = verifySignature({
      signature: headers[HEADER_SIGNATURE],
      timestamp: headers[HEADER_TIMESTAMP],
      nonce: headers[HEADER_NONCE],
      body,
      credential,
      nonceStore,
      now,
    });
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.reason).toBe('nonce_replayed');
  });
});

// ---------------------------------------------------------------------------
// verifyRequest (full — with DB lookup)
// ---------------------------------------------------------------------------

describe('verifyRequest', () => {
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

  function createActiveConnection(inboundCredential: string): { connection: ReturnType<typeof createConnection>; inboundCredential: string } {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'active',
      inboundCredentialHash: hashHandshakeSecret(inboundCredential),
      outboundCredentialHash: hashHandshakeSecret(generateCredentialToken()),
    });
    return { connection: conn, inboundCredential };
  }

  test('valid request passes full verification', () => {
    const inboundCred = generateCredentialToken();
    const { connection } = createActiveConnection(inboundCred);
    const body = '{"action":"ping"}';
    const now = Date.now();
    const nonceStore = new NonceStore();

    // The peer signs with the inbound credential (from our perspective)
    const headers = signRequest(connection.id, inboundCred, body, now);

    const result = verifyRequest({
      headers: {
        [HEADER_SIGNATURE]: headers[HEADER_SIGNATURE],
        [HEADER_TIMESTAMP]: headers[HEADER_TIMESTAMP],
        [HEADER_NONCE]: headers[HEADER_NONCE],
        [HEADER_CONNECTION_ID]: headers[HEADER_CONNECTION_ID],
      },
      body,
      inboundCredential: inboundCred,
      nonceStore,
      now,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.connectionId).toBe(connection.id);
  });

  test('missing headers rejected', () => {
    const nonceStore = new NonceStore();

    const result = verifyRequest({
      headers: {},
      body: 'body',
      inboundCredential: 'cred',
      nonceStore,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_headers');
  });

  test('partial headers rejected', () => {
    const nonceStore = new NonceStore();

    const result = verifyRequest({
      headers: {
        [HEADER_SIGNATURE]: 'sig',
        [HEADER_TIMESTAMP]: '123',
        // missing nonce and connection-id
      },
      body: 'body',
      inboundCredential: 'cred',
      nonceStore,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_headers');
  });

  test('nonexistent connection rejected', () => {
    const nonceStore = new NonceStore();
    const now = Date.now();
    const cred = generateCredentialToken();
    const headers = signRequest('nonexistent-id', cred, 'body', now);

    const result = verifyRequest({
      headers: {
        [HEADER_SIGNATURE]: headers[HEADER_SIGNATURE],
        [HEADER_TIMESTAMP]: headers[HEADER_TIMESTAMP],
        [HEADER_NONCE]: headers[HEADER_NONCE],
        [HEADER_CONNECTION_ID]: 'nonexistent-id',
      },
      body: 'body',
      inboundCredential: cred,
      nonceStore,
      now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('connection_not_found');
  });

  test('pending connection rejected', () => {
    const inboundCred = generateCredentialToken();
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'pending',
      inboundCredentialHash: hashHandshakeSecret(inboundCred),
    });
    const nonceStore = new NonceStore();
    const now = Date.now();
    const headers = signRequest(conn.id, inboundCred, 'body', now);

    const result = verifyRequest({
      headers: {
        [HEADER_SIGNATURE]: headers[HEADER_SIGNATURE],
        [HEADER_TIMESTAMP]: headers[HEADER_TIMESTAMP],
        [HEADER_NONCE]: headers[HEADER_NONCE],
        [HEADER_CONNECTION_ID]: conn.id,
      },
      body: 'body',
      inboundCredential: inboundCred,
      nonceStore,
      now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('connection_not_active');
  });

  test('revoked connection rejected with credential_revoked', () => {
    const inboundCred = generateCredentialToken();
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'revoked',
      inboundCredentialHash: hashHandshakeSecret(inboundCred),
    });
    const nonceStore = new NonceStore();
    const now = Date.now();
    const headers = signRequest(conn.id, inboundCred, 'body', now);

    const result = verifyRequest({
      headers: {
        [HEADER_SIGNATURE]: headers[HEADER_SIGNATURE],
        [HEADER_TIMESTAMP]: headers[HEADER_TIMESTAMP],
        [HEADER_NONCE]: headers[HEADER_NONCE],
        [HEADER_CONNECTION_ID]: conn.id,
      },
      body: 'body',
      inboundCredential: inboundCred,
      nonceStore,
      now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('credential_revoked');
  });

  test('expired timestamp rejected', () => {
    const inboundCred = generateCredentialToken();
    const { connection } = createActiveConnection(inboundCred);
    const nonceStore = new NonceStore();
    const now = Date.now();
    const oldTime = now - DEFAULT_REPLAY_WINDOW_MS - 1000;

    const headers = signRequest(connection.id, inboundCred, 'body', oldTime);

    const result = verifyRequest({
      headers: {
        [HEADER_SIGNATURE]: headers[HEADER_SIGNATURE],
        [HEADER_TIMESTAMP]: headers[HEADER_TIMESTAMP],
        [HEADER_NONCE]: headers[HEADER_NONCE],
        [HEADER_CONNECTION_ID]: connection.id,
      },
      body: 'body',
      inboundCredential: inboundCred,
      nonceStore,
      now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timestamp_expired');
  });

  test('replayed nonce rejected', () => {
    const inboundCred = generateCredentialToken();
    const { connection } = createActiveConnection(inboundCred);
    const body = '{"test":true}';
    const now = Date.now();
    const nonceStore = new NonceStore();

    const headers = signRequest(connection.id, inboundCred, body, now);
    const headerObj = {
      [HEADER_SIGNATURE]: headers[HEADER_SIGNATURE],
      [HEADER_TIMESTAMP]: headers[HEADER_TIMESTAMP],
      [HEADER_NONCE]: headers[HEADER_NONCE],
      [HEADER_CONNECTION_ID]: connection.id,
    };

    // First request succeeds
    const result1 = verifyRequest({
      headers: headerObj,
      body,
      inboundCredential: inboundCred,
      nonceStore,
      now,
    });
    expect(result1.ok).toBe(true);

    // Replay with same nonce fails
    const result2 = verifyRequest({
      headers: headerObj,
      body,
      inboundCredential: inboundCred,
      nonceStore,
      now,
    });
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.reason).toBe('nonce_replayed');
  });

  test('tampered body fails signature verification', () => {
    const inboundCred = generateCredentialToken();
    const { connection } = createActiveConnection(inboundCred);
    const now = Date.now();
    const nonceStore = new NonceStore();

    const headers = signRequest(connection.id, inboundCred, '{"original":true}', now);

    const result = verifyRequest({
      headers: {
        [HEADER_SIGNATURE]: headers[HEADER_SIGNATURE],
        [HEADER_TIMESTAMP]: headers[HEADER_TIMESTAMP],
        [HEADER_NONCE]: headers[HEADER_NONCE],
        [HEADER_CONNECTION_ID]: connection.id,
      },
      body: '{"tampered":true}',
      inboundCredential: inboundCred,
      nonceStore,
      now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature');
  });
});

// ---------------------------------------------------------------------------
// Credential rotation
// ---------------------------------------------------------------------------

describe('rotateCredentials', () => {
  beforeEach(() => {
    resetTables();
  });

  test('generates new credentials and updates the connection', () => {
    const oldPair = generateCredentialPair();
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'active',
      outboundCredentialHash: oldPair.outboundCredentialHash,
      inboundCredentialHash: oldPair.inboundCredentialHash,
    });

    const result = rotateCredentials(conn.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    // New credentials are different from old ones
    expect(result.newCredentials.outboundCredential).not.toBe(oldPair.outboundCredential);
    expect(result.newCredentials.inboundCredential).not.toBe(oldPair.inboundCredential);

    // Connection store is updated
    const updated = getConnection(conn.id);
    expect(updated).not.toBeNull();
    expect(updated!.outboundCredentialHash).toBe(result.newCredentials.outboundCredentialHash);
    expect(updated!.inboundCredentialHash).toBe(result.newCredentials.inboundCredentialHash);
  });

  test('new credentials work for signing/verification', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'active',
      outboundCredentialHash: hashHandshakeSecret('old-outbound'),
      inboundCredentialHash: hashHandshakeSecret('old-inbound'),
    });

    const result = rotateCredentials(conn.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    // Sign with new outbound credential
    const body = '{"after":"rotation"}';
    const now = Date.now();
    const headers = signRequest(conn.id, result.newCredentials.outboundCredential, body, now);

    // Verify with new outbound credential
    const nonceStore = new NonceStore();
    const verifyResult = verifySignature({
      signature: headers[HEADER_SIGNATURE],
      timestamp: headers[HEADER_TIMESTAMP],
      nonce: headers[HEADER_NONCE],
      body,
      credential: result.newCredentials.outboundCredential,
      nonceStore,
      now,
    });
    expect(verifyResult.ok).toBe(true);
  });

  test('old credentials fail after rotation', () => {
    const oldOutbound = generateCredentialToken();
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'active',
      outboundCredentialHash: hashHandshakeSecret(oldOutbound),
      inboundCredentialHash: hashHandshakeSecret('old-inbound'),
    });

    const result = rotateCredentials(conn.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    // Sign with OLD outbound credential
    const body = '{"old":"credential"}';
    const now = Date.now();
    const headers = signRequest(conn.id, oldOutbound, body, now);

    // Verify with NEW outbound credential should fail
    const nonceStore = new NonceStore();
    const verifyResult = verifySignature({
      signature: headers[HEADER_SIGNATURE],
      timestamp: headers[HEADER_TIMESTAMP],
      nonce: headers[HEADER_NONCE],
      body,
      credential: result.newCredentials.outboundCredential,
      nonceStore,
      now,
    });
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) expect(verifyResult.reason).toBe('invalid_signature');
  });

  test('rotation fails for non-active connection', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'pending',
    });

    const result = rotateCredentials(conn.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('connection_not_active');
  });

  test('rotation fails for nonexistent connection', () => {
    const result = rotateCredentials('nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('connection_not_found');
  });
});

// ---------------------------------------------------------------------------
// Credential revocation
// ---------------------------------------------------------------------------

describe('revokeCredentials', () => {
  beforeEach(() => {
    resetTables();
  });

  test('revokes an active connection', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'active',
      outboundCredentialHash: hashHandshakeSecret('out'),
      inboundCredentialHash: hashHandshakeSecret('in'),
    });

    const result = revokeCredentials(conn.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.connection.status).toBe('revoked');
  });

  test('credentials are tombstoned after revocation', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'active',
      outboundCredentialHash: hashHandshakeSecret('out'),
      inboundCredentialHash: hashHandshakeSecret('in'),
    });

    revokeCredentials(conn.id);

    const updated = getConnection(conn.id);
    expect(updated).not.toBeNull();
    expect(updated!.outboundCredentialHash).toBe('');
    expect(updated!.inboundCredentialHash).toBe('');
  });

  test('revoked connection rejects new requests via verifyRequest', () => {
    const inboundCred = generateCredentialToken();
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'active',
      inboundCredentialHash: hashHandshakeSecret(inboundCred),
      outboundCredentialHash: hashHandshakeSecret(generateCredentialToken()),
    });

    // Revoke
    revokeCredentials(conn.id);

    // Try to make a request with the old credential
    const body = '{"after":"revocation"}';
    const now = Date.now();
    const nonceStore = new NonceStore();
    const headers = signRequest(conn.id, inboundCred, body, now);

    const result = verifyRequest({
      headers: {
        [HEADER_SIGNATURE]: headers[HEADER_SIGNATURE],
        [HEADER_TIMESTAMP]: headers[HEADER_TIMESTAMP],
        [HEADER_NONCE]: headers[HEADER_NONCE],
        [HEADER_CONNECTION_ID]: conn.id,
      },
      body,
      inboundCredential: inboundCred,
      nonceStore,
      now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('credential_revoked');
  });

  test('cannot revoke an already-revoked connection', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'active',
    });

    const first = revokeCredentials(conn.id);
    expect(first.ok).toBe(true);

    const second = revokeCredentials(conn.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_revoked');
  });

  test('cannot revoke a nonexistent connection', () => {
    const result = revokeCredentials('nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('connection_not_found');
  });

  test('can revoke a pending connection', () => {
    const conn = createConnection({
      peerGatewayUrl: 'https://peer.example.com',
      status: 'pending',
    });

    const result = revokeCredentials(conn.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.connection.status).toBe('revoked');
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  test('DEFAULT_REPLAY_WINDOW_MS is 5 minutes', () => {
    expect(DEFAULT_REPLAY_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  test('CREDENTIAL_BYTE_LENGTH is 32', () => {
    expect(CREDENTIAL_BYTE_LENGTH).toBe(32);
  });
});
