/**
 * Tests for actor-token mint/verify service, hash-only storage,
 * guardian bootstrap endpoint idempotency, HTTP middleware strict
 * enforcement, and local IPC identity fallback.
 */
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

import { initializeDb, resetDb } from '../memory/db.js';
import {
  createBinding,
  getActiveBinding,
} from '../memory/guardian-bindings.js';
import {
  hashToken,
  initSigningKey,
  mintActorToken,
  verifyActorToken,
} from '../runtime/actor-token-service.js';
import {
  createActorTokenRecord,
  findActiveByDeviceBinding,
  findActiveByTokenHash,
  revokeByDeviceBinding,
  revokeByTokenHash,
} from '../runtime/actor-token-store.js';
import { ensureVellumGuardianBinding } from '../runtime/guardian-vellum-migration.js';
import {
  verifyHttpActorToken,
  verifyHttpActorTokenWithLocalFallback,
} from '../runtime/middleware/actor-token.js';
import { resolveLocalIpcGuardianContext } from '../runtime/local-actor-identity.js';

initializeDb();

beforeEach(() => {
  // Reset the signing key to a deterministic value for reproducibility
  initSigningKey(Buffer.from('test-signing-key-32-bytes-long!!'));
  // Clear DB state between tests
  resetDb();
  initializeDb();
});

afterAll(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Actor token mint/verify
// ---------------------------------------------------------------------------

describe('actor-token mint/verify', () => {
  test('mint returns token, hash, and claims', () => {
    const result = mintActorToken({
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'device-123',
      guardianPrincipalId: 'principal-abc',
    });

    expect(result.token).toBeTruthy();
    expect(result.tokenHash).toBeTruthy();
    expect(result.claims.assistantId).toBe('self');
    expect(result.claims.platform).toBe('macos');
    expect(result.claims.deviceId).toBe('device-123');
    expect(result.claims.guardianPrincipalId).toBe('principal-abc');
    expect(result.claims.iat).toBeGreaterThan(0);
    expect(result.claims.exp).toBeNull();
    expect(result.claims.jti).toBeTruthy();
  });

  test('verify succeeds for valid token', () => {
    const { token } = mintActorToken({
      assistantId: 'self',
      platform: 'ios',
      deviceId: 'device-456',
      guardianPrincipalId: 'principal-def',
    });

    const result = verifyActorToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.assistantId).toBe('self');
      expect(result.claims.platform).toBe('ios');
    }
  });

  test('verify fails for tampered token', () => {
    const { token } = mintActorToken({
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'device-789',
      guardianPrincipalId: 'principal-ghi',
    });

    // Tamper with the payload
    const parts = token.split('.');
    const tampered = parts[0] + 'X' + '.' + parts[1];
    const result = verifyActorToken(tampered);
    expect(result.ok).toBe(false);
  });

  test('verify fails for malformed token', () => {
    const result = verifyActorToken('not-a-valid-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed_token');
    }
  });

  test('verify fails for expired token', () => {
    const { token } = mintActorToken({
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'device-exp',
      guardianPrincipalId: 'principal-exp',
      ttlMs: -1000, // Already expired
    });

    const result = verifyActorToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('token_expired');
    }
  });

  test('hashToken produces consistent SHA-256 hex', () => {
    const hash1 = hashToken('test-token');
    const hash2 = hashToken('test-token');
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // SHA-256 hex = 64 chars
  });

  test('different tokens produce different hashes', () => {
    const { token: t1 } = mintActorToken({
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'dev1',
      guardianPrincipalId: 'p1',
    });
    const { token: t2 } = mintActorToken({
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'dev2',
      guardianPrincipalId: 'p2',
    });
    expect(hashToken(t1)).not.toBe(hashToken(t2));
  });
});

// ---------------------------------------------------------------------------
// Hash-only storage
// ---------------------------------------------------------------------------

