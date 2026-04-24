/**
 * Tests for the JWT credential service — mint round-trip and device
 * binding enforcement.
 *
 * Rotation/replay tests live in gateway (guardian-refresh.ts owns rotation).
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getSqlite, initializeDb, resetDb } from "../../../memory/db.js";
import { mintCredentialPair } from "../credential-service.js";
import { resetExternalAssistantIdCache } from "../external-assistant-id.js";
import {
  hashToken,
  initAuthSigningKey,
  verifyToken,
} from "../token-service.js";

const TEST_KEY = Buffer.from("test-signing-key-32-bytes-long!!");

initializeDb();

beforeEach(() => {
  process.env.VELLUM_ASSISTANT_NAME = "vellum-test-eel";
  initAuthSigningKey(TEST_KEY);
  resetExternalAssistantIdCache();
  resetDb();
  initializeDb();
  const db = getSqlite();
  db.run("DELETE FROM actor_token_records");
  db.run("DELETE FROM actor_refresh_token_records");
});

// ---------------------------------------------------------------------------
// Mint credential pair
// ---------------------------------------------------------------------------

describe("mintCredentialPair", () => {
  test("returns JWT access token and opaque refresh token", () => {
    const result = mintCredentialPair({
      platform: "macos",
      deviceId: "device-123",
      guardianPrincipalId: "principal-abc",
      hashedDeviceId: createHash("sha256").update("device-123").digest("hex"),
    });

    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.accessTokenExpiresAt).toBeGreaterThan(Date.now());
    expect(result.refreshTokenExpiresAt).toBeGreaterThan(Date.now());
    expect(result.refreshAfter).toBeGreaterThan(Date.now());
    expect(result.guardianPrincipalId).toBe("principal-abc");
  });

  test("access token is a valid 3-part JWT", () => {
    const result = mintCredentialPair({
      platform: "macos",
      deviceId: "device-jwt",
      guardianPrincipalId: "principal-jwt",
      hashedDeviceId: createHash("sha256").update("device-jwt").digest("hex"),
    });

    const parts = result.accessToken.split(".");
    expect(parts.length).toBe(3);
  });

  test("access token verifies against vellum-gateway audience", () => {
    const result = mintCredentialPair({
      platform: "macos",
      deviceId: "device-verify",
      guardianPrincipalId: "principal-verify",
      hashedDeviceId: createHash("sha256")
        .update("device-verify")
        .digest("hex"),
    });

    const verify = verifyToken(result.accessToken, "vellum-gateway");
    expect(verify.ok).toBe(true);
    if (verify.ok) {
      expect(verify.claims.aud).toBe("vellum-gateway");
      expect(verify.claims.scope_profile).toBe("actor_client_v1");
      // Sub should contain the external assistant ID from lockfile
      expect(verify.claims.sub).toBe("actor:vellum-test-eel:principal-verify");
    }
  });

  test("access token hash is stored in actor-token store", () => {
    const result = mintCredentialPair({
      platform: "macos",
      deviceId: "device-store",
      guardianPrincipalId: "principal-store",
      hashedDeviceId: createHash("sha256").update("device-store").digest("hex"),
    });

    const tokenHash = hashToken(result.accessToken);
    const db = getSqlite();
    const record = db
      .query(
        "SELECT * FROM actor_token_records WHERE token_hash = ? AND status = 'active'",
      )
      .get(tokenHash) as { platform: string; guardian_principal_id: string } | null;
    expect(record).not.toBeNull();
    expect(record!.platform).toBe("macos");
    expect(record!.guardian_principal_id).toBe("principal-store");
  });

  test("minting twice for same device revokes previous tokens", () => {
    const hashedDeviceId = createHash("sha256")
      .update("device-dup")
      .digest("hex");
    const params = {
      platform: "macos" as const,
      deviceId: "device-dup",
      guardianPrincipalId: "principal-dup",
      hashedDeviceId,
    };

    const first = mintCredentialPair(params);
    const second = mintCredentialPair(params);

    expect(first.accessToken).not.toBe(second.accessToken);
    expect(first.refreshToken).not.toBe(second.refreshToken);

    const db = getSqlite();
    const findActive = (token: string) =>
      db
        .query(
          "SELECT * FROM actor_token_records WHERE token_hash = ? AND status = 'active'",
        )
        .get(hashToken(token));

    // First token should be revoked
    expect(findActive(first.accessToken)).toBeNull();

    // Second should be active
    expect(findActive(second.accessToken)).not.toBeNull();
  });
});


