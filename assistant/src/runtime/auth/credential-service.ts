/**
 * JWT credential minting and rotation service.
 *
 * Replaces the legacy actor-token-service + actor-refresh-token-service with
 * JWT-based access tokens (aud=vellum-gateway) and opaque refresh tokens.
 *
 * Access tokens are standard JWTs with:
 *   - aud: 'vellum-gateway'
 *   - sub: 'actor:<externalAssistantId>:<guardianPrincipalId>'
 *   - scope_profile: 'actor_client_v1'
 *   - policy_epoch: CURRENT_POLICY_EPOCH
 *   - 30-day TTL
 *
 * Refresh tokens remain opaque random bytes with hash-only storage,
 * family tracking, and replay detection — reusing the existing
 * actor-refresh-token-store infrastructure.
 */

import { createHash, randomBytes } from "node:crypto";

import { getDb } from "../../memory/db.js";
import { getLogger } from "../../util/logger.js";
import {
  createRefreshTokenRecord,
  findByTokenHash as findRefreshByHash,
  markRotated,
  revokeByDeviceBinding as revokeRefreshTokensByDevice,
  revokeFamily,
} from "../actor-refresh-token-store.js";
import {
  createActorTokenRecord,
  revokeByDeviceBinding as revokeActorTokensByDevice,
} from "../actor-token-store.js";
import { getExternalAssistantId } from "./external-assistant-id.js";
import { CURRENT_POLICY_EPOCH } from "./policy.js";
import { hashToken, mintToken } from "./token-service.js";

const log = getLogger("credential-service");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Access token TTL: 30 days in seconds. */
const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Access token TTL in ms (for refresh-after hints). */
const ACCESS_TOKEN_TTL_MS = ACCESS_TOKEN_TTL_SECONDS * 1000;

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
  | "refresh_invalid"
  | "refresh_expired"
  | "refresh_reuse_detected"
  | "device_binding_mismatch"
  | "revoked";

export interface CredentialPairResult {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
  guardianPrincipalId: string;
}

export interface RotateResult {
  guardianPrincipalId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
}

// ---------------------------------------------------------------------------
// Internal: refresh token helpers
// ---------------------------------------------------------------------------

function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashRefreshToken(token: string): string {
  return hashToken(token);
}

// ---------------------------------------------------------------------------
// Internal: mint a JWT access token
// ---------------------------------------------------------------------------

