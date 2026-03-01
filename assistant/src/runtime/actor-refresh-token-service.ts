/**
 * Refresh token service — mint, rotate, and validate refresh tokens.
 *
 * Implements rotating single-use refresh tokens with:
 * - Absolute expiry (365 days)
 * - Inactivity expiry (90 days since last refresh)
 * - Replay detection (reuse of rotated token revokes entire family)
 */

import { createHash, randomBytes } from 'node:crypto';

import { getDb } from '../memory/db.js';
import { getLogger } from '../util/logger.js';
import { hashToken, mintActorToken } from './actor-token-service.js';
import {
  createActorTokenRecord,
  revokeByDeviceBinding as revokeActorTokensByDevice,
} from './actor-token-store.js';
import {
  createRefreshTokenRecord,
  findByTokenHash as findRefreshByHash,
  markRotated,
  revokeByDeviceBinding as revokeRefreshTokensByDevice,
  revokeFamily,
} from './actor-refresh-token-store.js';

const log = getLogger('actor-refresh-token-service');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Access token TTL: 30 days (reduced from 90). */
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Refresh token absolute expiry: 365 days from issuance. */
const REFRESH_ABSOLUTE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Refresh token inactivity expiry: 90 days since last successful refresh. */
const REFRESH_INACTIVITY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Proactive refresh hint: suggest refreshing when 80% of access token TTL has elapsed. */
const REFRESH_AFTER_FRACTION = 0.8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefreshErrorCode =
  | 'refresh_invalid'
  | 'refresh_expired'
  | 'refresh_reuse_detected'
  | 'device_binding_mismatch'
  | 'revoked';

export interface RefreshResult {
  guardianPrincipalId: string;
  actorToken: string;
  actorTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
}

export interface MintRefreshTokenResult {
  refreshToken: string;
  refreshTokenHash: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
}

// ---------------------------------------------------------------------------
// Mint a fresh refresh token (used by bootstrap/pairing)
// ---------------------------------------------------------------------------

/** Hash a raw refresh token for storage. Reuses the actor-token hash function. */
function hashRefreshToken(token: string): string {
  return hashToken(token);
}

/** Generate a cryptographically random refresh token. */
function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Mint a new refresh token and persist its hash.
 * Called during bootstrap, pairing, and rotation.
 */
export function mintRefreshToken(params: {
  assistantId: string;
  guardianPrincipalId: string;
  hashedDeviceId: string;
  platform: string;
  familyId?: string;
  /** When provided (during rotation), inherit the parent token's absolute expiry
   *  instead of computing a fresh one. This ensures refresh rotation resets the
   *  inactivity window but does NOT extend the absolute session lifetime. */
  absoluteExpiresAt?: number;
}): MintRefreshTokenResult {
  const now = Date.now();
  const familyId = params.familyId ?? randomBytes(16).toString('hex');
  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const absoluteExpiresAt = params.absoluteExpiresAt ?? now + REFRESH_ABSOLUTE_TTL_MS;
  const inactivityExpiresAt = now + REFRESH_INACTIVITY_TTL_MS;

  createRefreshTokenRecord({
    tokenHash: refreshTokenHash,
    familyId,
    assistantId: params.assistantId,
    guardianPrincipalId: params.guardianPrincipalId,
    hashedDeviceId: params.hashedDeviceId,
    platform: params.platform,
    issuedAt: now,
    absoluteExpiresAt,
    inactivityExpiresAt,
  });

  return {
    refreshToken,
    refreshTokenHash,
    refreshTokenExpiresAt: Math.min(absoluteExpiresAt, inactivityExpiresAt),
    refreshAfter: now + Math.floor(ACCESS_TOKEN_TTL_MS * REFRESH_AFTER_FRACTION),
  };
}

/**
 * Mint both an access token and a refresh token for initial credential issuance.
 * Used by bootstrap and pairing flows.
 */
export function mintCredentialPair(params: {
  assistantId: string;
  platform: string;
  deviceId: string;
  guardianPrincipalId: string;
  hashedDeviceId: string;
}): {
  actorToken: string;
  actorTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
  guardianPrincipalId: string;
} {
  // Revoke any existing credentials for this device
  revokeActorTokensByDevice(params.assistantId, params.guardianPrincipalId, params.hashedDeviceId);
  revokeRefreshTokensByDevice(params.assistantId, params.guardianPrincipalId, params.hashedDeviceId);

  // Mint new access token with 30-day TTL
  const { token: actorToken, tokenHash: actorTokenHash, claims } = mintActorToken({
    assistantId: params.assistantId,
    platform: params.platform,
    deviceId: params.deviceId,
    guardianPrincipalId: params.guardianPrincipalId,
    ttlMs: ACCESS_TOKEN_TTL_MS,
  });

  createActorTokenRecord({
    tokenHash: actorTokenHash,
    assistantId: params.assistantId,
    guardianPrincipalId: params.guardianPrincipalId,
    hashedDeviceId: params.hashedDeviceId,
    platform: params.platform,
    issuedAt: claims.iat,
    expiresAt: claims.exp,
  });

  // Mint new refresh token
  const refresh = mintRefreshToken({
    assistantId: params.assistantId,
    guardianPrincipalId: params.guardianPrincipalId,
    hashedDeviceId: params.hashedDeviceId,
    platform: params.platform,
  });

  return {
    actorToken,
    actorTokenExpiresAt: claims.exp!,
    refreshToken: refresh.refreshToken,
    refreshTokenExpiresAt: refresh.refreshTokenExpiresAt,
    refreshAfter: refresh.refreshAfter,
    guardianPrincipalId: params.guardianPrincipalId,
  };
}

