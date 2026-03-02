/**
 * JWT token service for the single-header auth system.
 *
 * Mints and verifies standard JWTs (header.payload.signature) using
 * HMAC-SHA256. Reuses signing key infrastructure from the existing
 * actor-token-service to avoid duplication during the transition period.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { isStaleEpoch } from './policy.js';
import type { ScopeProfile, TokenAudience, TokenClaims } from './types.js';

// Re-export loadOrCreateSigningKey so callers can load/persist the key
// without importing from two places during the transition.
export { loadOrCreateSigningKey } from '../actor-token-service.js';

// ---------------------------------------------------------------------------
// Internal: signing key access
// ---------------------------------------------------------------------------

import { initSigningKey as _initLegacyKey } from '../actor-token-service.js';

function getSigningKey(): Buffer {
  if (!_authSigningKey) {
    throw new Error('Auth signing key not initialized — call initAuthSigningKey() during startup');
  }
  return _authSigningKey;
}

let _authSigningKey: Buffer | null = null;

/**
 * Single initialization entry point for the auth signing key. Sets both
 * the new auth module key and the legacy actor-token-service key so that
 * both token systems share the same material. Callers should use this
 * instead of importing initSigningKey from actor-token-service directly.
 */
export function initAuthSigningKey(key: Buffer): void {
  _authSigningKey = key;
  // Keep the legacy actor-token-service key in sync during the transition
  _initLegacyKey(key);
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
// Result types
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// JWT header — static for HMAC-SHA256
// ---------------------------------------------------------------------------

const JWT_HEADER = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

/**
 * Mint a new JWT token with the given parameters.
 *
 * Returns the complete JWT string (header.payload.signature).
 */
export function mintToken(params: {
  aud: TokenAudience;
  sub: string;
  scope_profile: ScopeProfile;
  policy_epoch: number;
  ttlSeconds: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = {
    iss: 'vellum-auth',
    aud: params.aud,
    sub: params.sub,
    scope_profile: params.scope_profile,
    exp: now + params.ttlSeconds,
    policy_epoch: params.policy_epoch,
    iat: now,
    jti: randomBytes(16).toString('hex'),
  };

  const payload = base64urlEncode(JSON.stringify(claims));
  const sigInput = JWT_HEADER + '.' + payload;
  const sig = createHmac('sha256', getSigningKey())
    .update(sigInput)
    .digest();

  return sigInput + '.' + base64urlEncode(sig);
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify a JWT token's structural integrity, signature, expiration,
 * audience, and policy epoch.
 *
 * Does NOT check revocation — callers must additionally verify the
 * token hash against a revocation store if needed.
 */
export function verifyToken(token: string, expectedAud: TokenAudience): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed_token: expected 3 dot-separated parts' };
  }

  const [headerPart, payloadPart, sigPart] = parts;

  // Recompute HMAC over header.payload
  const sigInput = headerPart + '.' + payloadPart;
  const expectedSig = createHmac('sha256', getSigningKey())
    .update(sigInput)
    .digest();
  const actualSig = base64urlDecode(sigPart);

  if (expectedSig.length !== actualSig.length) {
    return { ok: false, reason: 'invalid_signature' };
  }

  if (!timingSafeEqual(expectedSig, actualSig)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  // Decode and parse claims
  let claims: TokenClaims;
  try {
    const decoded = base64urlDecode(payloadPart).toString('utf-8');
    claims = JSON.parse(decoded) as TokenClaims;
  } catch {
    return { ok: false, reason: 'malformed_claims' };
  }

  // Audience check
  if (claims.aud !== expectedAud) {
    return { ok: false, reason: `audience_mismatch: expected ${expectedAud}, got ${claims.aud}` };
  }

  // Expiration check (claims.exp is in seconds)
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (claims.exp <= nowSeconds) {
    return { ok: false, reason: 'token_expired' };
  }

  // Policy epoch check
  if (isStaleEpoch(claims.policy_epoch)) {
    return { ok: false, reason: 'stale_policy_epoch' };
  }

  return { ok: true, claims };
}

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of a raw token string (for revocation store lookups). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
