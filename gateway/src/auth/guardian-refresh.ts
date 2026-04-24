/**
 * Gateway-native guardian token refresh — rotates credentials by operating
 * directly on the assistant's SQLite database (shared workspace volume).
 *
 * Gateway-native credential rotation — operates directly on the assistant's
 * SQLite database (shared workspace volume).
 * but uses raw SQL against the shared assistant DB (same pattern as guardian-bootstrap.ts).
 */

import { createHash, randomBytes } from "node:crypto";

import { getLogger } from "../logger.js";

import {
  closeAssistantDb,
  getAssistantDb,
  getExternalAssistantId,
  hashToken,
  ACCESS_TOKEN_TTL_MS,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_AFTER_FRACTION,
  REFRESH_INACTIVITY_TTL_MS,
} from "./guardian-bootstrap.js";
import { CURRENT_POLICY_EPOCH } from "./policy.js";
import { mintToken } from "./token-service.js";

export { closeAssistantDb };

const log = getLogger("guardian-refresh");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefreshErrorCode =
  | "refresh_invalid"
  | "refresh_expired"
  | "refresh_reuse_detected"
  | "device_binding_mismatch"
  | "revoked";

export interface RotateResult {
  guardianPrincipalId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
}

// ---------------------------------------------------------------------------
// Refresh token record shape (from DB)
// ---------------------------------------------------------------------------

