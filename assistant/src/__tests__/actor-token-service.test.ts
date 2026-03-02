/**
 * Tests for JWT credential service, hash-only storage,
 * guardian bootstrap endpoint idempotency, HTTP middleware strict
 * enforcement, and local IPC identity fallback.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'actor-token-test-')));

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getDbPath: () => join(testDir, 'test.db'),
  normalizeAssistantId: (id: string) => id === 'self' ? 'self' : id,
  readLockfile: () => null,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

import { getSqlite, initializeDb, resetDb } from '../memory/db.js';
import {
  createBinding,
  getActiveBinding,
} from '../memory/guardian-bindings.js';
import { hashToken, initAuthSigningKey } from '../runtime/auth/token-service.js';
import { resetExternalAssistantIdCache } from '../runtime/auth/external-assistant-id.js';
import { setLegacySigningKey } from '../runtime/middleware/actor-token.js';
import {
  createActorTokenRecord,
  findActiveByDeviceBinding,
  findActiveByTokenHash,
  revokeByDeviceBinding,
  revokeByTokenHash,
} from '../runtime/actor-token-store.js';
import { ensureVellumGuardianBinding } from '../runtime/guardian-vellum-migration.js';
import { resolveLocalIpcGuardianContext } from '../runtime/local-actor-identity.js';
import {
  type ActorTokenClaims,
  isActorBoundGuardian,
  isLocalFallbackBoundGuardian,
  type ServerWithRequestIP,
  verifyHttpActorToken,
  verifyHttpActorTokenWithLocalFallback,
} from '../runtime/middleware/actor-token.js';

// ---------------------------------------------------------------------------
// Test signing key + legacy HMAC token helpers
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.from('test-signing-key-32-bytes-long!!');

/**
 * Mint a legacy HMAC actor token for testing the middleware verification.
 * Mirrors the format of the deleted actor-token-service.
 */
function mintLegacyActorToken(params: {
  assistantId: string;
  platform: string;
  deviceId: string;
  guardianPrincipalId: string;
  ttlMs?: number | null;
}): { token: string; tokenHash: string; claims: ActorTokenClaims } {
  const now = Date.now();
  const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const effectiveTtl = params.ttlMs === undefined ? DEFAULT_TTL_MS : params.ttlMs;
  const claims: ActorTokenClaims = {
    assistantId: params.assistantId,
    platform: params.platform,
    deviceId: params.deviceId,
    guardianPrincipalId: params.guardianPrincipalId,
    iat: now,
    exp: effectiveTtl != null ? now + effectiveTtl : null,
    jti: randomBytes(16).toString('hex'),
  };

  const payload = Buffer.from(JSON.stringify(claims), 'utf-8').toString('base64url');
  const sig = createHmac('sha256', TEST_KEY).update(payload).digest();
  const token = payload + '.' + sig.toString('base64url');
  const tokenHash = hashToken(token);

  return { token, tokenHash, claims };
}

// ---------------------------------------------------------------------------
// Mock server helpers for loopback IP checks
// ---------------------------------------------------------------------------

/** Creates a mock server that returns the given IP for any request. */
function mockServer(address: string): ServerWithRequestIP {
  return {
    requestIP: () => ({ address, family: 'IPv4', port: 0 }),
  };
}

/** Mock loopback server — returns 127.0.0.1 for all requests. */
const loopbackServer = mockServer('127.0.0.1');

/** Mock non-loopback server — returns a LAN IP for all requests. */
const nonLoopbackServer = mockServer('192.168.1.50');

initializeDb();

beforeEach(() => {
  // Initialize signing key for both JWT and legacy HMAC verification
  initAuthSigningKey(TEST_KEY);
  setLegacySigningKey(TEST_KEY);
  // Reset the external assistant ID cache so tests don't leak state
  resetExternalAssistantIdCache();
  // Clear DB state between tests.
  resetDb();
  initializeDb();
  const db = getSqlite();
  db.run('DELETE FROM actor_token_records');
  db.run('DELETE FROM channel_guardian_bindings');
});

