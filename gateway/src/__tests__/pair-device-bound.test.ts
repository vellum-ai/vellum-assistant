/**
 * Tests for device-scoped /v1/pair minting: when a request supplies a deviceId,
 * pair mints a DB-recorded, revocable, refreshable token pair (instead of the
 * legacy stateless token).
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { initSigningKey } from "../auth/token-service.js";

// Must init signing key before importing modules that mint tokens.
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
const { handlePair, resetPairRateLimiterForTests } =
  await import("../http/routes/pair.js");
const { hashToken } = await import("../auth/guardian-bootstrap.js");
const { rotateCredentials } = await import("../auth/guardian-refresh.js");

const LOOPBACK_IP = "127.0.0.1";
const PROD_ORIGIN = "chrome-extension://hphbdmpffeigpcdjkckleobjmhhokpne";
const GUARDIAN_ID = "guardian-001";

let testRoot: string;

function makePairRequest(body?: Record<string, unknown>): Request {
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

function activeTokens() {
  return getGatewayDb()
    .select()
    .from(actorTokenRecords)
    .where(eq(actorTokenRecords.status, "active"))
    .all();
}

beforeEach(async () => {
  resetPairRateLimiterForTests();
  testRoot = mkdtempSync(join(tmpdir(), "pair-device-test-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  await initGatewayDb();

  // pair.ts → resolveLocalGuardianPrincipalId() reads the gateway DB for the
  // vellum active guardian principal; seed one so device-bound mints carry it.
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

describe("/v1/pair device-bound minting", () => {
  test("records a device-bound access token AND a refresh token", async () => {
    const res = await handlePair(
      makePairRequest({ deviceId: "device-A", platform: "web" }),
      LOOPBACK_IP,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(typeof body.token).toBe("string");
    // A device-scoped refresh token is now issued so the client can renew
    // without re-pairing (safe now that hot-path revocation is enforced).
    expect(typeof body.refreshToken).toBe("string");
    expect((body.refreshToken as string).length).toBeGreaterThan(0);
    expect(typeof body.refreshTokenExpiresAt).toBe("string");
    expect(typeof body.refreshAfter).toBe("string");

    const tokens = activeTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].guardianPrincipalId).toBe(GUARDIAN_ID);
    expect(tokens[0].hashedDeviceId).toBe(hashToken("device-A"));
    expect(tokens[0].platform).toBe("web");

    // A matching active refresh token record is written for the same device.
    const refresh = getGatewayDb()
      .select()
      .from(actorRefreshTokenRecords)
      .where(eq(actorRefreshTokenRecords.status, "active"))
      .all();
    expect(refresh).toHaveLength(1);
    expect(refresh[0].guardianPrincipalId).toBe(GUARDIAN_ID);
    expect(refresh[0].hashedDeviceId).toBe(hashToken("device-A"));
    expect(refresh[0].tokenHash).toBe(hashToken(body.refreshToken as string));
  });

  test("the issued refresh token is redeemable for a fresh access token", async () => {
    const res = await handlePair(
      makePairRequest({ deviceId: "device-A" }),
      LOOPBACK_IP,
    );
    const body = (await res.json()) as { token: string; refreshToken: string };

    const rotated = rotateCredentials({
      refreshToken: body.refreshToken,
      hashedDeviceId: hashToken("device-A"),
    });
    expect(rotated.ok).toBe(true);
    if (rotated.ok) {
      // A new access token (and rotated refresh token) is minted.
      expect(typeof rotated.result.accessToken).toBe("string");
      expect(rotated.result.accessToken).not.toBe(body.token);
      expect(rotated.result.refreshToken).not.toBe(body.refreshToken);
      expect(rotated.result.guardianPrincipalId).toBe(GUARDIAN_ID);
    }
  });

  test("uses the standard 30-day access TTL, consistent with refresh rotation", async () => {
    const before = Date.now();
    await handlePair(makePairRequest({ deviceId: "device-A" }), LOOPBACK_IP);

    const DAY_MS = 24 * 60 * 60 * 1000;
    const [token] = activeTokens();
    // The device-bound access token uses the standard ~30-day TTL (NOT a short
    // pair-specific TTL): a refresh token + hot-path revocation bound a leaked
    // token's reach, and the TTL stays consistent with what /v1/guardian/refresh
    // mints on rotation (rather than 24h at mint then 30d after the first
    // refresh). Allow a generous window around 30 days.
    expect(token.expiresAt! - before).toBeGreaterThan(29 * DAY_MS);
    expect(token.expiresAt! - before).toBeLessThan(31 * DAY_MS);
  });

  test("re-pairing the same device revokes the prior active token (no unique-index violation)", async () => {
    const first = await handlePair(
      makePairRequest({ deviceId: "device-A" }),
      LOOPBACK_IP,
    );
    const firstToken = (await first.json()) as { token: string };

    const second = await handlePair(
      makePairRequest({ deviceId: "device-A" }),
      LOOPBACK_IP,
    );
    expect(second.status).toBe(200);

    // Exactly one active token remains for the device; the first is revoked.
    const tokens = activeTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].tokenHash).not.toBe(hashToken(firstToken.token));
  });

  test("without a deviceId, returns the legacy stateless token and records nothing", async () => {
    const res = await handlePair(makePairRequest(), LOOPBACK_IP);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(typeof body.token).toBe("string");
    expect(body.refreshToken).toBeUndefined();
    expect(body.refreshAfter).toBeUndefined();

    expect(activeTokens()).toHaveLength(0);
  });
});

describe("/v1/pair cli interface", () => {
  // The cli interface (e.g. `vellum pair`) is loopback-gated like the rest of
  // /v1/pair, but is NOT a browser, so it carries no Origin header.
  function makeCliRequest(body?: Record<string, unknown>): Request {
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

  test("mints a device-bound token pair (no Origin header required)", async () => {
    const res = await handlePair(
      makeCliRequest({ deviceId: "device-cli" }),
      LOOPBACK_IP,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(typeof body.token).toBe("string");
    expect(typeof body.expiresAt).toBe("string");
    expect(body.guardianId).toBe(GUARDIAN_ID);
    expect(typeof body.refreshToken).toBe("string");

    const tokens = activeTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].hashedDeviceId).toBe(hashToken("device-cli"));
    expect(tokens[0].platform).toBe("cli");
  });

  test("rejects a cli pair request without a deviceId (400)", async () => {
    const res = await handlePair(makeCliRequest(), LOOPBACK_IP);
    expect(res.status).toBe(400);
    expect(activeTokens()).toHaveLength(0);
  });

  test("still rejects non-loopback cli callers", async () => {
    const res = await handlePair(
      makeCliRequest({ deviceId: "device-cli" }),
      "8.8.8.8",
    );
    expect(res.status).toBe(403);
    expect(activeTokens()).toHaveLength(0);
  });

  test("rejects a cli request carrying an Origin header (WebView exfiltration vector)", async () => {
    // A browser/WebView page (e.g. a dynamic surface at *.vellum.local) always
    // sends an Origin; a real `vellum pair` never does. Such a request would
    // otherwise pass the loopback guards (it runs on the same machine) and mint
    // a broadly-scoped token the page could read back via the WebView CORS
    // allowance — so it must be refused, minting nothing.
    const req = new Request("http://localhost:7830/v1/pair", {
      method: "POST",
      headers: {
        host: "localhost:7830",
        "content-type": "application/json",
        "x-vellum-interface-id": "cli",
        origin: "https://app.vellum.local",
      },
      body: JSON.stringify({ deviceId: "device-cli", platform: "webview" }),
    });
    const res = await handlePair(req, LOOPBACK_IP);
    expect(res.status).toBe(403);
    expect(activeTokens()).toHaveLength(0);
  });
});
