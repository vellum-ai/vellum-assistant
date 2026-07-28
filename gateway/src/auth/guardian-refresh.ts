/**
 * Gateway-native guardian token refresh — rotates credentials using the
 * gateway's own SQLite database for all token operations.
 */

import { randomBytes } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { getGatewayDb } from "../db/connection.js";
import { actorRefreshTokenRecords, actorTokenRecords } from "../db/schema.js";
import { getLogger } from "../logger.js";

import {
  getExternalAssistantId,
  hashToken,
  ACCESS_TOKEN_TTL_MS,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_AFTER_FRACTION,
  REFRESH_INACTIVITY_TTL_MS,
} from "./guardian-bootstrap.js";
import { guardianIntegrityState } from "./guardian-integrity.js";
import { CURRENT_POLICY_EPOCH } from "./policy.js";
import { mintToken } from "./token-service.js";

const log = getLogger("guardian-refresh");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefreshErrorCode =
  | "refresh_invalid"
  | "refresh_expired"
  | "refresh_reuse_detected"
  | "device_binding_mismatch"
  | "revoked"
  | "guardian_repair_required";

export interface RotateResult {
  guardianPrincipalId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
  browserRefreshCookiePath?: string;
}

// ---------------------------------------------------------------------------
// Query helpers (gateway DB — Drizzle)
// ---------------------------------------------------------------------------

function findRefreshByHash(tokenHash: string) {
  return getGatewayDb()
    .select()
    .from(actorRefreshTokenRecords)
    .where(eq(actorRefreshTokenRecords.tokenHash, tokenHash))
    .get();
}

type RefreshTokenRecord = NonNullable<ReturnType<typeof findRefreshByHash>>;

function markRotated(tokenHash: string): boolean {
  const now = Date.now();
  const rows = getGatewayDb()
    .update(actorRefreshTokenRecords)
    .set({ status: "rotated", lastUsedAt: now, updatedAt: now })
    .where(
      and(
        eq(actorRefreshTokenRecords.tokenHash, tokenHash),
        eq(actorRefreshTokenRecords.status, "active"),
      ),
    )
    .returning({ id: actorRefreshTokenRecords.id })
    .all();
  return rows.length > 0;
}

function revokeFamily(familyId: string): void {
  const now = Date.now();
  getGatewayDb()
    .update(actorRefreshTokenRecords)
    .set({ status: "revoked", updatedAt: now })
    .where(eq(actorRefreshTokenRecords.familyId, familyId))
    .run();
}

function revokeActiveActorTokensByDevice(
  guardianPrincipalId: string,
  hashedDeviceId: string,
): void {
  const now = Date.now();
  getGatewayDb()
    .update(actorTokenRecords)
    .set({ status: "revoked", updatedAt: now })
    .where(
      and(
        eq(actorTokenRecords.guardianPrincipalId, guardianPrincipalId),
        eq(actorTokenRecords.hashedDeviceId, hashedDeviceId),
        eq(actorTokenRecords.status, "active"),
      ),
    )
    .run();
}

function revokeAllActorTokensByDevice(
  guardianPrincipalId: string,
  hashedDeviceId: string,
): void {
  const now = Date.now();
  getGatewayDb()
    .update(actorTokenRecords)
    .set({ status: "revoked", updatedAt: now })
    .where(
      and(
        eq(actorTokenRecords.guardianPrincipalId, guardianPrincipalId),
        eq(actorTokenRecords.hashedDeviceId, hashedDeviceId),
        inArray(actorTokenRecords.status, ["active", "derived"]),
      ),
    )
    .run();
}

// ---------------------------------------------------------------------------
// Token minting (gateway DB)
// ---------------------------------------------------------------------------