afterAll(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Hash-only storage
// ---------------------------------------------------------------------------

describe('actor-token store (hash-only)', () => {
  test('createActorTokenRecord stores hash, never raw token', () => {
    const tokenHash = hashToken('test-token-for-store');

    const record = createActorTokenRecord({
      tokenHash,
      assistantId: 'self',
      guardianPrincipalId: 'principal-store',
      hashedDeviceId: 'hashed-dev-store',
      platform: 'macos',
      issuedAt: Date.now(),
    });

    expect(record.tokenHash).toBe(tokenHash);
    expect(record.status).toBe('active');
    const found = findActiveByTokenHash(tokenHash);
    expect(found).not.toBeNull();
    expect(found!.tokenHash).toBe(tokenHash);
  });

  test('findActiveByDeviceBinding returns matching record', () => {
    const tokenHash = hashToken('test-token-for-binding');

    createActorTokenRecord({
      tokenHash,
      assistantId: 'self',
      guardianPrincipalId: 'principal-bind',
      hashedDeviceId: 'hashed-dev-bind',
      platform: 'ios',
      issuedAt: Date.now(),
    });

    const found = findActiveByDeviceBinding('self', 'principal-bind', 'hashed-dev-bind');
    expect(found).not.toBeNull();
    expect(found!.platform).toBe('ios');
  });

  test('revokeByDeviceBinding marks tokens as revoked', () => {
    const tokenHash = hashToken('test-token-for-revoke');

    createActorTokenRecord({
      tokenHash,
      assistantId: 'self',
      guardianPrincipalId: 'principal-revoke',
      hashedDeviceId: 'hashed-dev-revoke',
      platform: 'macos',
      issuedAt: Date.now(),
    });

    const count = revokeByDeviceBinding('self', 'principal-revoke', 'hashed-dev-revoke');
    expect(count).toBe(1);

    const found = findActiveByTokenHash(tokenHash);
    expect(found).toBeNull();
  });

  test('revokeByTokenHash revokes a single token', () => {
    const tokenHash = hashToken('test-token-for-single-revoke');

    createActorTokenRecord({
      tokenHash,
      assistantId: 'self',
      guardianPrincipalId: 'principal-single',
      hashedDeviceId: 'hashed-dev-single',
      platform: 'macos',
      issuedAt: Date.now(),
    });

    expect(revokeByTokenHash(tokenHash)).toBe(true);
    expect(findActiveByTokenHash(tokenHash)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Guardian vellum migration
// ---------------------------------------------------------------------------

describe('guardian vellum migration', () => {
  test('ensureVellumGuardianBinding creates binding when missing', () => {
    const principalId = ensureVellumGuardianBinding('self');
    expect(principalId).toMatch(/^vellum-principal-/);

    const binding = getActiveBinding('self', 'vellum');
    expect(binding).not.toBeNull();
    expect(binding!.guardianExternalUserId).toBe(principalId);
    expect(binding!.verifiedVia).toBe('startup-migration');
  });

  test('ensureVellumGuardianBinding is idempotent', () => {
    const first = ensureVellumGuardianBinding('self');
    const second = ensureVellumGuardianBinding('self');
    expect(first).toBe(second);
  });

  test('ensureVellumGuardianBinding preserves existing bindings for other channels', () => {
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'tg-user-123',
      guardianDeliveryChatId: 'tg-chat-456',
      verifiedVia: 'challenge',
    });

    ensureVellumGuardianBinding('self');

    const tgBinding = getActiveBinding('self', 'telegram');
    expect(tgBinding).not.toBeNull();
    expect(tgBinding!.guardianExternalUserId).toBe('tg-user-123');

    const vBinding = getActiveBinding('self', 'vellum');
    expect(vBinding).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bootstrap idempotency (via route handler)
// ---------------------------------------------------------------------------

describe('bootstrap endpoint idempotency', () => {
  test('calling bootstrap twice returns same guardianPrincipalId', async () => {
    const { handleGuardianBootstrap } = await import('../runtime/routes/guardian-bootstrap-routes.js');

    const req1 = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'macos', deviceId: 'test-device-1' }),
    });

    const res1 = await handleGuardianBootstrap(req1, loopbackServer);
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as Record<string, unknown>;
    expect(body1.guardianPrincipalId).toBeTruthy();
    expect(body1.accessToken).toBeTruthy();
    expect(body1.isNew).toBe(true);

    // Second call with same device
    const req2 = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'macos', deviceId: 'test-device-1' }),
    });

    const res2 = await handleGuardianBootstrap(req2, loopbackServer);
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as Record<string, unknown>;
    expect(body2.guardianPrincipalId).toBe(body1.guardianPrincipalId);
    expect(body2.accessToken).toBeTruthy();
    // New token minted (previous revoked), but same principal
    expect(body2.accessToken).not.toBe(body1.accessToken);
    expect(body2.isNew).toBe(false);
  });

  test('bootstrap rejects missing fields', async () => {
    const { handleGuardianBootstrap } = await import('../runtime/routes/guardian-bootstrap-routes.js');

    const req = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'macos' }),
    });

    const res = await handleGuardianBootstrap(req, loopbackServer);
    expect(res.status).toBe(400);
  });

  test('bootstrap rejects invalid platform', async () => {
    const { handleGuardianBootstrap } = await import('../runtime/routes/guardian-bootstrap-routes.js');

    const req = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'android', deviceId: 'test-device' }),
    });

    const res = await handleGuardianBootstrap(req, loopbackServer);
    expect(res.status).toBe(400);
  });

  test('bootstrap with different devices returns same principal but different tokens', async () => {
    const { handleGuardianBootstrap } = await import('../runtime/routes/guardian-bootstrap-routes.js');

    const req1 = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'macos', deviceId: 'device-A' }),
    });

    const res1 = await handleGuardianBootstrap(req1, loopbackServer);
    const body1 = await res1.json() as Record<string, unknown>;

    const req2 = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'macos', deviceId: 'device-B' }),
    });

    const res2 = await handleGuardianBootstrap(req2, loopbackServer);
    const body2 = await res2.json() as Record<string, unknown>;

    // Same principal, different tokens
    expect(body2.guardianPrincipalId).toBe(body1.guardianPrincipalId);
    expect(body2.accessToken).not.toBe(body1.accessToken);
  });

  test('bootstrap access token is a 3-part JWT', async () => {
    const { handleGuardianBootstrap } = await import('../runtime/routes/guardian-bootstrap-routes.js');

    const req = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'macos', deviceId: 'test-device-jwt' }),
    });

    const res = await handleGuardianBootstrap(req, loopbackServer);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const accessToken = body.accessToken as string;
    expect(accessToken).toBeTruthy();
    // JWTs have 3 dot-separated parts
    expect(accessToken.split('.').length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// HTTP middleware strict enforcement (legacy HMAC tokens)
// ---------------------------------------------------------------------------

describe('HTTP actor token middleware (strict enforcement)', () => {
  test('rejects request without X-Actor-Token header', () => {
    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const result = verifyHttpActorToken(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.message).toContain('Missing X-Actor-Token');
    }
  });

  test('rejects request with invalid (tampered) token', () => {
    const { token } = mintLegacyActorToken({
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'device-tamper',
      guardianPrincipalId: 'principal-tamper',
    });

    const parts = token.split('.');
    const tampered = parts[0] + 'XXXXXX.' + parts[1];

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'X-Actor-Token': tampered },
    });

    const result = verifyHttpActorToken(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  test('rejects request with revoked token', () => {
    const principalId = ensureVellumGuardianBinding('self');
    const { token, tokenHash } = mintLegacyActorToken({
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'device-revoked',
      guardianPrincipalId: principalId,
    });

    createActorTokenRecord({
      tokenHash,
      assistantId: 'self',
      guardianPrincipalId: principalId,
      hashedDeviceId: 'hashed-device-revoked',
      platform: 'macos',
      issuedAt: Date.now(),
    });

    revokeByTokenHash(tokenHash);

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'X-Actor-Token': token },
    });

    const result = verifyHttpActorToken(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.message).toContain('no longer active');
    }
  });

  test('accepts request with valid active legacy token and resolves guardian context', () => {
    const principalId = ensureVellumGuardianBinding('self');
    const { token, tokenHash } = mintLegacyActorToken({
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'device-valid',
      guardianPrincipalId: principalId,
    });

    createActorTokenRecord({
      tokenHash,
      assistantId: 'self',
      guardianPrincipalId: principalId,
      hashedDeviceId: 'hashed-device-valid',
      platform: 'macos',
      issuedAt: Date.now(),
    });

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'X-Actor-Token': token },
    });

    const result = verifyHttpActorToken(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.assistantId).toBe('self');
      expect(result.claims.guardianPrincipalId).toBe(principalId);
      expect(result.guardianContext).toBeTruthy();
      expect(result.guardianContext.trustClass).toBe('guardian');
    }
  });
});

