/**
 * Tests for JWT credential service, hash-only storage,
 * guardian bootstrap endpoint idempotency, and pairing flow.
 *
 * Legacy actor-token HMAC middleware tests have been removed --
 * that middleware is replaced by the JWT auth middleware in
 * runtime/auth/middleware.ts (tested in auth/middleware.test.ts).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(mkdtempSync(join(tmpdir(), "actor-token-test-")));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getDbPath: () => join(testDir, "test.db"),
  normalizeAssistantId: (id: string) => (id === "self" ? "self" : id),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => false,
  getInternalGatewayTarget: () => "http://localhost:7822",
  getGatewayBaseUrl: () => "http://localhost:7822",
  getRuntimeGatewayOriginSecret: () => undefined,
  isHttpAuthDisabledWithoutSafetyGate: () => false,
  checkUnrecognizedEnvVars: () => {},
  getBaseDataDir: () => testDir,
}));

import { findGuardianForChannel } from "../contacts/contact-store.js";
import { createGuardianBinding } from "../contacts/contacts-write.js";
import { getSqlite, initializeDb, resetDb } from "../memory/db.js";
import {
  createActorTokenRecord,
  findActiveByDeviceBinding,
  findActiveByTokenHash,
  revokeByDeviceBinding,
  revokeByTokenHash,
} from "../runtime/actor-token-store.js";
import { resetExternalAssistantIdCache } from "../runtime/auth/external-assistant-id.js";
import {
  BootstrapAlreadyCompleted,
  fetchSigningKeyFromGateway,
  hashToken,
  initAuthSigningKey,
} from "../runtime/auth/token-service.js";
import { ensureVellumGuardianBinding } from "../runtime/guardian-vellum-migration.js";
import {
  resolveLocalAuthContext,
  resolveLocalTrustContext,
} from "../runtime/local-actor-identity.js";

// ---------------------------------------------------------------------------
// Test signing key
// ---------------------------------------------------------------------------

const TEST_KEY = Buffer.from("test-signing-key-32-bytes-long!!");

// ---------------------------------------------------------------------------
// Mock server helpers for loopback IP checks (used by bootstrap tests)
// ---------------------------------------------------------------------------

/** Bun server shape needed for requestIP. */
type ServerWithRequestIP = {
  requestIP(
    req: Request,
  ): { address: string; family: string; port: number } | null;
};

/** Creates a mock server that returns the given IP for any request. */
function mockServer(address: string): ServerWithRequestIP {
  return {
    requestIP: () => ({ address, family: "IPv4", port: 0 }),
  };
}

/** Mock loopback server -- returns 127.0.0.1 for all requests. */
const loopbackServer = mockServer("127.0.0.1");

/** Mock non-loopback server -- returns a public IP for all requests. */
const nonLoopbackServer = mockServer("203.0.113.50");

initializeDb();

beforeEach(() => {
  // Initialize signing key for JWT verification
  initAuthSigningKey(TEST_KEY);
  // Reset the external assistant ID cache so tests don't leak state
  resetExternalAssistantIdCache();
  // Clear DB state between tests.
  resetDb();
  initializeDb();
  const db = getSqlite();
  db.run("DELETE FROM actor_token_records");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
});

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// Hash-only storage
// ---------------------------------------------------------------------------

