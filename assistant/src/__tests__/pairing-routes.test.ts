/**
 * API-level tests for the device pairing routes.
 *
 * Validates that handlePairingRequest correctly prevents a second device
 * from hijacking an existing pairing request, while allowing the same
 * device to call the endpoint idempotently.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "pairing-routes-test-")),
);
process.env.VELLUM_HOME = testDir;
process.env.VELLUM_WORKSPACE_DIR = testDir;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { PairingStore } from "../daemon/pairing-store.js";
import type { PairingHandlerContext } from "../runtime/routes/pairing-routes.js";
import { handlePairingRequest } from "../runtime/routes/pairing-routes.js";

// ── Helpers ──────────────────────────────────────────────────────────────

const TEST_PAIRING_ID = "pair-test-001";
const TEST_SECRET = "super-secret-value";
const GATEWAY_URL = "https://gateway.test";

function makeContext(store: PairingStore): PairingHandlerContext {
  return {
    pairingStore: store,
    bearerToken: "test-bearer-token",
    pairingBroadcast: mock(() => {}),
  };
}

function makePairingRequest(overrides: Record<string, unknown> = {}): Request {
  const body = {
    pairingRequestId: TEST_PAIRING_ID,
    pairingSecret: TEST_SECRET,
    deviceId: "device-A",
    deviceName: "iPhone A",
    ...overrides,
  };
  return new Request("http://localhost/v1/pairing/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  delete process.env.VELLUM_HOME;
  delete process.env.VELLUM_WORKSPACE_DIR;
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("handlePairingRequest — device binding", () => {
  let store: PairingStore;
  let ctx: PairingHandlerContext;

  beforeEach(() => {
    store = new PairingStore();
    store.start();
    ctx = makeContext(store);

    // Pre-register the pairing request (simulating QR code display)
    store.register({
      pairingRequestId: TEST_PAIRING_ID,
      pairingSecret: TEST_SECRET,
      gatewayUrl: GATEWAY_URL,
    });
  });

  test("rejects a second device attempting to pair with the same pairing ID", async () => {
    /**
     * Tests that once a device has initiated pairing, a different device
     * cannot hijack the same pairing request.
     */

    // GIVEN device A has already initiated pairing
    const firstReq = makePairingRequest({
      deviceId: "device-A",
      deviceName: "iPhone A",
    });
    const firstRes = await handlePairingRequest(firstReq, ctx);
    expect(firstRes.status).toBe(200);

    // WHEN device B tries to pair with the same pairing ID and secret
    const secondReq = makePairingRequest({
      deviceId: "device-B",
      deviceName: "iPhone B",
    });
    const secondRes = await handlePairingRequest(secondReq, ctx);

    // THEN the request is rejected with 409 Conflict
    expect(secondRes.status).toBe(409);
    const body = (await secondRes.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toContain("already bound to another device");
  });

  test("allows the same device to call pairing request idempotently", async () => {
    /**
     * Tests that calling pairing request twice from the same device
     * succeeds both times without error.
     */

    // GIVEN device A has already initiated pairing
    const firstReq = makePairingRequest({
      deviceId: "device-A",
      deviceName: "iPhone A",
    });
    const firstRes = await handlePairingRequest(firstReq, ctx);
    expect(firstRes.status).toBe(200);

    // WHEN device A calls pairing request again with the same credentials
    const secondReq = makePairingRequest({
      deviceId: "device-A",
      deviceName: "iPhone A",
    });
    const secondRes = await handlePairingRequest(secondReq, ctx);

    // THEN it succeeds (idempotent)
    expect(secondRes.status).toBe(200);
  });

  test("allows the same device to retrieve token after approval", async () => {
    /**
     * Tests that once a pairing request is approved, the same device
     * can call the endpoint again and receive the bearer token.
     */

    // GIVEN device A has initiated pairing
    const firstReq = makePairingRequest({
      deviceId: "device-A",
      deviceName: "iPhone A",
    });
    const firstRes = await handlePairingRequest(firstReq, ctx);
    expect(firstRes.status).toBe(200);

    // AND the pairing request has been approved
    store.approve(TEST_PAIRING_ID, "test-bearer-token");

    // WHEN device A calls pairing request again
    const secondReq = makePairingRequest({
      deviceId: "device-A",
      deviceName: "iPhone A",
    });
    const secondRes = await handlePairingRequest(secondReq, ctx);

    // THEN the request succeeds (status stays approved, device matches)
    expect(secondRes.status).toBe(200);
  });

  test("rejects a different device even after the first device was approved", async () => {
    /**
     * Tests that a different device cannot hijack a pairing request
     * even after the original device's request has been approved.
     */

    // GIVEN device A has paired and been approved
    const firstReq = makePairingRequest({
      deviceId: "device-A",
      deviceName: "iPhone A",
    });
    await handlePairingRequest(firstReq, ctx);
    store.approve(TEST_PAIRING_ID, "test-bearer-token");

    // WHEN device B tries to use the same pairing request
    const hijackReq = makePairingRequest({
      deviceId: "device-B",
      deviceName: "Attacker Phone",
    });
    const hijackRes = await handlePairingRequest(hijackReq, ctx);

    // THEN it is rejected
    expect(hijackRes.status).toBe(409);
    const body = (await hijackRes.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("CONFLICT");
  });
});