// ---------------------------------------------------------------------------
// Local IPC fallback (verifyHttpActorTokenWithLocalFallback)
// ---------------------------------------------------------------------------

describe('HTTP actor token local fallback', () => {
  test('falls back to local IPC identity when no actor token and no forwarding header', () => {
    ensureVellumGuardianBinding('self');

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const result = verifyHttpActorTokenWithLocalFallback(req, loopbackServer);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.guardianContext.trustClass).toBe('guardian');
      if ('localFallback' in result) {
        expect(result.localFallback).toBe(true);
        expect(result.claims).toBeNull();
      }
    }
  });

  test('rejects gateway-proxied request without actor token (X-Forwarded-For present)', () => {
    ensureVellumGuardianBinding('self');

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '1.2.3.4',
      },
    });

    const result = verifyHttpActorTokenWithLocalFallback(req, loopbackServer);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.message).toContain('Proxied requests require actor identity');
    }
  });

  test('uses strict verification when actor token is present even with X-Forwarded-For', () => {
    const principalId = ensureVellumGuardianBinding('self');
    const { token, tokenHash } = mintLegacyActorToken({
      assistantId: 'self',
      platform: 'ios',
      deviceId: 'device-proxied',
      guardianPrincipalId: principalId,
    });

    createActorTokenRecord({
      tokenHash,
      assistantId: 'self',
      guardianPrincipalId: principalId,
      hashedDeviceId: 'hashed-device-proxied',
      platform: 'ios',
      issuedAt: Date.now(),
    });

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: {
        'X-Actor-Token': token,
        'X-Forwarded-For': '1.2.3.4',
      },
    });

    const result = verifyHttpActorTokenWithLocalFallback(req, loopbackServer);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims).not.toBeNull();
      expect(result.guardianContext.trustClass).toBe('guardian');
    }
  });
});

