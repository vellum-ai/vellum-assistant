/**
 * Tests for the JWT credential service — mint round-trip, rotation,
 * replay detection, and device binding enforcement.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "credential-service-test-")),
);

mock.module("../../../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getDbPath: () => join(testDir, "test.db"),
  normalizeAssistantId: (id: string) => (id === "self" ? "self" : id),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getSqlite, initializeDb, resetDb } from "../../../memory/db.js";
import { findActiveByTokenHash } from "../../actor-token-store.js";
import {
  mintCredentialPair,
  rotateCredentials,
} from "../credential-service.js";
import { resetExternalAssistantIdCache } from "../external-assistant-id.js";
import {
  hashToken,
  initAuthSigningKey,
  verifyToken,
} from "../token-service.js";

const TEST_KEY = Buffer.from("test-signing-key-32-bytes-long!!");

initializeDb();

beforeEach(() => {
  initAuthSigningKey(TEST_KEY);
  resetExternalAssistantIdCache();
  resetDb();
  initializeDb();
  const db = getSqlite();
  db.run("DELETE FROM actor_token_records");
  db.run("DELETE FROM actor_refresh_token_records");
});

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
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
    const record = findActiveByTokenHash(tokenHash);
    expect(record).not.toBeNull();
    expect(record!.platform).toBe("macos");
    expect(record!.guardianPrincipalId).toBe("principal-store");
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

    // First token should be revoked
    const firstTokenHash = hashToken(first.accessToken);
    const firstRecord = findActiveByTokenHash(firstTokenHash);
    expect(firstRecord).toBeNull();

    // Second should be active
    const secondTokenHash = hashToken(second.accessToken);
    const secondRecord = findActiveByTokenHash(secondTokenHash);
    expect(secondRecord).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rotate credentials
// ---------------------------------------------------------------------------

describe("rotateCredentials", () => {
  test("successful rotation returns new JWT access token", () => {
    const hashedDeviceId = createHash("sha256")
      .update("device-rot")
      .digest("hex");
    const initial = mintCredentialPair({
      platform: "ios",
      deviceId: "device-rot",
      guardianPrincipalId: "principal-rot",
      hashedDeviceId,
    });

    const result = rotateCredentials({
      refreshToken: initial.refreshToken,
      platform: "ios",
      deviceId: "device-rot",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.accessToken).toBeTruthy();
      expect(result.result.accessToken).not.toBe(initial.accessToken);
      expect(result.result.refreshToken).not.toBe(initial.refreshToken);

      // New access token is a valid JWT
      const verify = verifyToken(result.result.accessToken, "vellum-gateway");
      expect(verify.ok).toBe(true);
    }
  });

  test("replay detection: reusing rotated refresh token revokes family", () => {
    const hashedDeviceId = createHash("sha256")
      .update("device-replay")
      .digest("hex");
    const initial = mintCredentialPair({
      platform: "ios",
      deviceId: "device-replay",
      guardianPrincipalId: "principal-replay",
      hashedDeviceId,
    });

    // First rotation succeeds
    const first = rotateCredentials({
      refreshToken: initial.refreshToken,
      platform: "ios",
      deviceId: "device-replay",
    });
    expect(first.ok).toBe(true);

    // Reusing the initial (now rotated) refresh token triggers replay detection
    const replay = rotateCredentials({
      refreshToken: initial.refreshToken,
      platform: "ios",
      deviceId: "device-replay",
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.error).toBe("refresh_reuse_detected");
    }
  });

  test("invalid refresh token returns refresh_invalid", () => {
    const result = rotateCredentials({
      refreshToken: "not-a-real-token",
      platform: "ios",
      deviceId: "device-bad",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("refresh_invalid");
    }
  });

  test("device binding mismatch returns device_binding_mismatch", () => {
    const hashedDeviceId = createHash("sha256")
      .update("device-bind")
      .digest("hex");
    const initial = mintCredentialPair({
      platform: "ios",
      deviceId: "device-bind",
      guardianPrincipalId: "principal-bind",
      hashedDeviceId,
    });

    // Try to rotate with a different device ID
    const result = rotateCredentials({
      refreshToken: initial.refreshToken,
      platform: "ios",
      deviceId: "different-device",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("device_binding_mismatch");
    }
  });

  test("platform mismatch returns device_binding_mismatch", () => {
    const hashedDeviceId = createHash("sha256")
      .update("device-plat")
      .digest("hex");
    const initial = mintCredentialPair({
      platform: "ios",
      deviceId: "device-plat",
      guardianPrincipalId: "principal-plat",
      hashedDeviceId,
    });

    const result = rotateCredentials({
      refreshToken: initial.refreshToken,
      platform: "macos",
      deviceId: "device-plat",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("device_binding_mismatch");
    }
  });
});