function mintAccessToken(
  guardianPrincipalId: string,
  hashedDeviceId: string,
  platform: string,
): { token: string; expiresAt: number } {
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

  getGatewayDb()
    .insert(actorTokenRecords)
    .values({
      id: crypto.randomUUID(),
      tokenHash,
      guardianPrincipalId,
      hashedDeviceId,
      platform,
      status: "active",
      issuedAt: now,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { token, expiresAt };
}

function mintRefreshTokenInFamily(params: {
  guardianPrincipalId: string;
  hashedDeviceId: string;
  platform: string;
  familyId: string;
  absoluteExpiresAt: number;
  browserRefreshCookiePath?: string;
}): {
  refreshToken: string;
  refreshTokenExpiresAt: number;
  refreshAfter: number;
} {
  const now = Date.now();
  const refreshToken = randomBytes(32).toString("base64url");
  const refreshTokenHash = hashToken(refreshToken);
  const inactivityExpiresAt = now + REFRESH_INACTIVITY_TTL_MS;

  getGatewayDb()
    .insert(actorRefreshTokenRecords)
    .values({
      id: crypto.randomUUID(),
      tokenHash: refreshTokenHash,
      familyId: params.familyId,
      guardianPrincipalId: params.guardianPrincipalId,
      hashedDeviceId: params.hashedDeviceId,
      platform: params.platform,
      status: "active",
      issuedAt: now,
      absoluteExpiresAt: params.absoluteExpiresAt,
      inactivityExpiresAt,
      lastUsedAt: null,
      browserRefreshCookiePath: params.browserRefreshCookiePath,
      createdAt: now,
      updatedAt: now,
    })
    .run();

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

function rotateRefreshTokenRecord(
  refreshTokenHash: string,
  record: RefreshTokenRecord,
): { ok: true; result: RotateResult } | { ok: false; error: RefreshErrorCode } {
  if (record.status === "rotated") {
    log.warn(
      { familyId: record.familyId, hashedDeviceId: record.hashedDeviceId },
      "Refresh token reuse detected — revoking entire family",
    );
    revokeFamily(record.familyId);
    revokeAllActorTokensByDevice(
      record.guardianPrincipalId,
      record.hashedDeviceId,
    );
    return { ok: false, error: "refresh_reuse_detected" };
  }

  if (record.status === "revoked") {
    return { ok: false, error: "revoked" };
  }

  const now = Date.now();

  if (now > record.absoluteExpiresAt) {
    return { ok: false, error: "refresh_expired" };
  }

  if (now > record.inactivityExpiresAt) {
    return { ok: false, error: "refresh_expired" };
  }

  // Rotation skips the guardian-binding bootstrap, so check integrity
  // explicitly: a DB that lost its guardian rows would otherwise keep
  // rotating credentials that every trust verdict denies. Refused before any
  // side effects, so this refresh token still rotates after guardian repair.
  // Best-effort: a thrown check must never block a healthy rotation.
  try {
    if (guardianIntegrityState() === "missing_guardian") {
      log.error(
        { familyId: record.familyId, platform: record.platform },
        "Rotation refused: guardian rows missing over evidence of prior onboarding — repair via guardian init",
      );
      return { ok: false, error: "guardian_repair_required" };
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Guardian integrity check threw — proceeding with rotation",
    );
  }

  return getGatewayDb().transaction((tx) => {
    void tx; // transaction scoped via the underlying bun:sqlite connection

    const didRotate = markRotated(refreshTokenHash);
    if (!didRotate) {
      return { ok: false as const, error: "refresh_reuse_detected" as const };
    }

    revokeActiveActorTokensByDevice(
      record.guardianPrincipalId,
      record.hashedDeviceId,
    );

    const access = mintAccessToken(
      record.guardianPrincipalId,
      record.hashedDeviceId,
      record.platform,
    );

    const refresh = mintRefreshTokenInFamily({
      guardianPrincipalId: record.guardianPrincipalId,
      hashedDeviceId: record.hashedDeviceId,
      platform: record.platform,
      familyId: record.familyId,
      absoluteExpiresAt: record.absoluteExpiresAt,
      browserRefreshCookiePath: record.browserRefreshCookiePath ?? undefined,
    });

    log.info(
      { familyId: record.familyId, platform: record.platform },
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
        browserRefreshCookiePath: record.browserRefreshCookiePath ?? undefined,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Public: rotate credentials
// ---------------------------------------------------------------------------

/**
 * Rotate credentials: validate refresh token, revoke old, mint new pair.
 *
 * All token operations run against the gateway's SQLite database.
 *
 * The refresh token is bound to the device it was issued to: the caller must
 * supply the hashed device id, and it must match the record's stored binding.
 * This ensures a leaked refresh token cannot be redeemed from a different
 * device. The binding is checked before any side effects (rotation, family
 * revocation) so a request from a non-matching device cannot disturb the
 * legitimate token family.
 */
export function rotateCredentials(params: {
  refreshToken: string;
  hashedDeviceId: string;
}):
  | { ok: true; result: RotateResult }
  | { ok: false; error: RefreshErrorCode } {
  const refreshTokenHash = hashToken(params.refreshToken);
  const record = findRefreshByHash(refreshTokenHash);

  if (!record) {
    return { ok: false, error: "refresh_invalid" };
  }

  if (record.hashedDeviceId !== params.hashedDeviceId) {
    log.warn(
      { familyId: record.familyId },
      "Refresh rejected — device binding mismatch",
    );
    return { ok: false, error: "device_binding_mismatch" };
  }

  return rotateRefreshTokenRecord(refreshTokenHash, record);
}

/**
 * Browser refresh rotates using only the refresh token. The refresh token is the
 * bearer credential and the stored binding is recovered from its DB record.
 *
 * Only refresh-token records minted for the browser flow carry a browser cookie
 * path. Legacy CLI/macOS records still require the explicit device-bound
 * `rotateCredentials` path until that contract is migrated intentionally.
 */
export function rotateBrowserCredentialsByRefreshToken(params: {
  refreshToken: string;
}):
  | { ok: true; result: RotateResult }
  | { ok: false; error: RefreshErrorCode } {
  const refreshTokenHash = hashToken(params.refreshToken);
  const record = findRefreshByHash(refreshTokenHash);

  if (!record) {
    return { ok: false, error: "refresh_invalid" };
  }

  if (!record.browserRefreshCookiePath) {
    return { ok: false, error: "refresh_invalid" };
  }

  return rotateRefreshTokenRecord(refreshTokenHash, record);
}