// ---------------------------------------------------------------------------
// Local IPC identity resolution
// ---------------------------------------------------------------------------

describe('resolveLocalIpcGuardianContext', () => {
  test('returns guardian context when vellum binding exists', () => {
    ensureVellumGuardianBinding('self');

    const ctx = resolveLocalIpcGuardianContext();
    expect(ctx.trustClass).toBe('guardian');
    expect(ctx.sourceChannel).toBe('vellum');
  });

  test('returns guardian context with principal when no vellum binding exists (pre-bootstrap self-heal)', () => {
    const ctx = resolveLocalIpcGuardianContext();
    expect(ctx.trustClass).toBe('guardian');
    expect(ctx.sourceChannel).toBe('vellum');
    expect(ctx.guardianPrincipalId).toBeDefined();
  });

  test('respects custom sourceChannel parameter', () => {
    ensureVellumGuardianBinding('self');
    const ctx = resolveLocalIpcGuardianContext('vellum');
    expect(ctx.sourceChannel).toBe('vellum');
  });
});

// ---------------------------------------------------------------------------
// Pairing actor-token flow
// ---------------------------------------------------------------------------

describe('pairing credential flow', () => {
  test('mintPairingCredentials returns access token in approved pairing status poll', async () => {
    ensureVellumGuardianBinding('self');

    const { PairingStore } = await import('../daemon/pairing-store.js');
    const { handlePairingRequest, handlePairingStatus } = await import('../runtime/routes/pairing-routes.js');

    const store = new PairingStore();
    store.start();

    const pairingRequestId = 'test-pair-' + Date.now();
    const pairingSecret = 'test-secret-123';
    const bearerToken = 'test-bearer';

    store.register({
      pairingRequestId,
      pairingSecret,
      gatewayUrl: 'https://gw.test',
    });

    const ctx = {
      pairingStore: store,
      bearerToken,
      featureFlagToken: undefined,
      pairingBroadcast: () => {},
    };

    const pairReq = new Request('http://localhost/v1/pairing/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingRequestId,
        pairingSecret,
        deviceId: 'ios-device-1',
        deviceName: 'Test iPhone',
      }),
    });

    const pairRes = await handlePairingRequest(pairReq, ctx);
    expect(pairRes.status).toBe(200);
    const pairBody = await pairRes.json() as Record<string, unknown>;
    expect(pairBody.status).toBe('pending');

    store.approve(pairingRequestId, bearerToken);

    const statusUrl = new URL(`http://localhost/v1/pairing/status?id=${pairingRequestId}&secret=${pairingSecret}`);
    const statusRes = handlePairingStatus(statusUrl, ctx);
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json() as Record<string, unknown>;
    expect(statusBody.status).toBe('approved');
    expect(statusBody.accessToken).toBeTruthy();
    expect(statusBody.bearerToken).toBe(bearerToken);

    store.stop();
  });

  test('approved access token is available within 5 min TTL window', async () => {
    ensureVellumGuardianBinding('self');

    const { PairingStore } = await import('../daemon/pairing-store.js');
    const { handlePairingRequest, handlePairingStatus } = await import('../runtime/routes/pairing-routes.js');

    const store = new PairingStore();
    store.start();

    const pairingRequestId = 'test-ttl-' + Date.now();
    const pairingSecret = 'test-secret-ttl';
    const bearerToken = 'test-bearer-ttl';

    store.register({
      pairingRequestId,
      pairingSecret,
      gatewayUrl: 'https://gw.test',
    });

    const ctx = {
      pairingStore: store,
      bearerToken,
      featureFlagToken: undefined,
      pairingBroadcast: () => {},
    };

    const pairReq = new Request('http://localhost/v1/pairing/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingRequestId,
        pairingSecret,
        deviceId: 'ios-device-ttl',
        deviceName: 'TTL iPhone',
      }),
    });

    await handlePairingRequest(pairReq, ctx);
    store.approve(pairingRequestId, bearerToken);

    const statusUrl = new URL(`http://localhost/v1/pairing/status?id=${pairingRequestId}&secret=${pairingSecret}`);
    const firstRes = handlePairingStatus(statusUrl, ctx);
    const firstBody = await firstRes.json() as Record<string, unknown>;
    const firstToken = firstBody.accessToken as string;
    expect(firstToken).toBeTruthy();

    const secondRes = handlePairingStatus(statusUrl, ctx);
    const secondBody = await secondRes.json() as Record<string, unknown>;
    expect(secondBody.accessToken).toBe(firstToken);

    store.stop();
  });

  test('approved status can recover token mint using deviceId query when transient pairing state is missing', async () => {
    ensureVellumGuardianBinding('self');

    const { PairingStore } = await import('../daemon/pairing-store.js');
    const {
      cleanupPairingState,
      handlePairingRequest,
      handlePairingStatus,
    } = await import('../runtime/routes/pairing-routes.js');

    const store = new PairingStore();
    store.start();

    const pairingRequestId = 'test-recover-' + Date.now();
    const pairingSecret = 'test-secret-recover';
    const bearerToken = 'test-bearer-recover';
    const deviceId = 'ios-device-recover';

    store.register({
      pairingRequestId,
      pairingSecret,
      gatewayUrl: 'https://gw.test',
    });

    const ctx = {
      pairingStore: store,
      bearerToken,
      featureFlagToken: undefined,
      pairingBroadcast: () => {},
    };

    const pairReq = new Request('http://localhost/v1/pairing/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingRequestId,
        pairingSecret,
        deviceId,
        deviceName: 'Recovery iPhone',
      }),
    });

    const pairRes = await handlePairingRequest(pairReq, ctx);
    expect(pairRes.status).toBe(200);

    store.approve(pairingRequestId, bearerToken);
    cleanupPairingState(pairingRequestId);

    const statusUrl = new URL(
      `http://localhost/v1/pairing/status?id=${pairingRequestId}&secret=${pairingSecret}&deviceId=${encodeURIComponent(deviceId)}`,
    );
    const statusRes = handlePairingStatus(statusUrl, ctx);
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json() as Record<string, unknown>;

    expect(statusBody.status).toBe('approved');
    expect(statusBody.accessToken).toBeTruthy();
    expect(statusBody.bearerToken).toBe(bearerToken);

    store.stop();
  });

  test('mintingInFlight guard prevents concurrent mints (synchronous check)', async () => {
    ensureVellumGuardianBinding('self');

    const { PairingStore } = await import('../daemon/pairing-store.js');
    const { handlePairingRequest, handlePairingStatus } = await import('../runtime/routes/pairing-routes.js');

    const store = new PairingStore();
    store.start();

    const pairingRequestId = 'test-concurrent-' + Date.now();
    const pairingSecret = 'test-secret-conc';
    const bearerToken = 'test-bearer-conc';

    store.register({
      pairingRequestId,
      pairingSecret,
      gatewayUrl: 'https://gw.test',
    });

    const ctx = {
      pairingStore: store,
      bearerToken,
      featureFlagToken: undefined,
      pairingBroadcast: () => {},
    };

    const pairReq = new Request('http://localhost/v1/pairing/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingRequestId,
        pairingSecret,
        deviceId: 'ios-device-conc',
        deviceName: 'Concurrent iPhone',
      }),
    });

    await handlePairingRequest(pairReq, ctx);
    store.approve(pairingRequestId, bearerToken);

    const statusUrl = new URL(`http://localhost/v1/pairing/status?id=${pairingRequestId}&secret=${pairingSecret}`);
    const res1 = handlePairingStatus(statusUrl, ctx);
    const res2 = handlePairingStatus(statusUrl, ctx);

    const body1 = await res1.json() as Record<string, unknown>;
    const body2 = await res2.json() as Record<string, unknown>;

    expect(body1.status).toBe('approved');
    expect(body2.status).toBe('approved');
    expect(body1.accessToken).toBeTruthy();
    expect(body2.accessToken).toBe(body1.accessToken);

    store.stop();
  });
});

