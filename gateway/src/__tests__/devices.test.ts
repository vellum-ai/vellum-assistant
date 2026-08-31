/**
 * Tests for the loopback-guarded device endpoints: GET /v1/devices (list) and
 * POST /v1/devices/revoke (revoke by hashedDeviceId), scoped to the local
 * guardian principal.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
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
const { hashToken, mintAndRecordDeviceBoundTokenPair, bootstrapGuardian } =
  await import("../auth/guardian-bootstrap.js");
const { MAX_PAIRING_USER_AGENT_CHARS } =
  await import("../auth/device-identity-text.js");
const { handleListDevices, handleRevokeDevice } =
  await import("../http/routes/devices.js");
const { handlePair, resetPairRateLimiterForTests } =
  await import("../http/routes/pair.js");

const LOOPBACK_IP = "127.0.0.1";
const GUARDIAN_ID = "guardian-001";

let testRoot: string;

let actorSeedSeq = 0;

function seedActor(opts: {
  device: string;
  principal?: string;
  status?: "active" | "revoked";
  platform?: string;
  pairingUserAgent?: string;
  clientReportedName?: string;
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
      pairingUserAgent: opts.pairingUserAgent,
      clientReportedName: opts.clientReportedName,
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

function actorRow(device: string) {
  return getGatewayDb()
    .select()
    .from(actorTokenRecords)
    .where(eq(actorTokenRecords.hashedDeviceId, hashToken(device)))
    .get();
}

function refreshRow(device: string) {
  return getGatewayDb()
    .select()
    .from(actorRefreshTokenRecords)
    .where(eq(actorRefreshTokenRecords.hashedDeviceId, hashToken(device)))
    .get();
}

beforeEach(async () => {
  resetPairRateLimiterForTests();
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

describe("actorTokenRecords device identity columns", () => {
  test("round-trips pairingUserAgent and clientReportedName", () => {
    seedActor({
      device: "device-identity-populated",
      pairingUserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      clientReportedName: "Alice's MacBook Pro",
    });

    const row = actorRow("device-identity-populated");
    expect(row?.pairingUserAgent).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    expect(row?.clientReportedName).toBe("Alice's MacBook Pro");
  });

  test("leaves pairingUserAgent and clientReportedName null when omitted", () => {
    seedActor({ device: "device-identity-omitted" });

    const row = actorRow("device-identity-omitted");
    expect(row?.pairingUserAgent).toBeNull();
    expect(row?.clientReportedName).toBeNull();
  });
});

describe("mintAndRecordDeviceBoundTokenPair identity persistence", () => {
  test("writes identity to both the actor-token row and the refresh-token row", () => {
    mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      deviceId: "mint-device-with-identity",
      platform: "cli",
      identity: {
        pairingUserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        clientReportedName: "Alice's MacBook Pro",
      },
    });

    const access = actorRow("mint-device-with-identity");
    expect(access?.pairingUserAgent).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    expect(access?.clientReportedName).toBe("Alice's MacBook Pro");

    const refresh = refreshRow("mint-device-with-identity");
    expect(refresh?.pairingUserAgent).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    expect(refresh?.clientReportedName).toBe("Alice's MacBook Pro");
  });

  test("writes null to both columns on both tables when identity is omitted", () => {
    mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      deviceId: "mint-device-without-identity",
      platform: "cli",
    });

    const access = actorRow("mint-device-without-identity");
    expect(access?.pairingUserAgent).toBeNull();
    expect(access?.clientReportedName).toBeNull();

    const refresh = refreshRow("mint-device-without-identity");
    expect(refresh?.pairingUserAgent).toBeNull();
    expect(refresh?.clientReportedName).toBeNull();
  });

  test("truncates an over-length User-Agent to MAX_PAIRING_USER_AGENT_CHARS", () => {
    const overLongUserAgent = "A".repeat(600);
    expect(overLongUserAgent.length).toBe(600);

    mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      deviceId: "mint-device-long-user-agent",
      platform: "cli",
      identity: { pairingUserAgent: overLongUserAgent },
    });

    const access = actorRow("mint-device-long-user-agent");
    expect(access?.pairingUserAgent?.length).toBe(MAX_PAIRING_USER_AGENT_CHARS);
    expect(access?.pairingUserAgent).toBe(
      "A".repeat(MAX_PAIRING_USER_AGENT_CHARS),
    );

    const refresh = refreshRow("mint-device-long-user-agent");
    expect(refresh?.pairingUserAgent?.length).toBe(
      MAX_PAIRING_USER_AGENT_CHARS,
    );
  });
});

describe("bootstrapGuardian host identity", () => {
  test("names the host credential after the machine hostname", async () => {
    await bootstrapGuardian({ platform: "cli", deviceId: "host-device" });

    const row = actorRow("host-device");
    expect(row?.clientReportedName).toBe(hostname());
    expect(row?.pairingUserAgent).toBeNull();

    // isCurrentHost (cli/src/commands/devices.ts) keys off hashedDeviceId; the
    // name must not disturb it.
    const res = await handleListDevices(listRequest(), LOOPBACK_IP);
    const body = (await res.json()) as {
      devices: { hashedDeviceId: string; clientReportedName: string | null }[];
    };
    const listed = body.devices.find(
      (d) => d.hashedDeviceId === hashToken("host-device"),
    );
    expect(listed?.hashedDeviceId).toBe(hashToken("host-device"));
    expect(listed?.clientReportedName).toBe(hostname());
  });

  test("leaves clientReportedName null and still completes bootstrap when hostname() throws", async () => {
    const realOs = await import("node:os");
    mock.module("node:os", () => ({
      ...realOs,
      hostname: () => {
        throw new Error("no hostname available");
      },
    }));

    try {
      const result = await bootstrapGuardian({
        platform: "cli",
        deviceId: "host-device-throws",
      });
      expect(result.accessToken).toBeTruthy();
    } finally {
      mock.module("node:os", () => realOs);
    }

    const row = actorRow("host-device-throws");
    expect(row?.clientReportedName).toBeNull();
  });

  test("prefers a client-reported hostname over the gateway's own hostname", async () => {
    await bootstrapGuardian({
      platform: "cli",
      deviceId: "host-device-remote",
      clientReportedName: "Alices-MacBook-Pro.local",
    });

    const row = actorRow("host-device-remote");
    expect(row?.clientReportedName).toBe("Alices-MacBook-Pro.local");
  });
});

describe("/v1/pair clientReportedName", () => {
  const PROD_ORIGIN = "chrome-extension://hphbdmpffeigpcdjkckleobjmhhokpne";

  function makeExtensionPairRequest(body?: Record<string, unknown>): Request {
    return new Request("http://localhost:7830/v1/pair", {
      method: "POST",
      headers: {
        host: "localhost:7830",
        "content-type": "application/json",
        origin: PROD_ORIGIN,
        "x-vellum-interface-id": "chrome-extension",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  function makeCliPairRequest(body?: Record<string, unknown>): Request {
    return new Request("http://localhost:7830/v1/pair", {
      method: "POST",
      headers: {
        host: "localhost:7830",
        "content-type": "application/json",
        "x-vellum-interface-id": "cli",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  test("persists a client-reported name on both minted rows (chrome-extension)", async () => {
    const res = await handlePair(
      makeExtensionPairRequest({
        deviceId: "device-ext-name",
        clientReportedName: "Alice's Chromebook",
      }),
      LOOPBACK_IP,
    );
    expect(res.status).toBe(200);

    expect(actorRow("device-ext-name")?.clientReportedName).toBe(
      "Alice's Chromebook",
    );
    expect(refreshRow("device-ext-name")?.clientReportedName).toBe(
      "Alice's Chromebook",
    );
  });

  test("persists a client-reported name on both minted rows (cli)", async () => {
    const res = await handlePair(
      makeCliPairRequest({
        deviceId: "device-cli-name",
        clientReportedName: "Alice's MacBook Pro",
      }),
      LOOPBACK_IP,
    );
    expect(res.status).toBe(200);

    expect(actorRow("device-cli-name")?.clientReportedName).toBe(
      "Alice's MacBook Pro",
    );
    expect(refreshRow("device-cli-name")?.clientReportedName).toBe(
      "Alice's MacBook Pro",
    );
  });

  test("records null when clientReportedName is omitted, and still pairs", async () => {
    const res = await handlePair(
      makeCliPairRequest({ deviceId: "device-no-name" }),
      LOOPBACK_IP,
    );
    expect(res.status).toBe(200);

    expect(actorRow("device-no-name")?.clientReportedName).toBeNull();
    expect(refreshRow("device-no-name")?.clientReportedName).toBeNull();
  });

  test("records null and still pairs when clientReportedName is not a string", async () => {
    const res = await handlePair(
      makeCliPairRequest({
        deviceId: "device-bad-name",
        clientReportedName: 12345,
      }),
      LOOPBACK_IP,
    );
    expect(res.status).toBe(200);

    expect(actorRow("device-bad-name")?.clientReportedName).toBeNull();
    expect(refreshRow("device-bad-name")?.clientReportedName).toBeNull();
  });

  test("a body that is not JSON at all still takes the stateless path unchanged", async () => {
    const req = new Request("http://localhost:7830/v1/pair", {
      method: "POST",
      headers: {
        host: "localhost:7830",
        "content-type": "application/json",
        origin: PROD_ORIGIN,
        "x-vellum-interface-id": "chrome-extension",
      },
      body: "not json",
    });
    const res = await handlePair(req, LOOPBACK_IP);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.token).toBe("string");
    // Stateless path: no device-bound row, so no refreshToken either.
    expect(body.refreshToken).toBeUndefined();
  });
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

  test("surfaces pairingUserAgent and clientReportedName, alongside a correct lastUsedAt", async () => {
    seedActor({
      device: "device-A",
      pairingUserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      clientReportedName: "Alice's MacBook Pro",
      lastUsedAt: 1_700_000_000_000,
    });
    seedActor({ device: "device-B" });

    const res = await handleListDevices(listRequest(), LOOPBACK_IP);
    const body = (await res.json()) as {
      devices: {
        hashedDeviceId: string;
        pairingUserAgent: string | null;
        clientReportedName: string | null;
        lastUsedAt: number | null;
      }[];
    };

    const a = body.devices.find(
      (d) => d.hashedDeviceId === hashToken("device-A"),
    );
    expect(a?.pairingUserAgent).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    expect(a?.clientReportedName).toBe("Alice's MacBook Pro");
    expect(a?.lastUsedAt).toBe(1_700_000_000_000);

    const b = body.devices.find(
      (d) => d.hashedDeviceId === hashToken("device-B"),
    );
    expect(b).toHaveProperty("pairingUserAgent", null);
    expect(b).toHaveProperty("clientReportedName", null);
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