describe('actor-token store (hash-only)', () => {
  test('createActorTokenRecord stores hash, never raw token', () => {
    const { tokenHash } = mintActorToken({
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'dev-store',
      guardianPrincipalId: 'principal-store',
    });

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
    // Verify the record can be found by hash
    const found = findActiveByTokenHash(tokenHash);
    expect(found).not.toBeNull();
    expect(found!.tokenHash).toBe(tokenHash);
  });

  test('findActiveByDeviceBinding returns matching record', () => {
    const { tokenHash } = mintActorToken({
      assistantId: 'self',
      platform: 'ios',
      deviceId: 'dev-bind',
      guardianPrincipalId: 'principal-bind',
    });

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
    const { tokenHash } = mintActorToken({
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'dev-revoke',
      guardianPrincipalId: 'principal-revoke',
    });

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

    // Should no longer be found as active
    const found = findActiveByTokenHash(tokenHash);
    expect(found).toBeNull();
  });

  test('revokeByTokenHash revokes a single token', () => {
    const { tokenHash } = mintActorToken({
      assistantId: 'self',
      platform: 'macos',
      deviceId: 'dev-single',
      guardianPrincipalId: 'principal-single',
    });

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
    // Create a telegram binding
    createBinding({
      assistantId: 'self',
      channel: 'telegram',
      guardianExternalUserId: 'tg-user-123',
      guardianDeliveryChatId: 'tg-chat-456',
      verifiedVia: 'challenge',
    });

    // Now backfill vellum
    ensureVellumGuardianBinding('self');

    // Telegram binding should still exist
    const tgBinding = getActiveBinding('self', 'telegram');
    expect(tgBinding).not.toBeNull();
    expect(tgBinding!.guardianExternalUserId).toBe('tg-user-123');

    // Vellum binding should also exist
    const vBinding = getActiveBinding('self', 'vellum');
    expect(vBinding).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bootstrap idempotency (via route handler)
// ---------------------------------------------------------------------------

describe('bootstrap endpoint idempotency', () => {
  test('calling bootstrap twice returns same guardianPrincipalId', async () => {
    // We test the logic used by the bootstrap route handler directly
    // rather than spinning up a full HTTP server.
    const { handleGuardianBootstrap } = await import('../runtime/routes/guardian-bootstrap-routes.js');

    const req1 = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'macos', deviceId: 'test-device-1' }),
    });

    const res1 = await handleGuardianBootstrap(req1);
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as Record<string, unknown>;
    expect(body1.guardianPrincipalId).toBeTruthy();
    expect(body1.actorToken).toBeTruthy();
    expect(body1.isNew).toBe(true);

    // Second call with same device
    const req2 = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'macos', deviceId: 'test-device-1' }),
    });

    const res2 = await handleGuardianBootstrap(req2);
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as Record<string, unknown>;
    expect(body2.guardianPrincipalId).toBe(body1.guardianPrincipalId);
    expect(body2.actorToken).toBeTruthy();
    // New token minted (previous revoked), but same principal
    expect(body2.actorToken).not.toBe(body1.actorToken);
    expect(body2.isNew).toBe(false);
  });

  test('bootstrap rejects missing fields', async () => {
    const { handleGuardianBootstrap } = await import('../runtime/routes/guardian-bootstrap-routes.js');

    const req = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'macos' }),
    });

    const res = await handleGuardianBootstrap(req);
    expect(res.status).toBe(400);
  });

  test('bootstrap rejects invalid platform', async () => {
    const { handleGuardianBootstrap } = await import('../runtime/routes/guardian-bootstrap-routes.js');

    const req = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'android', deviceId: 'test-device' }),
    });

    const res = await handleGuardianBootstrap(req);
    expect(res.status).toBe(400);
  });

  test('bootstrap with different devices returns same principal but different tokens', async () => {
    const { handleGuardianBootstrap } = await import('../runtime/routes/guardian-bootstrap-routes.js');

    const req1 = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'macos', deviceId: 'device-A' }),
    });

    const res1 = await handleGuardianBootstrap(req1);
    const body1 = await res1.json() as Record<string, unknown>;

    const req2 = new Request('http://localhost/v1/integrations/guardian/vellum/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'ios', deviceId: 'device-B' }),
    });

    const res2 = await handleGuardianBootstrap(req2);
    const body2 = await res2.json() as Record<string, unknown>;

    // Same principal, different tokens
    expect(body2.guardianPrincipalId).toBe(body1.guardianPrincipalId);
    expect(body2.actorToken).not.toBe(body1.actorToken);
  });
});

// ---------------------------------------------------------------------------
// HTTP middleware strict enforcement
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
    const { token } = mintActorToken({
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
    const { token, tokenHash } = mintActorToken({
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

    // Revoke the token
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

  test('accepts request with valid active token and resolves guardian context', () => {
    const principalId = ensureVellumGuardianBinding('self');
    const { token, tokenHash } = mintActorToken({
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

    const result = verifyHttpActorTokenWithLocalFallback(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.guardianContext.trustClass).toBe('guardian');
      // localFallback should be true when claims are null
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

    const result = verifyHttpActorTokenWithLocalFallback(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.message).toContain('Proxied requests require actor identity');
    }
  });

  test('uses strict verification when actor token is present even with X-Forwarded-For', () => {
    const principalId = ensureVellumGuardianBinding('self');
    const { token, tokenHash } = mintActorToken({
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

    const result = verifyHttpActorTokenWithLocalFallback(req);
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

  test('returns fallback guardian context when no vellum binding exists', () => {
    // No binding created — fresh DB state
    const ctx = resolveLocalIpcGuardianContext();
    expect(ctx.trustClass).toBe('guardian');
    expect(ctx.sourceChannel).toBe('vellum');
  });

  test('respects custom sourceChannel parameter', () => {
    ensureVellumGuardianBinding('self');
    const ctx = resolveLocalIpcGuardianContext('vellum');
    expect(ctx.sourceChannel).toBe('vellum');
  });
});
