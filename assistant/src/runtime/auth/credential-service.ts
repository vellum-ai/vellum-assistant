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

import { randomBytes } from "node:crypto";

import {
  createRefreshTokenRecord,
  revokeByDeviceBinding as revokeRefreshTokensByDevice,
} from "../actor-refresh-token-store.js";
import {
  createActorTokenRecord,
  revokeByDeviceBinding as revokeActorTokensByDevice,
} from "../actor-token-store.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { getExternalAssistantId } from "./external-assistant-id.js";
import { CURRENT_POLICY_EPOCH } from "./policy.js";
import { hashToken, mintToken } from "./token-service.js";

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

export interface CredentialPairResult {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
  guardianPrincipalId: string;
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
  const externalAssistantId =
    getExternalAssistantId() ?? DAEMON_INTERNAL_ASSISTANT_ID;
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