// ---------------------------------------------------------------------------
// Loopback IP check tests
// ---------------------------------------------------------------------------

describe('loopback IP check (verifyHttpActorTokenWithLocalFallback)', () => {
  test('succeeds with mock server returning loopback IP', () => {
    ensureVellumGuardianBinding('self');

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const result = verifyHttpActorTokenWithLocalFallback(req, loopbackServer);
    expect(result.ok).toBe(true);
    if (result.ok && 'localFallback' in result) {
      expect(result.localFallback).toBe(true);
      expect(result.guardianContext.trustClass).toBe('guardian');
    }
  });

  test('succeeds with mock server returning IPv6 loopback (::1)', () => {
    ensureVellumGuardianBinding('self');

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const ipv6LoopbackServer = mockServer('::1');
    const result = verifyHttpActorTokenWithLocalFallback(req, ipv6LoopbackServer);
    expect(result.ok).toBe(true);
  });

  test('succeeds with mock server returning IPv4-mapped IPv6 loopback', () => {
    ensureVellumGuardianBinding('self');

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const mappedLoopbackServer = mockServer('::ffff:127.0.0.1');
    const result = verifyHttpActorTokenWithLocalFallback(req, mappedLoopbackServer);
    expect(result.ok).toBe(true);
  });

  test('returns 401 with mock server returning non-loopback IP', () => {
    ensureVellumGuardianBinding('self');

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const result = verifyHttpActorTokenWithLocalFallback(req, nonLoopbackServer);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.message).toContain('Non-loopback requests require actor identity');
    }
  });

  test('returns 401 with X-Forwarded-For header present', () => {
    ensureVellumGuardianBinding('self');

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.0.0.1',
      },
    });

    const result = verifyHttpActorTokenWithLocalFallback(req, loopbackServer);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.message).toContain('Proxied requests require actor identity');
    }
  });
});