interface RefreshTokenRow {
  id: string;
  token_hash: string;
  family_id: string;
  guardian_principal_id: string;
  hashed_device_id: string;
  platform: string;
  status: string;
  issued_at: number;
  absolute_expires_at: number;
  inactivity_expires_at: number;
  last_used_at: number | null;
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

function findRefreshByHash(tokenHash: string): RefreshTokenRow | null {
  const db = getAssistantDb();
  return db
    .query<RefreshTokenRow, [string]>(
      `SELECT id, token_hash, family_id, guardian_principal_id,
              hashed_device_id, platform, status, issued_at,
              absolute_expires_at, inactivity_expires_at, last_used_at
       FROM actor_refresh_token_records
       WHERE token_hash = ?`,
    )
    .get(tokenHash);
}

/**
 * Atomically mark a refresh token as rotated (CAS: active → rotated).
 * Returns true if exactly one row was updated.
 */
function markRotated(tokenHash: string): boolean {
  const db = getAssistantDb();
  const now = Date.now();
  const result = db.run(
    `UPDATE actor_refresh_token_records
     SET status = 'rotated', last_used_at = ?, updated_at = ?
     WHERE token_hash = ? AND status = 'active'`,
    [now, now, tokenHash],
  );
  return result.changes > 0;
}

/** Revoke all tokens in a family (replay detection response). */
function revokeFamily(familyId: string): void {
  const db = getAssistantDb();
  const now = Date.now();
  db.run(
    `UPDATE actor_refresh_token_records
     SET status = 'revoked', updated_at = ?
     WHERE family_id = ?`,
    [now, familyId],
  );
}

/** Revoke all active access tokens for a device binding. */
function revokeActorTokensByDevice(
  guardianPrincipalId: string,
  hashedDeviceId: string,
): void {
  const db = getAssistantDb();
  const now = Date.now();
  db.run(
    `UPDATE actor_token_records
     SET status = 'revoked', updated_at = ?
     WHERE guardian_principal_id = ?
       AND hashed_device_id = ?
       AND status = 'active'`,
    [now, guardianPrincipalId, hashedDeviceId],
  );
}

// ---------------------------------------------------------------------------
// Token minting (matches guardian-bootstrap.ts)
// ---------------------------------------------------------------------------

function mintAccessToken(
  guardianPrincipalId: string,
  hashedDeviceId: string,
  platform: string,
): { token: string; expiresAt: number } {
  const db = getAssistantDb();
  const externalAssistantId = getExternalAssistantId();
  const sub = `actor:${externalAssistantId}:${guardianPrincipalId}`;

  const token = mintToken({
    aud: "vellum-gateway",
    sub,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
  });

  const now = Date.now();
  const expiresAt = now + ACCESS_TOKEN_TTL_MS;
  const tokenHash = hashToken(token);

  db.run(
    `INSERT INTO actor_token_records
       (id, token_hash, guardian_principal_id, hashed_device_id, platform,
        status, issued_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      tokenHash,
      guardianPrincipalId,
      hashedDeviceId,
      platform,
      now,
      expiresAt,
      now,
      now,
    ],
  );

  return { token, expiresAt };
}

function mintRefreshTokenInFamily(params: {
  guardianPrincipalId: string;
  hashedDeviceId: string;
  platform: string;
  familyId: string;
  absoluteExpiresAt: number;
}): {
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
} {
  const db = getAssistantDb();
  const now = Date.now();
  const refreshToken = randomBytes(32).toString("base64url");
  const refreshTokenHash = hashToken(refreshToken);
  const inactivityExpiresAt = now + REFRESH_INACTIVITY_TTL_MS;

  db.run(
    `INSERT INTO actor_refresh_token_records
       (id, token_hash, family_id, guardian_principal_id, hashed_device_id,
        platform, status, issued_at, absolute_expires_at, inactivity_expires_at,
        last_used_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?)`,
    [
      crypto.randomUUID(),
      refreshTokenHash,
      params.familyId,
      params.guardianPrincipalId,
      params.hashedDeviceId,
      params.platform,
      now,
      params.absoluteExpiresAt,
      inactivityExpiresAt,
      now,
      now,
    ],
  );

  return {
    refreshToken,
    refreshTokenExpiresAt: Math.min(
      params.absoluteExpiresAt,
      inactivityExpiresAt,
    ),
    refreshAfter:
      now + Math.floor(ACCESS_TOKEN_TTL_MS * REFRESH_AFTER_FRACTION),
  };
}

// ---------------------------------------------------------------------------
// Public: rotate credentials
// ---------------------------------------------------------------------------

/**
 * Rotate credentials: validate refresh token, revoke old, mint new pair.
 *
 * All operations run against the assistant's SQLite database in a transaction.
 */
export function rotateCredentials(params: {
  refreshToken: string;
  platform: string;
  deviceId: string;
}):
  | { ok: true; result: RotateResult }
  | { ok: false; error: RefreshErrorCode } {
  const refreshTokenHash = hashToken(params.refreshToken);
  const hashedDeviceId = createHash("sha256")
    .update(params.deviceId)
    .digest("hex");

  const record = findRefreshByHash(refreshTokenHash);

  if (!record) {
    return { ok: false, error: "refresh_invalid" };
  }

  // Replay detection: reusing an already-rotated token revokes the family
  if (record.status === "rotated") {
    log.warn(
      { familyId: record.family_id, hashedDeviceId: record.hashed_device_id },
      "Refresh token reuse detected — revoking entire family",
    );
    revokeFamily(record.family_id);
    revokeActorTokensByDevice(
      record.guardian_principal_id,
      record.hashed_device_id,
    );
    return { ok: false, error: "refresh_reuse_detected" };
  }

  if (record.status === "revoked") {
    return { ok: false, error: "revoked" };
  }

  // At this point status === 'active'
  const now = Date.now();

  if (now > record.absolute_expires_at) {
    return { ok: false, error: "refresh_expired" };
  }

  if (now > record.inactivity_expires_at) {
    return { ok: false, error: "refresh_expired" };
  }

  // Verify device binding
  if (record.hashed_device_id !== hashedDeviceId) {
    return { ok: false, error: "device_binding_mismatch" };
  }

  if (record.platform !== params.platform) {
    return { ok: false, error: "device_binding_mismatch" };
  }

  // Wrap the rotate-revoke-remint sequence in a transaction
  const db = getAssistantDb();

  const txn = db.transaction(() => {
    // Mark old refresh token as rotated (atomic CAS)
    const didRotate = markRotated(refreshTokenHash);
    if (!didRotate) {
      return { ok: false as const, error: "refresh_reuse_detected" as const };
    }

    // Revoke old access tokens for this device
    revokeActorTokensByDevice(
      record.guardian_principal_id,
      record.hashed_device_id,
    );

    // Mint new JWT access token
    const access = mintAccessToken(
      record.guardian_principal_id,
      record.hashed_device_id,
      params.platform,
    );

    // Mint new refresh token in the same family, inheriting the parent's
    // absolute expiry so rotation resets inactivity but never extends
    // the session lifetime.
    const refresh = mintRefreshTokenInFamily({
      guardianPrincipalId: record.guardian_principal_id,
      hashedDeviceId: record.hashed_device_id,
      platform: params.platform,
      familyId: record.family_id,
      absoluteExpiresAt: record.absolute_expires_at,
    });

    log.info(
      { familyId: record.family_id, platform: params.platform },
      "Credential rotation completed",
    );

    return {
      ok: true as const,
      result: {
        guardianPrincipalId: record.guardian_principal_id,
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: refresh.refreshToken,
        refreshTokenExpiresAt: refresh.refreshTokenExpiresAt,
        refreshAfter: refresh.refreshAfter,
      },
    };
  });

  return txn();
}
