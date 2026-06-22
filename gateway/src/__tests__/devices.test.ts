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
const { actorTokenRecords, actorRefreshTokenRecords, contacts, contactChannels } =
  await import("../db/schema.js");
const { hashToken } = await import("../auth/guardian-bootstrap.js");
const { handleListDevices, handleRevokeDevice } =
  await import("../http/routes/devices.js");

const LOOPBACK_IP = "127.0.0.1";
const GUARDIAN_ID = "guardian-001";

let testRoot: string;

function seedActor(opts: {
  device: string;
  principal?: string;
  status?: "active" | "revoked";
  platform?: string;
}): void {
  const now = Date.now();
  const principal = opts.principal ?? GUARDIAN_ID;
  getGatewayDb()
    .insert(actorTokenRecords)
    .values({
      id: randomUUID(),
      tokenHash: hashToken(`acc-${principal}-${opts.device}`),
      guardianPrincipalId: principal,
      hashedDeviceId: hashToken(opts.device),
      platform: opts.platform ?? "cli",
      status: opts.status ?? "active",
      issuedAt: now,
      expiresAt: now + 86_400_000,
      createdAt: now,
      updatedAt: now,
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

  test("surfaces lastUsedAt from the refresh record (null when none)", async () => {
    seedActor({ device: "device-A" });
    seedActor({ device: "device-B" });
    seedRefresh({ device: "device-A", lastUsedAt: 1_700_000_000_000 });

    const res = await handleListDevices(listRequest(), LOOPBACK_IP);
    const body = (await res.json()) as {
      devices: { hashedDeviceId: string; lastUsedAt: number | null }[];
    };
    const a = body.devices.find(
      (d) => d.hashedDeviceId === hashToken("device-A"),
    );
    const b = body.devices.find(
      (d) => d.hashedDeviceId === hashToken("device-B"),
    );
    expect(a?.lastUsedAt).toBe(1_700_000_000_000);
    expect(b?.lastUsedAt).toBeNull();
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