function mintAccessToken(guardianPrincipalId: string): {
  token: string;
  tokenHash: string;
  expiresAt: number;
  issuedAt: number;
} {
  const externalAssistantId = getExternalAssistantId() ?? "self";
  const sub = `actor:${externalAssistantId}:${guardianPrincipalId}`;

  const token = mintToken({
    aud: "vellum-gateway",
    sub,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
  });

  const now = Date.now();
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: now + ACCESS_TOKEN_TTL_MS,
    issuedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Internal: mint a fresh refresh token and persist its hash
// ---------------------------------------------------------------------------

function mintRefreshTokenInternal(params: {
  guardianPrincipalId: string;
  hashedDeviceId: string;
  platform: string;
  familyId?: string;
  absoluteExpiresAt?: number;
}): {
  refreshToken: string;
  refreshTokenHash: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
} {
  const now = Date.now();
  const familyId = params.familyId ?? randomBytes(16).toString("hex");
  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const absoluteExpiresAt =
    params.absoluteExpiresAt ?? now + REFRESH_ABSOLUTE_TTL_MS;
  const inactivityExpiresAt = now + REFRESH_INACTIVITY_TTL_MS;

  createRefreshTokenRecord({
    tokenHash: refreshTokenHash,
    familyId,
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
    refreshAfter:
      now + Math.floor(ACCESS_TOKEN_TTL_MS * REFRESH_AFTER_FRACTION),
  };
}

// ---------------------------------------------------------------------------
// Public: mint credential pair (access token + refresh token)
// ---------------------------------------------------------------------------

/**
 * Mint a JWT access token and an opaque refresh token for initial issuance.
 * Used by bootstrap and pairing flows.
 *
 * Revokes any existing credentials for the device before minting.
 */
export function mintCredentialPair(params: {
  platform: string;
  deviceId: string;
  guardianPrincipalId: string;
  hashedDeviceId: string;
}): CredentialPairResult {
  // Revoke any existing credentials for this device
  revokeActorTokensByDevice(params.guardianPrincipalId, params.hashedDeviceId);
  revokeRefreshTokensByDevice(
    params.guardianPrincipalId,
    params.hashedDeviceId,
  );

  // Mint new JWT access token
  const access = mintAccessToken(params.guardianPrincipalId);

  createActorTokenRecord({
    tokenHash: access.tokenHash,
    guardianPrincipalId: params.guardianPrincipalId,
    hashedDeviceId: params.hashedDeviceId,
    platform: params.platform,
    issuedAt: access.issuedAt,
    expiresAt: access.expiresAt,
  });

  // Mint new refresh token
  const refresh = mintRefreshTokenInternal({
    guardianPrincipalId: params.guardianPrincipalId,
    hashedDeviceId: params.hashedDeviceId,
    platform: params.platform,
  });

  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh.refreshToken,
    refreshTokenExpiresAt: refresh.refreshTokenExpiresAt,
    refreshAfter: refresh.refreshAfter,
    guardianPrincipalId: params.guardianPrincipalId,
  };
}

// ---------------------------------------------------------------------------
// Public: rotate credentials
// ---------------------------------------------------------------------------

/**
 * Rotate credentials: validate refresh token, revoke old, mint new pair.
 *
 * Returns either a successful result or an error code. The rotation is
 * wrapped in a SQLite transaction for atomicity.
 */
export function rotateCredentials(params: {
  refreshToken: string;
  platform: string;
  deviceId: string;
}):
  | { ok: true; result: RotateResult }
  | { ok: false; error: RefreshErrorCode } {
  const refreshTokenHash = hashRefreshToken(params.refreshToken);
  const hashedDeviceId = createHash("sha256")
    .update(params.deviceId)
    .digest("hex");

  // Look up the refresh token by hash (any status)
  const record = findRefreshByHash(refreshTokenHash);

  if (!record) {
    return { ok: false, error: "refresh_invalid" };
  }

  // Check if this is a reuse of an already-rotated token (replay detection)
  if (record.status === "rotated") {
    log.warn(
      { familyId: record.familyId, hashedDeviceId: record.hashedDeviceId },
      "Refresh token reuse detected — revoking entire family",
    );
    revokeFamily(record.familyId);
    revokeActorTokensByDevice(
      record.guardianPrincipalId,
      record.hashedDeviceId,
    );
    return { ok: false, error: "refresh_reuse_detected" };
  }

  if (record.status === "revoked") {
    return { ok: false, error: "revoked" };
  }

  // At this point status === 'active'
  const now = Date.now();

  // Check absolute expiry
  if (now > record.absoluteExpiresAt) {
    return { ok: false, error: "refresh_expired" };
  }

  // Check inactivity expiry
  if (now > record.inactivityExpiresAt) {
    return { ok: false, error: "refresh_expired" };
  }

  // Verify device binding
  if (record.hashedDeviceId !== hashedDeviceId) {
    return { ok: false, error: "device_binding_mismatch" };
  }

  if (record.platform !== params.platform) {
    return { ok: false, error: "device_binding_mismatch" };
  }

  // Wrap the entire rotate-revoke-remint sequence in a transaction
  const db = getDb();
  return db.transaction(() => {
    // Mark old refresh token as rotated (atomic CAS)
    const didRotate = markRotated(refreshTokenHash);
    if (!didRotate) {
      return { ok: false as const, error: "refresh_reuse_detected" as const };
    }

    // Revoke old access tokens for this device
    revokeActorTokensByDevice(
      record.guardianPrincipalId,
      record.hashedDeviceId,
    );

    // Mint new JWT access token
    const access = mintAccessToken(record.guardianPrincipalId);

    createActorTokenRecord({
      tokenHash: access.tokenHash,
      guardianPrincipalId: record.guardianPrincipalId,
      hashedDeviceId: record.hashedDeviceId,
      platform: params.platform,
      issuedAt: access.issuedAt,
      expiresAt: access.expiresAt,
    });

    // Mint new refresh token in the same family, inheriting the parent's
    // absolute expiry so rotation resets inactivity but never extends
    // the session lifetime.
    const refresh = mintRefreshTokenInternal({
      guardianPrincipalId: record.guardianPrincipalId,
      hashedDeviceId: record.hashedDeviceId,
      platform: params.platform,
      familyId: record.familyId,
      absoluteExpiresAt: record.absoluteExpiresAt,
    });

    log.info(
      { familyId: record.familyId, platform: params.platform },
      "Credential rotation completed",
    );

    return {
      ok: true as const,
      result: {
        guardianPrincipalId: record.guardianPrincipalId,
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: refresh.refreshToken,
        refreshTokenExpiresAt: refresh.refreshTokenExpiresAt,
        refreshAfter: refresh.refreshAfter,
      },
    };
  });
}
