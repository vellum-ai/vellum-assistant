/**
 * Tests for the loopback-guarded device endpoints: GET /v1/devices (list) and
 * POST /v1/devices/revoke (revoke by hashedDeviceId), scoped to the local
 * guardian principal.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import { initSigningKey } from "../auth/token-service.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

// The pair guardian-lookup reads the gateway DB; the assistant DB proxy is
// mocked so any incidental assistant access stays inert in tests.
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(),
  assistantDbRun: mock(),
  assistantDbExec: mock(),
}));

const { initGatewayDb, resetGatewayDb, getGatewayDb } =
  await import("../db/connection.js");
const {
  actorTokenRecords,
  actorRefreshTokenRecords,
  contacts,
  contactChannels,
} = await import("../db/schema.js");
const { hashToken } = await import("../auth/guardian-bootstrap.js");
const { handleListDevices, handleRevokeDevice } =
  await import("../http/routes/devices.js");

const LOOPBACK_IP = "127.0.0.1";
const GUARDIAN_ID = "guardian-001";

let testRoot: string;

let actorSeedSeq = 0;

function seedActor(opts: {
  device: string;
  principal?: string;
  status?: "active" | "revoked";
  platform?: string;
  lastUsedAt?: number;
  updatedAt?: number;
}): void {
  const now = Date.now();
  const principal = opts.principal ?? GUARDIAN_ID;
  actorSeedSeq += 1;
  getGatewayDb()
    .insert(actorTokenRecords)
    .values({
      id: randomUUID(),
      tokenHash: hashToken(`acc-${principal}-${opts.device}-${actorSeedSeq}`),
      guardianPrincipalId: principal,
      hashedDeviceId: hashToken(opts.device),
      platform: opts.platform ?? "cli",
      status: opts.status ?? "active",
      issuedAt: now,
      expiresAt: now + 86_400_000,
      lastUsedAt: opts.lastUsedAt ?? null,
      createdAt: now,
      updatedAt: opts.updatedAt ?? now,
    })
    .run();
}

function seedRefresh(opts: {
  device: string;
  lastUsedAt?: number | null;
  status?: "active" | "revoked";
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(actorRefreshTokenRecords)
    .values({
      id: randomUUID(),
      tokenHash: hashToken(`ref-${opts.device}`),
      familyId: randomUUID(),
      guardianPrincipalId: GUARDIAN_ID,
      hashedDeviceId: hashToken(opts.device),
      platform: "cli",
      status: opts.status ?? "active",
      issuedAt: now,
      absoluteExpiresAt: now + 365 * 86_400_000,
      inactivityExpiresAt: now + 90 * 86_400_000,
      lastUsedAt: opts.lastUsedAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function listRequest(): Request {
  return new Request("http://localhost:7830/v1/devices", {
    method: "GET",
    headers: { host: "localhost:7830" },
  });
}

function revokeRequest(body?: Record<string, unknown>): Request {
  return new Request("http://localhost:7830/v1/devices/revoke", {
    method: "POST",
    headers: { host: "localhost:7830", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function activeActorCount(device: string): number {
  return getGatewayDb()
    .select()
    .from(actorTokenRecords)
    .where(
      and(
        eq(actorTokenRecords.hashedDeviceId, hashToken(device)),
        eq(actorTokenRecords.status, "active"),
      ),
    )
    .all().length;
}

function activeRefreshCount(device: string): number {
  return getGatewayDb()
    .select()
    .from(actorRefreshTokenRecords)
    .where(
      and(
        eq(actorRefreshTokenRecords.hashedDeviceId, hashToken(device)),
        eq(actorRefreshTokenRecords.status, "active"),
      ),
    )
    .all().length;
}

beforeEach(async () => {
  testRoot = mkdtempSync(join(tmpdir(), "devices-test-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  await initGatewayDb();

  // resolveLocalGuardianPrincipalId() reads the gateway DB for the vellum
  // active guardian principal; seed one so device endpoints scope to it.
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: GUARDIAN_ID,
      displayName: "Guardian",
      role: "guardian",
      principalId: GUARDIAN_ID,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: `ch-${GUARDIAN_ID}`,
      contactId: GUARDIAN_ID,
      type: "vellum",
      address: "guardian-vellum",
      isPrimary: false,
      status: "active",
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
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

describe("GET /v1/devices", () => {
  test("lists only the local principal's active devices", async () => {
    seedActor({ device: "device-A" });
    seedActor({ device: "device-B", platform: "webview" });
    seedActor({ device: "device-C", principal: "other-guardian" });
    seedActor({ device: "device-D", status: "revoked" });

    const res = await handleListDevices(listRequest(), LOOPBACK_IP);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      devices: { hashedDeviceId: string; platform: string }[];
    };

    const ids = body.devices.map((d) => d.hashedDeviceId).sort();
    expect(ids).toEqual([hashToken("device-A"), hashToken("device-B")].sort());
    const a = body.devices.find(
      (d) => d.hashedDeviceId === hashToken("device-A"),
    );
    expect(a?.platform).toBe("cli");
  });

  test("surfaces lastUsedAt from the actor token row", async () => {
    seedActor({ device: "device-A", lastUsedAt: 1_700_000_000_000 });

    const res = await handleListDevices(listRequest(), LOOPBACK_IP);
    const body = (await res.json()) as {
      devices: { hashedDeviceId: string; lastUsedAt: number | null }[];
    };
    const a = body.devices.find(
      (d) => d.hashedDeviceId === hashToken("device-A"),
    );
    expect(a?.lastUsedAt).toBe(1_700_000_000_000);
  });

  test("serializes lastUsedAt as null when the token row is unstamped", async () => {
    seedActor({ device: "device-B" });
    // Guards against the refresh record's timestamp leaking into the response.
    seedRefresh({ device: "device-B", lastUsedAt: 1_700_000_000_000 });

    const res = await handleListDevices(listRequest(), LOOPBACK_IP);
    const body = (await res.json()) as {
      devices: { hashedDeviceId: string; lastUsedAt: number | null }[];
    };
    const b = body.devices.find(
      (d) => d.hashedDeviceId === hashToken("device-B"),
    );
    expect(b?.lastUsedAt).toBeNull();
  });

  test("keeps the stamp from a rotated-out row when the active row is unstamped", async () => {
    // Refreshing credentials revokes the stamped row and mints an unstamped
    // replacement; the device's activity history must survive that.
    seedActor({
      device: "device-A",
      status: "revoked",
      lastUsedAt: 1_700_000_000_000,
    });
    seedActor({ device: "device-A" });

    const res = await handleListDevices(listRequest(), LOOPBACK_IP);
    const body = (await res.json()) as {
      devices: { hashedDeviceId: string; lastUsedAt: number | null }[];
    };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]?.lastUsedAt).toBe(1_700_000_000_000);
  });

  test("prefers the active row's stamp when it is newer than a rotated-out one", async () => {
    seedActor({
      device: "device-A",
      status: "revoked",
      lastUsedAt: 1_700_000_000_000,
    });
    seedActor({ device: "device-A", lastUsedAt: 1_800_000_000_000 });

    const res = await handleListDevices(listRequest(), LOOPBACK_IP);
    const body = (await res.json()) as {
      devices: { hashedDeviceId: string; lastUsedAt: number | null }[];
    };
    expect(body.devices[0]?.lastUsedAt).toBe(1_800_000_000_000);
  });

  test("returns null when no row for the device carries a stamp", async () => {
    seedActor({ device: "device-A", status: "revoked" });
    seedActor({ device: "device-A" });

    const res = await handleListDevices(listRequest(), LOOPBACK_IP);
    const body = (await res.json()) as {
      devices: { hashedDeviceId: string; lastUsedAt: number | null }[];
    };
    expect(body.devices[0]?.lastUsedAt).toBeNull();
  });

  test("does not borrow another principal's stamp for the same device hash", async () => {
    seedActor({
      device: "device-A",
      principal: "other-guardian",
      lastUsedAt: 1_700_000_000_000,
    });
    seedActor({ device: "device-A" });

    const res = await handleListDevices(listRequest(), LOOPBACK_IP);
    const body = (await res.json()) as {
      devices: { hashedDeviceId: string; lastUsedAt: number | null }[];
    };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]?.lastUsedAt).toBeNull();
  });

  test("rejects a non-loopback caller (403)", async () => {
    seedActor({ device: "device-A" });
    const res = await handleListDevices(listRequest(), "8.8.8.8");
    expect(res.status).toBe(403);
  });

  test("rejects a request carrying an Origin header (WebView vector, 403)", async () => {
    // A real host CLI never sends an Origin; a present Origin means a
    // browser/WebView (e.g. *.vellum.local) is calling and could read back
    // device hashes via the gateway's WebView CORS allowance. Must be refused.
    seedActor({ device: "device-A" });
    const req = new Request("http://localhost:7830/v1/devices", {
      method: "GET",
      headers: { host: "localhost:7830", origin: "https://app.vellum.local" },
    });
    const res = await handleListDevices(req, LOOPBACK_IP);
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/devices/revoke", () => {
  test("revokes a device's actor + refresh tokens, leaving others active", async () => {
    seedActor({ device: "device-A" });
    seedRefresh({ device: "device-A" });
    seedActor({ device: "device-B" });
    seedRefresh({ device: "device-B" });

    const res = await handleRevokeDevice(
      revokeRequest({ hashedDeviceId: hashToken("device-A") }),
      LOOPBACK_IP,
    );
    expect(res.status).toBe(200);
    expect(
      (await res.json()) as { revoked: boolean; hashedDeviceId: string },
    ).toEqual({
      revoked: true,
      hashedDeviceId: hashToken("device-A"),
    });

    expect(activeActorCount("device-A")).toBe(0);
    expect(activeRefreshCount("device-A")).toBe(0);
    expect(activeActorCount("device-B")).toBe(1);
    expect(activeRefreshCount("device-B")).toBe(1);
  });

  test("clears the device's activity stamp so a re-pair starts fresh", async () => {
    // Device ids hash stably, so re-pairing reuses the same hashedDeviceId. The
    // list reads the max stamp across statuses, so an uncleared revoked row
    // would report a last use predating the new pairing.
    seedActor({ device: "device-A", lastUsedAt: 1_700_000_000_000 });
    seedRefresh({ device: "device-A" });

    await handleRevokeDevice(
      revokeRequest({ hashedDeviceId: hashToken("device-A") }),
      LOOPBACK_IP,
    );

    // Re-pair: a fresh, unstamped active row for the same device.
    seedActor({ device: "device-A" });

    const res = await handleListDevices(listRequest(), LOOPBACK_IP);
    const body = (await res.json()) as {
      devices: { hashedDeviceId: string; lastUsedAt: number | null }[];
    };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]?.lastUsedAt).toBeNull();
  });

  test("clears the stamp on a rotated-out row so a re-pair starts fresh", async () => {
    // Any device older than one access-token TTL has rotated at least once,
    // which leaves a stamped revoked row behind. The list reads the max stamp
    // across statuses, so a revoke that only clears the active row would still
    // report the old activity after the re-pair.
    seedActor({
      device: "device-A",
      status: "revoked",
      lastUsedAt: 1_700_000_000_000,
    });
    seedActor({ device: "device-A", lastUsedAt: 1_800_000_000_000 });
    seedRefresh({ device: "device-A" });

    await handleRevokeDevice(
      revokeRequest({ hashedDeviceId: hashToken("device-A") }),
      LOOPBACK_IP,
    );

    // Re-pair: a fresh, unstamped active row for the same device.
    seedActor({ device: "device-A" });

    const res = await handleListDevices(listRequest(), LOOPBACK_IP);
    const body = (await res.json()) as {
      devices: { hashedDeviceId: string; lastUsedAt: number | null }[];
    };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]?.lastUsedAt).toBeNull();
  });

  test("does not bump updatedAt on rows whose status is already revoked", async () => {
    // updatedAt tracks lifecycle, lastUsedAt tracks activity: clearing the
    // stamp on an already-revoked row must not read as a lifecycle change.
    seedActor({
      device: "device-A",
      status: "revoked",
      lastUsedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    seedActor({ device: "device-A" });

    await handleRevokeDevice(
      revokeRequest({ hashedDeviceId: hashToken("device-A") }),
      LOOPBACK_IP,
    );

    const rows = getGatewayDb()
      .select()
      .from(actorTokenRecords)
      .where(eq(actorTokenRecords.hashedDeviceId, hashToken("device-A")))
      .all();
    const untouched = rows.filter((r) => r.updatedAt === 1_700_000_000_000);
    expect(untouched).toHaveLength(1);
    expect(untouched[0]?.lastUsedAt).toBeNull();
  });

  test("leaves another device's stamp intact", async () => {
    seedActor({ device: "device-A", lastUsedAt: 1_700_000_000_000 });
    seedActor({ device: "device-B", lastUsedAt: 1_800_000_000_000 });

    await handleRevokeDevice(
      revokeRequest({ hashedDeviceId: hashToken("device-A") }),
      LOOPBACK_IP,
    );

    const res = await handleListDevices(listRequest(), LOOPBACK_IP);
    const body = (await res.json()) as {
      devices: { hashedDeviceId: string; lastUsedAt: number | null }[];
    };
    const b = body.devices.find(
      (d) => d.hashedDeviceId === hashToken("device-B"),
    );
    expect(b?.lastUsedAt).toBe(1_800_000_000_000);
  });

  test("rejects a request without hashedDeviceId (400)", async () => {
    const res = await handleRevokeDevice(revokeRequest({}), LOOPBACK_IP);
    expect(res.status).toBe(400);
  });

  test("rejects a non-loopback caller (403)", async () => {
    const res = await handleRevokeDevice(
      revokeRequest({ hashedDeviceId: hashToken("device-A") }),
      "8.8.8.8",
    );
    expect(res.status).toBe(403);
  });

  test("rejects a request carrying an Origin header (WebView vector, 403)", async () => {
    seedActor({ device: "device-A" });
    seedRefresh({ device: "device-A" });
    const req = new Request("http://localhost:7830/v1/devices/revoke", {
      method: "POST",
      headers: {
        host: "localhost:7830",
        "content-type": "application/json",
        origin: "https://app.vellum.local",
      },
      body: JSON.stringify({ hashedDeviceId: hashToken("device-A") }),
    });
    const res = await handleRevokeDevice(req, LOOPBACK_IP);
    expect(res.status).toBe(403);
    // Refused before touching state — device-A stays active.
    expect(activeActorCount("device-A")).toBe(1);
  });
});