// ---------------------------------------------------------------------------
// Bootstrap loopback guard tests
// ---------------------------------------------------------------------------

describe('bootstrap loopback guard', () => {
  test('rejects bootstrap request with X-Forwarded-For header', async () => {
    const { handleGuardianBootstrap } = await import('../runtime/routes/guardian-bootstrap-routes.js');

    const req = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.0.0.1',
      },
      body: JSON.stringify({ platform: 'macos', deviceId: 'test-device' }),
    });

    const res = await handleGuardianBootstrap(req, loopbackServer);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('local-only');
  });

  test('rejects bootstrap request from non-loopback IP', async () => {
    const { handleGuardianBootstrap } = await import('../runtime/routes/guardian-bootstrap-routes.js');

    const req = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'macos', deviceId: 'test-device' }),
    });

    const res = await handleGuardianBootstrap(req, nonLoopbackServer);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain('local-only');
  });

  test('accepts bootstrap request from loopback IP', async () => {
    const { handleGuardianBootstrap } = await import('../runtime/routes/guardian-bootstrap-routes.js');

    const req = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'macos', deviceId: 'test-device-ok' }),
    });

    const res = await handleGuardianBootstrap(req, loopbackServer);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Utility function tests (isActorBoundGuardian, isLocalFallbackBoundGuardian)
