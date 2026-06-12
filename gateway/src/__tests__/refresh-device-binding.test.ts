/**
 * Tests for guardian credential rotation: a refresh token record owns the
 * stored device binding used for revocation/minting, while the bearer
 * actor principal must match before rotation side effects are allowed.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initSigningKey } from "../auth/token-service.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

const { initGatewayDb, resetGatewayDb, getGatewayDb } =
  await import("../db/connection.js");
const { actorRefreshTokenRecords } = await import("../db/schema.js");
const { hashToken } = await import("../auth/guardian-bootstrap.js");
const { rotateCredentials } = await import("../auth/guardian-refresh.js");

const PRINCIPAL = "guardian-001";
const DEVICE_A = "device-A";
const OTHER_PRINCIPAL = "guardian-002";
const FAMILY = "family-001";

let testRoot: string;

function insertRefreshRecord(
  rawToken: string,
  deviceId: string,
  status: "active" | "rotated" | "revoked" = "active",
) {
  const now = Date.now();
  getGatewayDb()
    .insert(actorRefreshTokenRecords)
    .values({
      id: `id-${rawToken}`,
      tokenHash: hashToken(rawToken),
      familyId: FAMILY,
      guardianPrincipalId: PRINCIPAL,
      hashedDeviceId: hashToken(deviceId),
      platform: "cli",
      status,
      issuedAt: now,
      absoluteExpiresAt: now + 365 * 86_400_000,
      inactivityExpiresAt: now + 90 * 86_400_000,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function recordStatus(rawToken: string): string | undefined {
  const rows = getGatewayDb().select().from(actorRefreshTokenRecords).all();
  return rows.find((r) => r.tokenHash === hashToken(rawToken))?.status;
}

beforeEach(async () => {
  testRoot = mkdtempSync(join(tmpdir(), "refresh-device-binding-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  await initGatewayDb();
});

afterEach(() => {
  resetGatewayDb();
  delete process.env.GATEWAY_SECURITY_DIR;
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("rotateCredentials principal authorization", () => {
  test("rotates when the bearer principal matches the record", () => {
    insertRefreshRecord("rt-match", DEVICE_A);
    const result = rotateCredentials({
      refreshToken: "rt-match",
      authorizedGuardianPrincipalId: PRINCIPAL,
    });
    expect(result.ok).toBe(true);
    // Old token is consumed (rotated), proving the happy path ran end-to-end.
    expect(recordStatus("rt-match")).toBe("rotated");
  });

  test("rejects with principal_mismatch from a different bearer principal", () => {
    insertRefreshRecord("rt-leaked", DEVICE_A);
    const result = rotateCredentials({
      refreshToken: "rt-leaked",
      authorizedGuardianPrincipalId: OTHER_PRINCIPAL,
    });
    expect(result).toEqual({ ok: false, error: "principal_mismatch" });
  });

  test("a wrong-principal request has no side effects on the token family", () => {
    insertRefreshRecord("rt-leaked", DEVICE_A);
    rotateCredentials({
      refreshToken: "rt-leaked",
      authorizedGuardianPrincipalId: OTHER_PRINCIPAL,
    });
    // The legitimate token must remain active and usable.
    expect(recordStatus("rt-leaked")).toBe("active");
    const legit = rotateCredentials({
      refreshToken: "rt-leaked",
      authorizedGuardianPrincipalId: PRINCIPAL,
    });
    expect(legit.ok).toBe(true);
  });

  test("principal binding is checked before reuse detection (no family revocation from wrong principal)", () => {
    // A previously-rotated token presented by the wrong principal must not
    // trigger the reuse-detection family revocation — that would let an
    // attacker with a leaked, already-spent token DoS the real user.
    insertRefreshRecord("rt-active", DEVICE_A, "active");
    insertRefreshRecord("rt-spent", DEVICE_A, "rotated");
    const result = rotateCredentials({
      refreshToken: "rt-spent",
      authorizedGuardianPrincipalId: OTHER_PRINCIPAL,
    });
    expect(result).toEqual({ ok: false, error: "principal_mismatch" });
    // The still-active sibling token in the same family is untouched.
    expect(recordStatus("rt-active")).toBe("active");
  });

  test("still returns refresh_invalid for an unknown token regardless of device", () => {
    const result = rotateCredentials({
      refreshToken: "rt-unknown",
      authorizedGuardianPrincipalId: PRINCIPAL,
    });
    expect(result).toEqual({ ok: false, error: "refresh_invalid" });
  });
});