describe("actor-token store (hash-only)", () => {
  test("createActorTokenRecord stores hash, never raw token", () => {
    const tokenHash = hashToken("test-token-for-store");

    const record = createActorTokenRecord({
      tokenHash,
      guardianPrincipalId: "principal-store",
      hashedDeviceId: "hashed-dev-store",
      platform: "macos",
      issuedAt: Date.now(),
    });

    expect(record.tokenHash).toBe(tokenHash);
    expect(record.status).toBe("active");
    const found = findActiveByTokenHash(tokenHash);
    expect(found).not.toBeNull();
    expect(found!.tokenHash).toBe(tokenHash);
  });

  test("findActiveByDeviceBinding returns matching record", () => {
    const tokenHash = hashToken("test-token-for-binding");

    createActorTokenRecord({
      tokenHash,
      guardianPrincipalId: "principal-bind",
      hashedDeviceId: "hashed-dev-bind",
      platform: "ios",
      issuedAt: Date.now(),
    });

    const found = findActiveByDeviceBinding(
      "principal-bind",
      "hashed-dev-bind",
    );
    expect(found).not.toBeNull();
    expect(found!.platform).toBe("ios");
  });

  test("revokeByDeviceBinding marks tokens as revoked", () => {
    const tokenHash = hashToken("test-token-for-revoke");

    createActorTokenRecord({
      tokenHash,
      guardianPrincipalId: "principal-revoke",
      hashedDeviceId: "hashed-dev-revoke",
      platform: "macos",
      issuedAt: Date.now(),
    });

    const count = revokeByDeviceBinding(
      "principal-revoke",
      "hashed-dev-revoke",
    );
    expect(count).toBe(1);

    const found = findActiveByTokenHash(tokenHash);
    expect(found).toBeNull();
  });

  test("revokeByTokenHash revokes a single token", () => {
    const tokenHash = hashToken("test-token-for-single-revoke");

    createActorTokenRecord({
      tokenHash,
      guardianPrincipalId: "principal-single",
      hashedDeviceId: "hashed-dev-single",
      platform: "macos",
      issuedAt: Date.now(),
    });

    expect(revokeByTokenHash(tokenHash)).toBe(true);
    expect(findActiveByTokenHash(tokenHash)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Guardian vellum migration
// ---------------------------------------------------------------------------

describe("guardian vellum migration", () => {
  test("ensureVellumGuardianBinding creates binding when missing", () => {
    const principalId = ensureVellumGuardianBinding("self");
    expect(principalId).toMatch(/^vellum-principal-/);

    const guardianResult = findGuardianForChannel("vellum");
    expect(guardianResult).not.toBeNull();
    expect(guardianResult!.contact.principalId).toBe(principalId);
    expect(guardianResult!.channel.verifiedVia).toBe("startup-migration");
  });

  test("ensureVellumGuardianBinding is idempotent", () => {
    const first = ensureVellumGuardianBinding("self");
    const second = ensureVellumGuardianBinding("self");
    expect(first).toBe(second);
  });

  test("ensureVellumGuardianBinding preserves existing bindings for other channels", () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "tg-user-123",
      guardianDeliveryChatId: "tg-chat-456",
      guardianPrincipalId: "tg-user-123",
      verifiedVia: "challenge",
    });

    ensureVellumGuardianBinding("self");

    const tgGuardian = findGuardianForChannel("telegram");
    expect(tgGuardian).not.toBeNull();
    expect(tgGuardian!.channel.externalUserId).toBe("tg-user-123");

    const vGuardian = findGuardianForChannel("vellum");
    expect(vGuardian).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bootstrap idempotency (via route handler)
// ---------------------------------------------------------------------------

describe("bootstrap endpoint idempotency", () => {
  test("calling bootstrap twice returns same guardianPrincipalId", async () => {
    const { handleGuardianBootstrap } =
      await import("../runtime/routes/guardian-bootstrap-routes.js");

    const req1 = new Request("http://localhost/v1/guardian/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "macos", deviceId: "test-device-1" }),
    });

    const res1 = await handleGuardianBootstrap(req1, loopbackServer);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as Record<string, unknown>;
    expect(body1.guardianPrincipalId).toBeTruthy();
    expect(body1.accessToken).toBeTruthy();
    expect(body1.isNew).toBe(true);

    // Second call with same device
    const req2 = new Request("http://localhost/v1/guardian/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "macos", deviceId: "test-device-1" }),
    });

    const res2 = await handleGuardianBootstrap(req2, loopbackServer);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2.guardianPrincipalId).toBe(body1.guardianPrincipalId);
    expect(body2.accessToken).toBeTruthy();
    // New token minted (previous revoked), but same principal
    expect(body2.accessToken).not.toBe(body1.accessToken);
    expect(body2.isNew).toBe(false);
  });

  test("bootstrap rejects missing fields", async () => {
    const { handleGuardianBootstrap } =
      await import("../runtime/routes/guardian-bootstrap-routes.js");

    const req = new Request("http://localhost/v1/guardian/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "macos" }),
    });

    const res = await handleGuardianBootstrap(req, loopbackServer);
    expect(res.status).toBe(400);
  });

  test("bootstrap rejects invalid platform", async () => {
    const { handleGuardianBootstrap } =
      await import("../runtime/routes/guardian-bootstrap-routes.js");

    const req = new Request("http://localhost/v1/guardian/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "android", deviceId: "test-device" }),
    });

    const res = await handleGuardianBootstrap(req, loopbackServer);
    expect(res.status).toBe(400);
  });

  test("bootstrap with different devices returns same principal but different tokens", async () => {
    const { handleGuardianBootstrap } =
      await import("../runtime/routes/guardian-bootstrap-routes.js");

    const req1 = new Request("http://localhost/v1/guardian/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "macos", deviceId: "device-A" }),
    });

    const res1 = await handleGuardianBootstrap(req1, loopbackServer);
    const body1 = (await res1.json()) as Record<string, unknown>;

    const req2 = new Request("http://localhost/v1/guardian/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "macos", deviceId: "device-B" }),
    });

    const res2 = await handleGuardianBootstrap(req2, loopbackServer);
    const body2 = (await res2.json()) as Record<string, unknown>;

    // Same principal, different tokens
    expect(body2.guardianPrincipalId).toBe(body1.guardianPrincipalId);
    expect(body2.accessToken).not.toBe(body1.accessToken);
  });

  test("bootstrap access token is a 3-part JWT", async () => {
    const { handleGuardianBootstrap } =
      await import("../runtime/routes/guardian-bootstrap-routes.js");

    const req = new Request("http://localhost/v1/guardian/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "macos",
        deviceId: "test-device-jwt",
      }),
    });

    const res = await handleGuardianBootstrap(req, loopbackServer);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const accessToken = body.accessToken as string;
    expect(accessToken).toBeTruthy();
    // JWTs have 3 dot-separated parts
    expect(accessToken.split(".").length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Local identity resolution
// ---------------------------------------------------------------------------

describe("resolveLocalTrustContext", () => {
  test("returns guardian context when vellum binding exists", () => {
    ensureVellumGuardianBinding("self");

    const ctx = resolveLocalTrustContext();
    expect(ctx.trustClass).toBe("guardian");
    expect(ctx.sourceChannel).toBe("vellum");
  });

  test("returns guardian context with principal when no vellum binding exists (pre-bootstrap self-heal)", () => {
    const ctx = resolveLocalTrustContext();
    expect(ctx.trustClass).toBe("guardian");
    expect(ctx.sourceChannel).toBe("vellum");
    expect(ctx.guardianPrincipalId).toBeDefined();
  });

  test("respects custom sourceChannel parameter", () => {
    ensureVellumGuardianBinding("self");
    const ctx = resolveLocalTrustContext("vellum");
    expect(ctx.sourceChannel).toBe("vellum");
  });
});

// ---------------------------------------------------------------------------
// Local AuthContext resolution
// ---------------------------------------------------------------------------

describe("resolveLocalAuthContext", () => {
  test("returns AuthContext with local principal type", () => {
    const ctx = resolveLocalAuthContext("session-123");
    expect(ctx.principalType).toBe("local");
  });

  test("subject follows local:self:<conversationId> pattern", () => {
    const ctx = resolveLocalAuthContext("session-abc");
    expect(ctx.subject).toBe("local:self:session-abc");
  });

  test("assistantId is always self", () => {
    const ctx = resolveLocalAuthContext("session-123");
    expect(ctx.assistantId).toBe("self");
  });

  test("uses local_v1 scope profile with local.all scope", () => {
    const ctx = resolveLocalAuthContext("session-123");
    expect(ctx.scopeProfile).toBe("local_v1");
    expect(ctx.scopes.has("local.all")).toBe(true);
  });

  test("enriches actorPrincipalId from vellum guardian binding when present", () => {
    ensureVellumGuardianBinding("self");
    const guardianResult = findGuardianForChannel("vellum");
    expect(guardianResult).toBeTruthy();

    const ctx = resolveLocalAuthContext("session-123");
    expect(ctx.actorPrincipalId).toBe(
      guardianResult!.contact.principalId ?? undefined,
    );
  });

  test("actorPrincipalId is auto-created via self-heal when no vellum binding exists", () => {
    // Reset DB to ensure no binding
    resetDb();
    initializeDb();

    const ctx = resolveLocalAuthContext("session-123");
    // Self-heal creates a vellum guardian binding automatically
    expect(ctx.actorPrincipalId).toBeDefined();
    expect(ctx.actorPrincipalId).toMatch(/^vellum-principal-/);
  });

  test("conversationId matches the provided argument", () => {
    const ctx = resolveLocalAuthContext("my-session");
    expect(ctx.conversationId).toBe("my-session");
  });
});

// ---------------------------------------------------------------------------
// Pairing actor-token flow
// ---------------------------------------------------------------------------

describe("pairing credential flow", () => {
  test("mintPairingCredentials returns access token in approved pairing status poll", async () => {
    ensureVellumGuardianBinding("self");

    const { PairingStore } = await import("../daemon/pairing-store.js");
    const { handlePairingRequest, handlePairingStatus } =
      await import("../runtime/routes/pairing-routes.js");

    const store = new PairingStore();
    store.start();

    const pairingRequestId = "test-pair-" + Date.now();
    const pairingSecret = "test-secret-123";
    const bearerToken = "test-bearer";

    store.register({
      pairingRequestId,
      pairingSecret,
      gatewayUrl: "https://gw.test",
    });

    const ctx = {
      pairingStore: store,
      bearerToken,
      featureFlagToken: undefined,
      pairingBroadcast: () => {},
    };

    const pairReq = new Request("http://localhost/v1/pairing/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingRequestId,
        pairingSecret,
        deviceId: "ios-device-1",
        deviceName: "Test iPhone",
      }),
    });

    const pairRes = await handlePairingRequest(pairReq, ctx);
    expect(pairRes.status).toBe(200);
    const pairBody = (await pairRes.json()) as Record<string, unknown>;
    expect(pairBody.status).toBe("pending");

    store.approve(pairingRequestId, bearerToken);

    const statusUrl = new URL(
      `http://localhost/v1/pairing/status?id=${pairingRequestId}&secret=${pairingSecret}`,
    );
    const statusRes = handlePairingStatus(statusUrl, ctx);
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as Record<string, unknown>;
    expect(statusBody.status).toBe("approved");
    expect(statusBody.accessToken).toBeTruthy();
    expect(statusBody.bearerToken).toBe(bearerToken);

    store.stop();
  });

  test("approved access token is available within 5 min TTL window", async () => {
    ensureVellumGuardianBinding("self");

    const { PairingStore } = await import("../daemon/pairing-store.js");
    const { handlePairingRequest, handlePairingStatus } =
      await import("../runtime/routes/pairing-routes.js");

    const store = new PairingStore();
    store.start();

    const pairingRequestId = "test-ttl-" + Date.now();
    const pairingSecret = "test-secret-ttl";
    const bearerToken = "test-bearer-ttl";

    store.register({
      pairingRequestId,
      pairingSecret,
      gatewayUrl: "https://gw.test",
    });

    const ctx = {
      pairingStore: store,
      bearerToken,
      featureFlagToken: undefined,
      pairingBroadcast: () => {},
    };

    const pairReq = new Request("http://localhost/v1/pairing/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingRequestId,
        pairingSecret,
        deviceId: "ios-device-ttl",
        deviceName: "TTL iPhone",
      }),
    });

    await handlePairingRequest(pairReq, ctx);
    store.approve(pairingRequestId, bearerToken);

    const statusUrl = new URL(
      `http://localhost/v1/pairing/status?id=${pairingRequestId}&secret=${pairingSecret}`,
    );
    const firstRes = handlePairingStatus(statusUrl, ctx);
    const firstBody = (await firstRes.json()) as Record<string, unknown>;
    const firstToken = firstBody.accessToken as string;
    expect(firstToken).toBeTruthy();

    const secondRes = handlePairingStatus(statusUrl, ctx);
    const secondBody = (await secondRes.json()) as Record<string, unknown>;
    expect(secondBody.accessToken).toBe(firstToken);

    store.stop();
  });

  test("approved status can recover token mint using deviceId query when transient pairing state is missing", async () => {
    ensureVellumGuardianBinding("self");

    const { PairingStore } = await import("../daemon/pairing-store.js");
    const { cleanupPairingState, handlePairingRequest, handlePairingStatus } =
      await import("../runtime/routes/pairing-routes.js");

    const store = new PairingStore();
    store.start();

    const pairingRequestId = "test-recover-" + Date.now();
    const pairingSecret = "test-secret-recover";
    const bearerToken = "test-bearer-recover";
    const deviceId = "ios-device-recover";

    store.register({
      pairingRequestId,
      pairingSecret,
      gatewayUrl: "https://gw.test",
    });

    const ctx = {
      pairingStore: store,
      bearerToken,
      featureFlagToken: undefined,
      pairingBroadcast: () => {},
    };

    const pairReq = new Request("http://localhost/v1/pairing/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingRequestId,
        pairingSecret,
        deviceId,
        deviceName: "Recovery iPhone",
      }),
    });

    const pairRes = await handlePairingRequest(pairReq, ctx);
    expect(pairRes.status).toBe(200);

    store.approve(pairingRequestId, bearerToken);
    cleanupPairingState(pairingRequestId);

    const statusUrl = new URL(
      `http://localhost/v1/pairing/status?id=${pairingRequestId}&secret=${pairingSecret}&deviceId=${encodeURIComponent(
        deviceId,
      )}`,
    );
    const statusRes = handlePairingStatus(statusUrl, ctx);
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as Record<string, unknown>;

    expect(statusBody.status).toBe("approved");
    expect(statusBody.accessToken).toBeTruthy();
    expect(statusBody.bearerToken).toBe(bearerToken);

    store.stop();
  });

  test("mintingInFlight guard prevents concurrent mints (synchronous check)", async () => {
    ensureVellumGuardianBinding("self");

    const { PairingStore } = await import("../daemon/pairing-store.js");
    const { handlePairingRequest, handlePairingStatus } =
      await import("../runtime/routes/pairing-routes.js");

    const store = new PairingStore();
    store.start();

    const pairingRequestId = "test-concurrent-" + Date.now();
    const pairingSecret = "test-secret-conc";
    const bearerToken = "test-bearer-conc";

    store.register({
      pairingRequestId,
      pairingSecret,
      gatewayUrl: "https://gw.test",
    });

    const ctx = {
      pairingStore: store,
      bearerToken,
      featureFlagToken: undefined,
      pairingBroadcast: () => {},
    };

    const pairReq = new Request("http://localhost/v1/pairing/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairingRequestId,
        pairingSecret,
        deviceId: "ios-device-conc",
        deviceName: "Concurrent iPhone",
      }),
    });

    await handlePairingRequest(pairReq, ctx);
    store.approve(pairingRequestId, bearerToken);

    const statusUrl = new URL(
      `http://localhost/v1/pairing/status?id=${pairingRequestId}&secret=${pairingSecret}`,
    );
    const res1 = handlePairingStatus(statusUrl, ctx);
    const res2 = handlePairingStatus(statusUrl, ctx);

    const body1 = (await res1.json()) as Record<string, unknown>;
    const body2 = (await res2.json()) as Record<string, unknown>;

    expect(body1.status).toBe("approved");
    expect(body2.status).toBe("approved");
    expect(body1.accessToken).toBeTruthy();
    expect(body2.accessToken).toBe(body1.accessToken);

    store.stop();
  });
});

