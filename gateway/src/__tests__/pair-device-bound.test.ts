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

// pair.ts → resolveLocalGuardianPrincipalId() queries the assistant DB; mock it
// to return a stable principal. The device-bound token records live in the
// (real) gateway DB initialized below.
const mockQuery = mock();
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mockQuery,
  assistantDbRun: mock(),
  assistantDbExec: mock(),
}));

const { initGatewayDb, resetGatewayDb, getGatewayDb } =
  await import("../db/connection.js");
const { actorTokenRecords, actorRefreshTokenRecords } =
  await import("../db/schema.js");
const { handlePair, resetPairRateLimiterForTests } =
  await import("../http/routes/pair.js");
const { hashToken } = await import("../auth/guardian-bootstrap.js");

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
  mockQuery.mockResolvedValue([{ principalId: GUARDIAN_ID }]);
  testRoot = mkdtempSync(join(tmpdir(), "pair-device-test-"));
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

describe("/v1/pair device-bound minting", () => {
  test("records a device-bound access token and issues NO refresh token", async () => {
    const res = await handlePair(
      makePairRequest({ deviceId: "device-A", platform: "web" }),
      LOOPBACK_IP,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(typeof body.token).toBe("string");
    // Refreshable pairing is deferred until hot-path revocation is enforced.
    expect(body.refreshToken).toBeUndefined();
    expect(body.refreshAfter).toBeUndefined();

    const tokens = activeTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].guardianPrincipalId).toBe(GUARDIAN_ID);
    expect(tokens[0].hashedDeviceId).toBe(hashToken("device-A"));
    expect(tokens[0].platform).toBe("web");

    // No refresh token record is created on the pair path.
    const refresh = getGatewayDb()
      .select()
      .from(actorRefreshTokenRecords)
      .where(eq(actorRefreshTokenRecords.status, "active"))
      .all();
    expect(refresh).toHaveLength(0);
  });

  test("uses the short 24h pair TTL for the access token, not the 30-day bootstrap default", async () => {
    const before = Date.now();
    await handlePair(makePairRequest({ deviceId: "device-A" }), LOOPBACK_IP);

    const PAIR_TTL_MS = 24 * 60 * 60 * 1000;
    const [token] = activeTokens();
    // expiresAt should be ~24h out (allow a generous window), and well under
    // the 30-day bootstrap TTL — until hot-path revocation lands, the access
    // token's blast radius must stay bounded.
    expect(token.expiresAt! - before).toBeGreaterThan(PAIR_TTL_MS - 60_000);
    expect(token.expiresAt! - before).toBeLessThan(PAIR_TTL_MS + 60_000);
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