// ---------------------------------------------------------------------------
// Rotate (the core refresh operation)
// ---------------------------------------------------------------------------

/**
 * Rotate credentials: validate refresh token, revoke old, mint new pair.
 *
 * Returns either a successful result or an error code.
 */
export function rotateCredentials(params: {
  refreshToken: string;
  platform: string;
  deviceId: string;
}): { ok: true; result: RefreshResult } | { ok: false; error: RefreshErrorCode } {
  const refreshTokenHash = hashRefreshToken(params.refreshToken);
  const hashedDeviceId = createHash('sha256').update(params.deviceId).digest('hex');

  // Look up the refresh token by hash (any status)
  const record = findRefreshByHash(refreshTokenHash);

  if (!record) {
    return { ok: false, error: 'refresh_invalid' };
  }

  // Check if this is a reuse of an already-rotated token (replay detection)
  if (record.status === 'rotated') {
    log.warn(
      { familyId: record.familyId, hashedDeviceId: record.hashedDeviceId },
      'Refresh token reuse detected — revoking entire family',
    );
    revokeFamily(record.familyId);
    revokeActorTokensByDevice(record.assistantId, record.guardianPrincipalId, record.hashedDeviceId);
    return { ok: false, error: 'refresh_reuse_detected' };
  }

  if (record.status === 'revoked') {
    return { ok: false, error: 'revoked' };
  }

  // At this point status === 'active'
  const now = Date.now();

  // Check absolute expiry
  if (now > record.absoluteExpiresAt) {
    return { ok: false, error: 'refresh_expired' };
  }

  // Check inactivity expiry
  if (now > record.inactivityExpiresAt) {
    return { ok: false, error: 'refresh_expired' };
  }

  // Verify device binding
  if (record.hashedDeviceId !== hashedDeviceId) {
    return { ok: false, error: 'device_binding_mismatch' };
  }

  if (record.platform !== params.platform) {
    return { ok: false, error: 'device_binding_mismatch' };
  }

  // Wrap the entire rotate-revoke-remint sequence in a transaction so that
  // partial failures (e.g., DB write error after revoking old tokens) roll back
  // atomically instead of stranding device credentials.
  const db = getDb();
  return db.transaction(() => {
    // Mark old refresh token as rotated (atomic CAS — fails if a concurrent request already consumed it)
    const didRotate = markRotated(refreshTokenHash);
    if (!didRotate) {
      return { ok: false as const, error: 'refresh_reuse_detected' as const };
    }

    // Revoke old access tokens for this device
    revokeActorTokensByDevice(record.assistantId, record.guardianPrincipalId, record.hashedDeviceId);

    // Mint new access token
    const { token: actorToken, tokenHash: actorTokenHash, claims } = mintActorToken({
      assistantId: record.assistantId,
      platform: params.platform,
      deviceId: params.deviceId,
      guardianPrincipalId: record.guardianPrincipalId,
      ttlMs: ACCESS_TOKEN_TTL_MS,
    });

    createActorTokenRecord({
      tokenHash: actorTokenHash,
      assistantId: record.assistantId,
      guardianPrincipalId: record.guardianPrincipalId,
      hashedDeviceId: record.hashedDeviceId,
      platform: params.platform,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
    });

    // Mint new refresh token in the same family, inheriting the parent's absolute
    // expiry so rotation resets inactivity but never extends the session lifetime.
    const refresh = mintRefreshToken({
      assistantId: record.assistantId,
      guardianPrincipalId: record.guardianPrincipalId,
      hashedDeviceId: record.hashedDeviceId,
      platform: params.platform,
      familyId: record.familyId,
      absoluteExpiresAt: record.absoluteExpiresAt,
    });

    log.info(
      { familyId: record.familyId, platform: params.platform },
      'Credential rotation completed',
    );

    return {
      ok: true as const,
      result: {
        guardianPrincipalId: record.guardianPrincipalId,
        actorToken,
        actorTokenExpiresAt: claims.exp!,
        refreshToken: refresh.refreshToken,
        refreshTokenExpiresAt: refresh.refreshTokenExpiresAt,
        refreshAfter: refresh.refreshAfter,
      },
    };
  });
}
