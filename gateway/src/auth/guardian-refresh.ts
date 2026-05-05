/**
 * Gateway-native guardian token refresh — rotates credentials using the
 * gateway's own SQLite database for all token operations.
 */

import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getGatewayDb } from "../db/connection.js";
import {
  actorRefreshTokenRecords,
  actorTokenRecords,
} from "../db/schema.js";
import { getLogger } from "../logger.js";

import {
  getExternalAssistantId,
  hashToken,
  ACCESS_TOKEN_TTL_MS,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_AFTER_FRACTION,
  REFRESH_INACTIVITY_TTL_MS,
} from "./guardian-bootstrap.js";
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
// Query helpers (gateway DB — Drizzle)
// ---------------------------------------------------------------------------

function findRefreshByHash(tokenHash: string) {
  return getGatewayDb()
    .select()
    .from(actorRefreshTokenRecords)
    .where(eq(actorRefreshTokenRecords.tokenHash, tokenHash))
    .get();
}

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

function revokeActorTokensByDevice(
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

// ---------------------------------------------------------------------------
// Public: rotate credentials
// ---------------------------------------------------------------------------

/**
 * Rotate credentials: validate refresh token, revoke old, mint new pair.
 *
 * All token operations run against the gateway's SQLite database.
 */
export function rotateCredentials(params: {
  refreshToken: string;
}):
  | { ok: true; result: RotateResult }
  | { ok: false; error: RefreshErrorCode } {
  const refreshTokenHash = hashToken(params.refreshToken);

  const record = findRefreshByHash(refreshTokenHash);

  if (!record) {
    return { ok: false, error: "refresh_invalid" };
  }

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

  const now = Date.now();

  if (now > record.absoluteExpiresAt) {
    return { ok: false, error: "refresh_expired" };
  }

  if (now > record.inactivityExpiresAt) {
    return { ok: false, error: "refresh_expired" };
  }

  return getGatewayDb().transaction((tx) => {
    void tx; // transaction scoped via the underlying bun:sqlite connection

    const didRotate = markRotated(refreshTokenHash);
    if (!didRotate) {
      return { ok: false as const, error: "refresh_reuse_detected" as const };
    }

    revokeActorTokensByDevice(
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
      },
    };
  });
}
