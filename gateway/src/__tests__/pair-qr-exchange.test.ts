/**
 * Tests for `POST /v1/pair/qr-exchange`: the public exchange of a host-minted QR
 * pairing code for device-bound tokens. Covers flag gating, the happy path,
 * atomic single-use burn (including concurrent exchange), expiry, uniform
 * invalid-code failure, input validation, and per-IP rate limiting.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { initSigningKey } from "../auth/token-service.js";

// Must init signing key before importing modules that mint tokens.
initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

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
const { handleQrPairingExchange } =
  await import("../http/routes/pair-qr-exchange.js");
const { hashToken } = await import("../auth/guardian-bootstrap.js");
const {
  createQrPairingCode,
  getQrPairingCodeCountForTests,
  resetQrPairingCodesForTests,
  setQrPairingCodeNowForTests,
} = await import("../remote-web/qr-pairing-code-store.js");
const { resetQrPairingExchangeRateLimiterForTests } =
  await import("../remote-web/qr-pairing-exchange-rate-limit-store.js");
const { resetEnvOverridesCache } =
  await import("../feature-flag-env-overrides.js");

const GUARDIAN_ID = "guardian-001";
const CLIENT_IP = "203.0.113.7";

let testRoot: string;

function makeExchangeRequest(
  body?: unknown,
  opts: { method?: string; raw?: string } = {},
): Request {
  return new Request("https://paired.example.com/v1/pair/qr-exchange", {
    method: opts.method ?? "POST",
    headers: { "content-type": "application/json" },
    body:
      opts.raw !== undefined
        ? opts.raw
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
}

function activeTokens() {
  return getGatewayDb()
    .select()
    .from(actorTokenRecords)
    .where(eq(actorTokenRecords.status, "active"))
    .all();
}

function activeRefreshTokens() {
  return getGatewayDb()
    .select()
    .from(actorRefreshTokenRecords)
    .where(eq(actorRefreshTokenRecords.status, "active"))
    .all();
}

function seedGatewayGuardian() {
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
}

function enableFlag() {
  process.env.VELLUM_FLAG_WEB_REMOTE_INGRESS = "true";
  resetEnvOverridesCache();
}

function disableFlag() {
  delete process.env.VELLUM_FLAG_WEB_REMOTE_INGRESS;
  resetEnvOverridesCache();
}

beforeEach(async () => {
  resetQrPairingCodesForTests();
  resetQrPairingExchangeRateLimiterForTests();
  testRoot = mkdtempSync(join(tmpdir(), "pair-qr-exchange-test-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  await initGatewayDb();
  seedGatewayGuardian();
  enableFlag();
});

afterEach(() => {
  resetQrPairingCodesForTests();
  resetQrPairingExchangeRateLimiterForTests();
  disableFlag();
  resetGatewayDb();
  delete process.env.GATEWAY_SECURITY_DIR;
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("POST /v1/pair/qr-exchange", () => {
  test("404s and mints nothing when web-remote-ingress is disabled", async () => {
    disableFlag();
    const { code } = createQrPairingCode();

    const res = await handleQrPairingExchange(
      makeExchangeRequest({ code, deviceId: "device-A" }),
      CLIENT_IP,
    );

    expect(res.status).toBe(404);
    // The code is untouched: minting is fully gated, so a later enabled attempt
    // still works.
    expect(getQrPairingCodeCountForTests()).toBe(1);
    expect(activeTokens()).toHaveLength(0);
  });

  test("exchanges a valid code for a device-bound token pair", async () => {
    const { code } = createQrPairingCode();

    const res = await handleQrPairingExchange(
      makeExchangeRequest({ code, deviceId: "device-A" }),
      CLIENT_IP,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.token).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(typeof body.refreshTokenExpiresAt).toBe("string");
    expect(typeof body.refreshAfter).toBe("string");
    expect(body.guardianId).toBe(GUARDIAN_ID);

    const tokens = activeTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].guardianPrincipalId).toBe(GUARDIAN_ID);
    expect(tokens[0].hashedDeviceId).toBe(hashToken("device-A"));
    expect(tokens[0].platform).toBe("qr");

    const refresh = activeRefreshTokens();
    expect(refresh).toHaveLength(1);
    expect(refresh[0].tokenHash).toBe(hashToken(body.refreshToken as string));

    // The code is burned: it is gone from the store.
    expect(getQrPairingCodeCountForTests()).toBe(0);
  });

  test("is single-use: a second exchange of the same code fails", async () => {
    const { code } = createQrPairingCode();

    const first = await handleQrPairingExchange(
      makeExchangeRequest({ code, deviceId: "device-A" }),
      CLIENT_IP,
    );
    expect(first.status).toBe(200);

    const second = await handleQrPairingExchange(
      makeExchangeRequest({ code, deviceId: "device-B" }),
      CLIENT_IP,
    );
    expect(second.status).toBe(401);
    // No second token was minted.
    expect(activeTokens()).toHaveLength(1);
    expect(activeTokens()[0].hashedDeviceId).toBe(hashToken("device-A"));
  });

  test("a concurrent exchange of the same code lets exactly one win", async () => {
    const { code } = createQrPairingCode();

    const [a, b] = await Promise.all([
      handleQrPairingExchange(
        makeExchangeRequest({ code, deviceId: "device-A" }),
        CLIENT_IP,
      ),
      handleQrPairingExchange(
        makeExchangeRequest({ code, deviceId: "device-B" }),
        CLIENT_IP,
      ),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
    expect(activeTokens()).toHaveLength(1);
  });

  test("rejects an expired code with 401", async () => {
    setQrPairingCodeNowForTests(() => 1_000);
    const { code } = createQrPairingCode();
    // Advance past the 5-minute TTL.
    setQrPairingCodeNowForTests(() => 1_000 + 6 * 60 * 1000);

    const res = await handleQrPairingExchange(
      makeExchangeRequest({ code, deviceId: "device-A" }),
      CLIENT_IP,
    );

    expect(res.status).toBe(401);
    expect(activeTokens()).toHaveLength(0);
  });

  test("returns the same 401 for an unknown code (no existence leak)", async () => {
    const res = await handleQrPairingExchange(
      makeExchangeRequest({ code: "not-a-real-code", deviceId: "device-A" }),
      CLIENT_IP,
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: {
        code: "INVALID_OR_EXPIRED_QR_CODE",
        message: "invalid or expired pairing code",
      },
    });
    expect(activeTokens()).toHaveLength(0);
  });

  test("requires both code and deviceId", async () => {
    const missingDevice = await handleQrPairingExchange(
      makeExchangeRequest({ code: "abc" }),
      CLIENT_IP,
    );
    expect(missingDevice.status).toBe(400);

    const missingCode = await handleQrPairingExchange(
      makeExchangeRequest({ deviceId: "device-A" }),
      CLIENT_IP,
    );
    expect(missingCode.status).toBe(400);
    expect(activeTokens()).toHaveLength(0);
  });

  test("rejects an invalid JSON body with 400", async () => {
    const res = await handleQrPairingExchange(
      makeExchangeRequest(undefined, { raw: "not json" }),
      CLIENT_IP,
    );
    expect(res.status).toBe(400);
  });

  test("rejects a non-POST method with 405", async () => {
    const res = await handleQrPairingExchange(
      makeExchangeRequest(
        { code: "abc", deviceId: "device-A" },
        { method: "GET" },
      ),
      CLIENT_IP,
    );
    expect(res.status).toBe(405);
  });

  test("rate limits per IP after the request budget is spent", async () => {
    // The limiter allows 10 requests/minute per IP; the 11th is 429.
    for (let i = 0; i < 10; i++) {
      const res = await handleQrPairingExchange(
        makeExchangeRequest({ code: `miss-${i}`, deviceId: "device-A" }),
        CLIENT_IP,
      );
      expect(res.status).toBe(401);
    }

    const limited = await handleQrPairingExchange(
      makeExchangeRequest({ code: "miss-final", deviceId: "device-A" }),
      CLIENT_IP,
    );
    expect(limited.status).toBe(429);
    expect(typeof limited.headers.get("Retry-After")).toBe("string");

    // A different IP is unaffected by another IP's budget.
    const { code } = createQrPairingCode();
    const other = await handleQrPairingExchange(
      makeExchangeRequest({ code, deviceId: "device-A" }),
      "198.51.100.9",
    );
    expect(other.status).toBe(200);
  });
});
