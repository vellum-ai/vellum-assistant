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
const { actorRefreshTokenRecords, actorTokenRecords, contacts } =
  await import("../db/schema.js");
const { hashToken } = await import("../auth/guardian-bootstrap.js");
const { rotateCredentials } = await import("../auth/guardian-refresh.js");
const { handleGuardianRefresh } =
  await import("../http/routes/guardian-refresh.js");
const { bustGuardianIntegrityCache } =
  await import("../auth/guardian-integrity.js");
const {
  resetGuardianIntegrityReporterForTesting,
  setGuardianIntegrityReporterOverridesForTesting,
} = await import("../guardian-integrity-reporter.js");

const PRINCIPAL = "guardian-001";
const DEVICE_A = "device-A";
const DEVICE_B = "device-B";
const FAMILY = "family-001";

let testRoot: string;

function insertRefreshRecord(
  rawToken: string,
  deviceId: string,
  status: "active" | "rotated" | "revoked" = "active",
  identity: {
    pairingUserAgent: string | null;
    clientReportedName: string | null;
  } | null = null,
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
      pairingUserAgent: identity?.pairingUserAgent ?? null,
      clientReportedName: identity?.clientReportedName ?? null,
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

function insertActorTokenRecord(
  rawToken: string,
  deviceId: string,
  lastUsedAt: number | null,
  status: "active" | "revoked" = "active",
) {
  const now = Date.now();
  getGatewayDb()
    .insert(actorTokenRecords)
    .values({
      id: `actor-${rawToken}`,
      tokenHash: hashToken(rawToken),
      guardianPrincipalId: PRINCIPAL,
      hashedDeviceId: hashToken(deviceId),
      platform: "cli",
      status,
      issuedAt: now,
      expiresAt: now + 86_400_000,
      lastUsedAt,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function recordStatus(rawToken: string): string | undefined {
  const rows = getGatewayDb().select().from(actorRefreshTokenRecords).all();
  return rows.find((r) => r.tokenHash === hashToken(rawToken))?.status;
}

function insertGuardianContact() {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: "contact-guardian",
      displayName: "guardian",
      role: "guardian",
      principalId: PRINCIPAL,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

beforeEach(async () => {
  testRoot = mkdtempSync(join(tmpdir(), "refresh-device-binding-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  await initGatewayDb();
  // Refresh-token rows are guardian-integrity evidence; seed a guardian so
  // rotation is integrity-clean, keep the module cache cold across tests, and
  // silence the fail-loud reporter for the missing-guardian cases.
  insertGuardianContact();
  bustGuardianIntegrityCache();
  resetGuardianIntegrityReporterForTesting();
  setGuardianIntegrityReporterOverridesForTesting({
    fetchImpl: async () => new Response("{}"),
    mintToken: () => "svc-token",
    baseUrl: "http://127.0.0.1:7821",
    log: { error: () => {}, warn: () => {} },
  });
});

afterEach(() => {
  resetGatewayDb();
  resetGuardianIntegrityReporterForTesting();
  bustGuardianIntegrityCache();
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

describe("rotateCredentials guardian integrity gate", () => {
  function clearGuardianRows() {
    getGatewayDb().delete(contacts).run();
    bustGuardianIntegrityCache();
  }

  test("refuses rotation without side effects when guardian rows are missing, then recovers after repair", () => {
    insertRefreshRecord("rt-locked", DEVICE_A);
    clearGuardianRows();

    const refused = rotateCredentials({
      refreshToken: "rt-locked",
      hashedDeviceId: hashToken(DEVICE_A),
    });
    expect(refused).toEqual({ ok: false, error: "guardian_repair_required" });
    // Refused before any side effects: the same refresh token survives.
    expect(recordStatus("rt-locked")).toBe("active");

    // Guardian re-seeded (repair) + cache busted → the held token rotates.
    insertGuardianContact();
    bustGuardianIntegrityCache();
    const recovered = rotateCredentials({
      refreshToken: "rt-locked",
      hashedDeviceId: hashToken(DEVICE_A),
    });
    expect(recovered.ok).toBe(true);
    expect(recordStatus("rt-locked")).toBe("rotated");
  });

  test("a thrown integrity check does not block a healthy rotation", () => {
    insertRefreshRecord("rt-degraded", DEVICE_A);
    // Make guardianIntegrityState() throw while the rotation tables keep
    // working.
    (
      getGatewayDb() as unknown as { $client: import("bun:sqlite").Database }
    ).$client.exec("DROP TABLE contacts");
    bustGuardianIntegrityCache();

    const result = rotateCredentials({
      refreshToken: "rt-degraded",
      hashedDeviceId: hashToken(DEVICE_A),
    });
    expect(result.ok).toBe(true);
  });

  test("the refresh route maps the refusal to the repairable 401 body", async () => {
    insertRefreshRecord("rt-route", DEVICE_A);
    clearGuardianRows();

    const res = await handleGuardianRefresh(
      new Request("http://127.0.0.1:7830/v1/guardian/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: "rt-route", deviceId: DEVICE_A }),
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "guardian_repair_required" });
  });
});

describe("rotateCredentials activity history", () => {
  test("keeps the rotated-out actor row's lastUsedAt stamp", () => {
    // The device list reads the max stamp across statuses, so rotation must
    // leave the stamp on the row it revokes. Clearing it here would reset a
    // device's activity history on every credential refresh.
    insertRefreshRecord("rt-stamped", DEVICE_A);
    insertActorTokenRecord("at-stamped", DEVICE_A, 1_700_000_000_000);

    const result = rotateCredentials({
      refreshToken: "rt-stamped",
      hashedDeviceId: hashToken(DEVICE_A),
    });
    expect(result.ok).toBe(true);

    const rows = getGatewayDb().select().from(actorTokenRecords).all();
    const rotatedOut = rows.find(
      (r) => r.tokenHash === hashToken("at-stamped"),
    );
    expect(rotatedOut?.status).toBe("revoked");
    expect(rotatedOut?.lastUsedAt).toBe(1_700_000_000_000);
  });

  test("clears the stamp when a replayed refresh token revokes the family", () => {
    // Reuse detection is a security revoke: the replayed family's activity
    // history must not carry forward onto whatever pairs next.
    insertRefreshRecord("rt-replayed", DEVICE_A, "rotated");
    insertActorTokenRecord("at-replayed", DEVICE_A, 1_700_000_000_000);

    const result = rotateCredentials({
      refreshToken: "rt-replayed",
      hashedDeviceId: hashToken(DEVICE_A),
    });
    expect(result).toEqual({ ok: false, error: "refresh_reuse_detected" });

    const rows = getGatewayDb().select().from(actorTokenRecords).all();
    const revoked = rows.find((r) => r.tokenHash === hashToken("at-replayed"));
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.lastUsedAt).toBeNull();
  });

  test("clears the stamp on rows an earlier rotation already revoked", () => {
    // A device that rotated before the replay carries a stamped revoked row,
    // and the device list reads the max stamp across statuses, so the security
    // revoke has to reach that row too.
    insertRefreshRecord("rt-replayed-old", DEVICE_A, "rotated");
    insertActorTokenRecord(
      "at-rotated-out",
      DEVICE_A,
      1_700_000_000_000,
      "revoked",
    );
    insertActorTokenRecord("at-current", DEVICE_A, 1_800_000_000_000);

    const result = rotateCredentials({
      refreshToken: "rt-replayed-old",
      hashedDeviceId: hashToken(DEVICE_A),
    });
    expect(result).toEqual({ ok: false, error: "refresh_reuse_detected" });

    const rows = getGatewayDb().select().from(actorTokenRecords).all();
    expect(rows.map((r) => r.lastUsedAt)).toEqual([null, null]);
  });
});

describe("rotateCredentials device identity carry-forward", () => {
  // pairingUserAgent and clientReportedName survive rotation the same way
  // platform does.
  const USER_AGENT = "Vellum-CLI/1.2.3 (Macintosh; Darwin)";
  const REPORTED_NAME = "Alice's MacBook Pro";

  function findActorTokenRow(rawToken: string) {
    return getGatewayDb()
      .select()
      .from(actorTokenRecords)
      .all()
      .find((r) => r.tokenHash === hashToken(rawToken));
  }

  function findRefreshTokenRow(rawToken: string) {
    return getGatewayDb()
      .select()
      .from(actorRefreshTokenRecords)
      .all()
      .find((r) => r.tokenHash === hashToken(rawToken));
  }

  test("carries pairingUserAgent and clientReportedName onto the new actor-token and refresh-token rows after one rotation", () => {
    insertRefreshRecord("rt-identity", DEVICE_A, "active", {
      pairingUserAgent: USER_AGENT,
      clientReportedName: REPORTED_NAME,
    });

    const result = rotateCredentials({
      refreshToken: "rt-identity",
      hashedDeviceId: hashToken(DEVICE_A),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newActorRow = findActorTokenRow(result.result.accessToken);
    expect(newActorRow?.pairingUserAgent).toBe(USER_AGENT);
    expect(newActorRow?.clientReportedName).toBe(REPORTED_NAME);

    const newRefreshRow = findRefreshTokenRow(result.result.refreshToken);
    expect(newRefreshRow?.pairingUserAgent).toBe(USER_AGENT);
    expect(newRefreshRow?.clientReportedName).toBe(REPORTED_NAME);
  });

  test("keeps the identity intact across two consecutive rotations", () => {
    insertRefreshRecord("rt-identity-hop1", DEVICE_A, "active", {
      pairingUserAgent: USER_AGENT,
      clientReportedName: REPORTED_NAME,
    });

    const first = rotateCredentials({
      refreshToken: "rt-identity-hop1",
      hashedDeviceId: hashToken(DEVICE_A),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const second = rotateCredentials({
      refreshToken: first.result.refreshToken,
      hashedDeviceId: hashToken(DEVICE_A),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }

    const newActorRow = findActorTokenRow(second.result.accessToken);
    expect(newActorRow?.pairingUserAgent).toBe(USER_AGENT);
    expect(newActorRow?.clientReportedName).toBe(REPORTED_NAME);

    const newRefreshRow = findRefreshTokenRow(second.result.refreshToken);
    expect(newRefreshRow?.pairingUserAgent).toBe(USER_AGENT);
    expect(newRefreshRow?.clientReportedName).toBe(REPORTED_NAME);
  });

  test("a null stored identity rotates cleanly and stays null", () => {
    insertRefreshRecord("rt-no-identity", DEVICE_A, "active", {
      pairingUserAgent: null,
      clientReportedName: null,
    });

    const result = rotateCredentials({
      refreshToken: "rt-no-identity",
      hashedDeviceId: hashToken(DEVICE_A),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const newActorRow = findActorTokenRow(result.result.accessToken);
    expect(newActorRow?.pairingUserAgent).toBeNull();
    expect(newActorRow?.clientReportedName).toBeNull();

    const newRefreshRow = findRefreshTokenRow(result.result.refreshToken);
    expect(newRefreshRow?.pairingUserAgent).toBeNull();
    expect(newRefreshRow?.clientReportedName).toBeNull();
  });
});
