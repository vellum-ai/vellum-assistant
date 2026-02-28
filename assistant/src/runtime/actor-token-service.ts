/**
 * Actor-token mint/verify service.
 *
 * Mints HMAC-signed actor tokens bound to (assistantId, guardianPrincipalId,
 * deviceId, platform). Only the SHA-256 hash of the token is persisted —
 * the raw plaintext is returned to the caller once and never stored.
 *
 * Token format: base64url(JSON claims) + '.' + base64url(HMAC-SHA256 signature)
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { getLogger } from '../util/logger.js';

const log = getLogger('actor-token-service');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActorTokenClaims {
  /** The assistant this token is scoped to. */
  assistantId: string;
  /** Platform: 'macos' | 'ios' */
  platform: string;
  /** Opaque device identifier (hashed for storage). */
  deviceId: string;
  /** The guardian principal this token is bound to. */
  guardianPrincipalId: string;
  /** Token issuance timestamp (epoch ms). */
  iat: number;
  /** Token expiration timestamp (epoch ms). Null means non-expiring. */
  exp: number | null;
  /** Random jti (JWT ID) for uniqueness. */
  jti: string;
}

export interface MintResult {
  /** The raw actor token string — returned once, never persisted. */
  token: string;
  /** SHA-256 hex hash of the token (for storage/lookup). */
  tokenHash: string;
  /** The decoded claims. */
  claims: ActorTokenClaims;
}

export type VerifyResult =
  | { ok: true; claims: ActorTokenClaims }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Signing key management
// ---------------------------------------------------------------------------

let signingKey: Buffer | null = null;

/**
 * Initialize (or reinitialize) the signing key. In production this is
 * derived once at startup from a persisted secret; tests can inject a
 * deterministic key.
 */
export function initSigningKey(key?: Buffer): void {
  signingKey = key ?? randomBytes(32);
}

function getSigningKey(): Buffer {
  if (!signingKey) {
    // Lazy init on first use — ensures the daemon can mint tokens even
    // if initSigningKey() was not called during startup.
    signingKey = randomBytes(32);
    log.info('Actor-token signing key lazily initialized');
  }
  return signingKey;
}

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return buf.toString('base64url');
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of a raw token string. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

/**
 * Mint a new actor token.
 *
 * @param params Token claims (assistantId, platform, deviceId, guardianPrincipalId).
 * @param ttlMs  Optional TTL in milliseconds. Null/undefined means non-expiring.
 * @returns The raw token, its hash, and the embedded claims.
 */
export function mintActorToken(params: {
  assistantId: string;
  platform: string;
  deviceId: string;
  guardianPrincipalId: string;
  ttlMs?: number | null;
}): MintResult {
  const now = Date.now();
  const claims: ActorTokenClaims = {
    assistantId: params.assistantId,
    platform: params.platform,
    deviceId: params.deviceId,
    guardianPrincipalId: params.guardianPrincipalId,
    iat: now,
    exp: params.ttlMs != null ? now + params.ttlMs : null,
    jti: randomBytes(16).toString('hex'),
  };

  const payload = base64urlEncode(JSON.stringify(claims));
  const sig = createHmac('sha256', getSigningKey())
    .update(payload)
    .digest();
  const token = payload + '.' + base64urlEncode(sig);
  const tokenHash = hashToken(token);

  return { token, tokenHash, claims };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify an actor token's structural integrity and signature.
 *
 * Does NOT check revocation — callers must additionally verify the
 * token hash exists in the actor-token store with status='active'.
 */
export function verifyActorToken(token: string): VerifyResult {
  const dotIndex = token.indexOf('.');
  if (dotIndex < 0) {
    return { ok: false, reason: 'malformed_token' };
  }

  const payload = token.slice(0, dotIndex);
  const sigPart = token.slice(dotIndex + 1);

  // Recompute HMAC
  const expectedSig = createHmac('sha256', getSigningKey())
    .update(payload)
    .digest();
  const actualSig = base64urlDecode(sigPart);

  if (expectedSig.length !== actualSig.length) {
    return { ok: false, reason: 'invalid_signature' };
  }

  // Constant-time comparison
  if (!timingSafeEqual(expectedSig, actualSig)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  let claims: ActorTokenClaims;
  try {
    const decoded = base64urlDecode(payload).toString('utf-8');
    claims = JSON.parse(decoded) as ActorTokenClaims;
  } catch {
    return { ok: false, reason: 'malformed_claims' };
  }

  // Expiration check
  if (claims.exp != null && Date.now() > claims.exp) {
    return { ok: false, reason: 'token_expired' };
  }

  return { ok: true, claims };
}
