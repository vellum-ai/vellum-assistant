/**
 * Tests for device binding on guardian credential rotation: a refresh token
 * is bound to the device it was issued to, so a leaked refresh token cannot be
 * redeemed from a different device. The binding is verified before any side
 * effects so a wrong-device request cannot disturb the legitimate token family.
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
const DEVICE_B = "device-B";
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

describe("rotateCredentials device binding", () => {
  test("rotates when the device id matches the record's binding", () => {
    insertRefreshRecord("rt-match", DEVICE_A);
    const result = rotateCredentials({
      refreshToken: "rt-match",
      hashedDeviceId: hashToken(DEVICE_A),
    });
    expect(result.ok).toBe(true);
    // Old token is consumed (rotated), proving the happy path ran end-to-end.
    expect(recordStatus("rt-match")).toBe("rotated");
  });

  test("rejects with device_binding_mismatch from a different device", () => {
    insertRefreshRecord("rt-leaked", DEVICE_A);
    const result = rotateCredentials({
      refreshToken: "rt-leaked",
      hashedDeviceId: hashToken(DEVICE_B),
    });
    expect(result).toEqual({ ok: false, error: "device_binding_mismatch" });
  });

  test("a wrong-device request has no side effects on the token family", () => {
    insertRefreshRecord("rt-leaked", DEVICE_A);
    rotateCredentials({
      refreshToken: "rt-leaked",
      hashedDeviceId: hashToken(DEVICE_B),
    });
    // The legitimate token must remain active and usable.
    expect(recordStatus("rt-leaked")).toBe("active");
    const legit = rotateCredentials({
      refreshToken: "rt-leaked",
      hashedDeviceId: hashToken(DEVICE_A),
    });
    expect(legit.ok).toBe(true);
  });

  test("device binding is checked before reuse detection (no family revocation from wrong device)", () => {
    // A previously-rotated token presented from the wrong device must not
    // trigger the reuse-detection family revocation — that would let an
    // attacker with a leaked, already-spent token DoS the real user.
    insertRefreshRecord("rt-active", DEVICE_A, "active");
    insertRefreshRecord("rt-spent", DEVICE_A, "rotated");
    const result = rotateCredentials({
      refreshToken: "rt-spent",
      hashedDeviceId: hashToken(DEVICE_B),
    });
    expect(result).toEqual({ ok: false, error: "device_binding_mismatch" });
    // The still-active sibling token in the same family is untouched.
    expect(recordStatus("rt-active")).toBe("active");
  });

  test("still returns refresh_invalid for an unknown token regardless of device", () => {
    const result = rotateCredentials({
      refreshToken: "rt-unknown",
      hashedDeviceId: hashToken(DEVICE_A),
    });
    expect(result).toEqual({ ok: false, error: "refresh_invalid" });
  });
});