// ---------------------------------------------------------------------------
// Bootstrap private-network guard tests
// ---------------------------------------------------------------------------

describe("bootstrap private-network guard", () => {
  test("rejects bootstrap request with public X-Forwarded-For", async () => {
    const { handleGuardianBootstrap } =
      await import("../runtime/routes/guardian-bootstrap-routes.js");

    const req = new Request("http://localhost/v1/guardian/init", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.1",
      },
      body: JSON.stringify({ platform: "macos", deviceId: "test-device" }),
    });

    const res = await handleGuardianBootstrap(req, loopbackServer);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("local-only");
  });

  test("rejects bootstrap request from public IP peer", async () => {
    const { handleGuardianBootstrap } =
      await import("../runtime/routes/guardian-bootstrap-routes.js");

    const req = new Request("http://localhost/v1/guardian/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "macos", deviceId: "test-device" }),
    });

    const res = await handleGuardianBootstrap(req, nonLoopbackServer);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("local-only");
  });

  test("accepts bootstrap request from loopback IP", async () => {
    const { handleGuardianBootstrap } =
      await import("../runtime/routes/guardian-bootstrap-routes.js");

    const req = new Request("http://localhost/v1/guardian/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "macos", deviceId: "test-device-ok" }),
    });

    const res = await handleGuardianBootstrap(req, loopbackServer);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// fetchSigningKeyFromGateway
// ---------------------------------------------------------------------------

describe("fetchSigningKeyFromGateway", () => {
  const VALID_HEX_KEY = "a".repeat(64); // 64 hex chars = 32 bytes
  const originalEnv = process.env.GATEWAY_INTERNAL_URL;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.GATEWAY_INTERNAL_URL = "http://gateway:7822";
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.GATEWAY_INTERNAL_URL = originalEnv;
    } else {
      delete process.env.GATEWAY_INTERNAL_URL;
    }
    globalThis.fetch = originalFetch;
  });

  test("returns 32-byte buffer on successful 200 response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ key: VALID_HEX_KEY }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const key = await fetchSigningKeyFromGateway();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(key.toString("hex")).toBe(VALID_HEX_KEY);
  });

  test("throws BootstrapAlreadyCompleted on 403 response", async () => {
    globalThis.fetch = (async () =>
      new Response("Forbidden", { status: 403 })) as unknown as typeof fetch;

    await expect(fetchSigningKeyFromGateway()).rejects.toBeInstanceOf(
      BootstrapAlreadyCompleted,
    );
  });

  test("throws timeout error after max retry attempts on persistent failure", async () => {
    // Mock Bun.sleep to avoid waiting 30s in tests
    const origSleep = Bun.sleep;
    Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    try {
      await expect(fetchSigningKeyFromGateway()).rejects.toThrow(
        "timed out waiting for gateway",
      );
      expect(callCount).toBe(30);
    } finally {
      Bun.sleep = origSleep;
    }
  });

  test("throws when GATEWAY_INTERNAL_URL is not set", async () => {
    delete process.env.GATEWAY_INTERNAL_URL;

    await expect(fetchSigningKeyFromGateway()).rejects.toThrow(
      "GATEWAY_INTERNAL_URL not set",
    );
  });

  test("rejects invalid key length", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ key: "aabb" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(fetchSigningKeyFromGateway()).rejects.toThrow(
      "Invalid signing key: expected 64 hex characters",
    );
  });

  test("retries on non-200/non-403 status and eventually succeeds", async () => {
    const origSleep = Bun.sleep;
    Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;

    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount < 3) {
        return new Response("Service Unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({ key: VALID_HEX_KEY }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const key = await fetchSigningKeyFromGateway();
      expect(key.length).toBe(32);
      expect(callCount).toBe(3);
    } finally {
      Bun.sleep = origSleep;
    }
  });
});