// ---------------------------------------------------------------------------

describe('utility functions', () => {
  test('isActorBoundGuardian returns true when actor matches bound guardian', () => {
    const principalId = ensureVellumGuardianBinding('self');
    const claims: ActorTokenClaims = {
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'device-bound',
      guardianPrincipalId: principalId,
      iat: Date.now(),
      exp: Date.now() + 86400000,
      jti: 'test-jti',
    };

    expect(isActorBoundGuardian(claims)).toBe(true);
  });

  test('isActorBoundGuardian returns false for mismatched principal', () => {
    ensureVellumGuardianBinding('self');
    const claims: ActorTokenClaims = {
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'device-mismatch',
      guardianPrincipalId: 'wrong-principal-id',
      iat: Date.now(),
      exp: Date.now() + 86400000,
      jti: 'test-jti',
    };

    expect(isActorBoundGuardian(claims)).toBe(false);
  });

  test('isActorBoundGuardian returns false when no vellum binding exists', () => {
    const claims: ActorTokenClaims = {
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'device-no-binding',
      guardianPrincipalId: 'some-principal',
      iat: Date.now(),
      exp: Date.now() + 86400000,
      jti: 'test-jti',
    };

    expect(isActorBoundGuardian(claims)).toBe(false);
  });

  test('isLocalFallbackBoundGuardian returns true when vellum binding exists', () => {
    ensureVellumGuardianBinding('self');
    expect(isLocalFallbackBoundGuardian()).toBe(true);
  });

  test('isLocalFallbackBoundGuardian returns true even without binding (pre-bootstrap fallback)', () => {
    expect(isLocalFallbackBoundGuardian()).toBe(true);
  });
});
