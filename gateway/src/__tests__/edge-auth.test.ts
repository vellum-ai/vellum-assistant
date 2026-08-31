/**
 * Tests for `requireEdgeAuth` and `requireEdgeAuthWithScope` — the
 * client-facing edge guards.
 *
 * Two auth modes (mirrors `requireEdgeGuardianAuth`):
 *
 *  1. Platform-managed (DISABLE_HTTP_AUTH=true + IS_PLATFORM=true): identity
 *     asserted via `X-Vellum-User-Id` header cross-referenced against the
 *     stored `vellum:platform_user_id` credential. Scope authorization is
 *     delegated to the upstream platform proxy.
 *  2. Default: edge JWT validated; scoped guard additionally checks the
 *     scope_profile claim.
 *
 * Importantly, DISABLE_HTTP_AUTH alone (without IS_PLATFORM) does NOT
 * bypass JWT validation — protects against accidental misconfig.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import "./test-preload.js";

// --- Mocks (set BEFORE importing the module under test) -------------------

let mockReadCredential = mock(
  async (_key: string): Promise<string | undefined> => undefined,
);
// Spread the actual module so untouched exports (getWorkspaceDir, …) stay
// importable by transitive dependencies of the modules under test.
const actualCredentialReader = await import("../credential-reader.js");
mock.module("../credential-reader.js", () => ({
  ...actualCredentialReader,
  readCredential: (key: string) => mockReadCredential(key),
}));

let mockValidateEdgeToken = mock(
  (
    _token: string,
  ):
    | { ok: true; claims: { sub: string; scope_profile: string } }
    | { ok: false; reason: string } => ({
    ok: false,
    reason: "noop",
  }),
);
const actualTokenExchange = await import("../auth/token-exchange.js");
mock.module("../auth/token-exchange.js", () => ({
  ...actualTokenExchange,
  validateEdgeToken: (token: string) => mockValidateEdgeToken(token),
}));

const { AuthRateLimiter } = await import("../auth-rate-limiter.js");
const { createAuthMiddleware, loopbackFallbackCountTracker } =
  await import("../http/middleware/auth.js");
const { initGatewayDb, resetGatewayDb, getGatewayDb } =
  await import("../db/connection.js");
const { actorTokenRecords } = await import("../db/schema.js");
const { actorTokenRecordHash, __resetLastUsedDebounceForTests } =
  await import("../auth/actor-token-revocation.js");

const PLATFORM_USER_ID = "user-abc-123";

function makeMiddleware(trustProxy = false) {
  const rl = new AuthRateLimiter();
  return createAuthMiddleware(rl, () => "1.2.3.4", trustProxy);
}

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request("http://gateway.local/v1/something", {
    method: "POST",
    headers,
  });
}

function makeLoopbackServer(address = "127.0.0.1") {
  return {
    requestIP: () => ({ address, port: 12345 }),
  } as never;
}

beforeEach(() => {
  mockReadCredential = mock(async () => undefined);
  mockValidateEdgeToken = mock(() => ({ ok: false, reason: "noop" }));
  loopbackFallbackCountTracker.reset();
});

afterEach(() => {
  delete process.env.DISABLE_HTTP_AUTH;
  delete process.env.IS_PLATFORM;
});

// =========================================================================
// requireEdgeAuth — platform bypass active
// =========================================================================

describe("requireEdgeAuth — DISABLE_HTTP_AUTH + IS_PLATFORM", () => {
  beforeEach(() => {
    process.env.DISABLE_HTTP_AUTH = "true";
    process.env.IS_PLATFORM = "true";
  });

  test("401 when X-Vellum-User-Id header is missing", async () => {
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(makeReq());
    expect(res?.status).toBe(401);
  });

  test("403 when no platform_user_id is stored", async () => {
    mockReadCredential = mock(async () => undefined);
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({ "x-vellum-user-id": PLATFORM_USER_ID }),
    );
    expect(res?.status).toBe(403);
  });

  test("403 when X-Vellum-User-Id does not match stored credential", async () => {
    mockReadCredential = mock(async () => PLATFORM_USER_ID);
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({ "x-vellum-user-id": "different-user" }),
    );
    expect(res?.status).toBe(403);
  });

  test("503 when readCredential throws", async () => {
    mockReadCredential = mock(async () => {
      throw new Error("cred store unavailable");
    });
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({ "x-vellum-user-id": PLATFORM_USER_ID }),
    );
    expect(res?.status).toBe(503);
  });

  test("null (auth ok) when X-Vellum-User-Id matches stored credential", async () => {
    mockReadCredential = mock(async () => PLATFORM_USER_ID);
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({ "x-vellum-user-id": PLATFORM_USER_ID }),
    );
    expect(res).toBeNull();
  });

  test("uses platform header check before tokenless loopback fallback", async () => {
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(makeReq(), makeLoopbackServer());
    expect(res?.status).toBe(401);
    expect(mockReadCredential).not.toHaveBeenCalled();
    expect(mockValidateEdgeToken).not.toHaveBeenCalled();
  });

  test("uses platform header check when a platform bearer is also forwarded", async () => {
    mockReadCredential = mock(async () => PLATFORM_USER_ID);
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({
        "x-vellum-user-id": PLATFORM_USER_ID,
        authorization: "Bearer vak_platform_key",
      }),
    );
    expect(res).toBeNull();
    expect(mockValidateEdgeToken).not.toHaveBeenCalled();
  });
});

// =========================================================================
// requireEdgeAuth — accidental misconfig (only one flag set)
// =========================================================================

describe("requireEdgeAuth — DISABLE_HTTP_AUTH alone is insufficient", () => {
  test("DISABLE_HTTP_AUTH=true without IS_PLATFORM still runs JWT validation", async () => {
    process.env.DISABLE_HTTP_AUTH = "true";
    // IS_PLATFORM intentionally NOT set
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(makeReq());
    // No bearer token + no bypass → 401, NOT a free pass
    expect(res?.status).toBe(401);
  });

  test("IS_PLATFORM=true without DISABLE_HTTP_AUTH still runs JWT validation", async () => {
    process.env.IS_PLATFORM = "true";
    // DISABLE_HTTP_AUTH intentionally NOT set
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(makeReq());
    expect(res?.status).toBe(401);
  });

  test("both flags unset → JWT validation runs", async () => {
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(makeReq());
    expect(res?.status).toBe(401);
  });
});

// =========================================================================
// requireEdgeAuth — default (JWT) mode
// =========================================================================

describe("requireEdgeAuth — JWT mode", () => {
  test("falls back to loopback when Authorization header is absent", async () => {
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(makeReq(), makeLoopbackServer());
    expect(res).toBeNull();
    expect(mockValidateEdgeToken).not.toHaveBeenCalled();
  });

  test("rejects edge-forwarded loopback requests when Authorization header is absent", async () => {
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({ "x-vellum-edge-forwarded": "1" }),
      makeLoopbackServer(),
    );
    expect(res?.status).toBe(401);
    expect(mockValidateEdgeToken).not.toHaveBeenCalled();
    expect(loopbackFallbackCountTracker.snapshot()).toEqual([]);
  });

  test("a loopback fallback is counted by (guard, path, failureKind)", async () => {
    const { requireEdgeAuth } = makeMiddleware();
    await requireEdgeAuth(makeReq(), makeLoopbackServer());
    await requireEdgeAuth(makeReq(), makeLoopbackServer());
    expect(loopbackFallbackCountTracker.snapshot()).toEqual([
      {
        guard: "edge",
        path: "/v1/something",
        failureKind: "missing_authorization",
        count: 2,
      },
    ]);
  });

  test("null on valid bearer token", async () => {
    mockValidateEdgeToken = mock(() => ({
      ok: true,
      claims: { sub: "actor:asst:123", scope_profile: "actor_client_v1" },
    }));
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({ authorization: "Bearer good.jwt.here" }),
    );
    expect(res).toBeNull();
  });

  test("valid bearer token is checked before loopback fallback", async () => {
    mockValidateEdgeToken = mock(() => ({
      ok: true,
      claims: { sub: "actor:asst:123", scope_profile: "actor_client_v1" },
    }));
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({ authorization: "Bearer good.jwt.here" }),
      makeLoopbackServer(),
    );
    expect(res).toBeNull();
    expect(mockValidateEdgeToken).toHaveBeenCalledWith("good.jwt.here");
  });

  test("401 on invalid bearer token", async () => {
    mockValidateEdgeToken = mock(() => ({ ok: false, reason: "expired" }));
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({ authorization: "Bearer bad.jwt.here" }),
    );
    expect(res?.status).toBe(401);
  });

  test("invalid bearer token falls back to loopback", async () => {
    mockValidateEdgeToken = mock(() => ({ ok: false, reason: "expired" }));
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({ authorization: "Bearer bad.jwt.here" }),
      makeLoopbackServer(),
    );
    expect(res).toBeNull();
  });

  test("malformed Authorization header falls back to loopback", async () => {
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({ authorization: "Basic not-a-bearer" }),
      makeLoopbackServer(),
    );
    expect(res).toBeNull();
    expect(mockValidateEdgeToken).not.toHaveBeenCalled();
  });
});

// =========================================================================
// requireEdgeAuthWithScope — same bypass model + scope check on JWT path
// =========================================================================

describe("requireEdgeAuthWithScope — DISABLE_HTTP_AUTH + IS_PLATFORM", () => {
  beforeEach(() => {
    process.env.DISABLE_HTTP_AUTH = "true";
    process.env.IS_PLATFORM = "true";
  });

  test("uses platform header check; no scope check on bypass path", async () => {
    // Even with a scope profile that wouldn't grant the required scope under
    // JWT mode, the bypass path only cross-checks the user header. Scope is
    // enforced upstream by the platform proxy.
    mockReadCredential = mock(async () => PLATFORM_USER_ID);
    const { requireEdgeAuthWithScope } = makeMiddleware();
    const res = await requireEdgeAuthWithScope(
      makeReq({ "x-vellum-user-id": PLATFORM_USER_ID }),
      // any scope — bypass path does not look at it
      "ingress.write",
    );
    expect(res).toBeNull();
  });

  test("uses platform header check when a platform bearer is also forwarded", async () => {
    mockReadCredential = mock(async () => PLATFORM_USER_ID);
    const { requireEdgeAuthWithScope } = makeMiddleware();
    const res = await requireEdgeAuthWithScope(
      makeReq({
        "x-vellum-user-id": PLATFORM_USER_ID,
        authorization: "Bearer vak_platform_key",
      }),
      "ingress.write",
    );
    expect(res).toBeNull();
    expect(mockValidateEdgeToken).not.toHaveBeenCalled();
  });

  test("uses platform header check before tokenless loopback fallback", async () => {
    const { requireEdgeAuthWithScope } = makeMiddleware();
    const res = await requireEdgeAuthWithScope(
      makeReq(),
      "ingress.write",
      makeLoopbackServer(),
    );
    expect(res?.status).toBe(401);
    expect(mockReadCredential).not.toHaveBeenCalled();
    expect(mockValidateEdgeToken).not.toHaveBeenCalled();
  });

  test("401 when X-Vellum-User-Id missing under bypass", async () => {
    const { requireEdgeAuthWithScope } = makeMiddleware();
    const res = await requireEdgeAuthWithScope(makeReq(), "ingress.write");
    expect(res?.status).toBe(401);
  });
});

describe("requireEdgeAuthWithScope — JWT mode", () => {
  test("falls back to loopback when Authorization header is absent", async () => {
    const { requireEdgeAuthWithScope } = makeMiddleware();
    const res = await requireEdgeAuthWithScope(
      makeReq(),
      "chat.write",
      makeLoopbackServer(),
    );
    expect(res).toBeNull();
    expect(mockValidateEdgeToken).not.toHaveBeenCalled();
  });

  test("rejects edge-forwarded loopback requests when scoped Authorization is absent", async () => {
    const { requireEdgeAuthWithScope } = makeMiddleware();
    const res = await requireEdgeAuthWithScope(
      makeReq({ "x-vellum-edge-forwarded": "1" }),
      "settings.write",
      makeLoopbackServer(),
    );
    expect(res?.status).toBe(401);
    expect(mockValidateEdgeToken).not.toHaveBeenCalled();
    expect(loopbackFallbackCountTracker.snapshot()).toEqual([]);
  });

  test("403 when token's scope_profile lacks the required scope", async () => {
    // actor_client_v1 grants chat.* and settings.*, but NOT ingress.write
    mockValidateEdgeToken = mock(() => ({
      ok: true,
      claims: {
        sub: "actor:asst:123",
        scope_profile: "actor_client_v1",
      },
    }));
    const { requireEdgeAuthWithScope } = makeMiddleware();
    const res = await requireEdgeAuthWithScope(
      makeReq({ authorization: "Bearer good.jwt.here" }),
      "ingress.write",
    );
    expect(res?.status).toBe(403);
  });

  test("under-scoped bearer token falls back to loopback", async () => {
    mockValidateEdgeToken = mock(() => ({
      ok: true,
      claims: {
        sub: "actor:asst:123",
        scope_profile: "actor_client_v1",
      },
    }));
    const { requireEdgeAuthWithScope } = makeMiddleware();
    const res = await requireEdgeAuthWithScope(
      makeReq({ authorization: "Bearer good.jwt.here" }),
      "ingress.write",
      makeLoopbackServer(),
    );
    expect(res).toBeNull();
  });

  test("invalid bearer token falls back to loopback", async () => {
    mockValidateEdgeToken = mock(() => ({ ok: false, reason: "expired" }));
    const { requireEdgeAuthWithScope } = makeMiddleware();
    const res = await requireEdgeAuthWithScope(
      makeReq({ authorization: "Bearer bad.jwt.here" }),
      "chat.write",
      makeLoopbackServer(),
    );
    expect(res).toBeNull();
  });

  test("malformed Authorization header falls back to loopback", async () => {
    const { requireEdgeAuthWithScope } = makeMiddleware();
    const res = await requireEdgeAuthWithScope(
      makeReq({ authorization: "Basic not-a-bearer" }),
      "chat.write",
      makeLoopbackServer(),
    );
    expect(res).toBeNull();
    expect(mockValidateEdgeToken).not.toHaveBeenCalled();
  });

  test("null when token's scope_profile contains the required scope", async () => {
    mockValidateEdgeToken = mock(() => ({
      ok: true,
      claims: {
        sub: "actor:asst:123",
        scope_profile: "actor_client_v1",
      },
    }));
    const { requireEdgeAuthWithScope } = makeMiddleware();
    const res = await requireEdgeAuthWithScope(
      makeReq({ authorization: "Bearer good.jwt.here" }),
      "chat.write",
    );
    expect(res).toBeNull();
  });

  test("401 when bearer token missing", async () => {
    const { requireEdgeAuthWithScope } = makeMiddleware();
    const res = await requireEdgeAuthWithScope(makeReq(), "chat.write");
    expect(res?.status).toBe(401);
  });
});

// =========================================================================
// Loopback fallback + trustProxy — proxied-remote vs direct-local
//
// A same-host reverse proxy / tunnel always connects over 127.0.0.1, so the
// raw socket peer is loopback for every forwarded request. trustProxy tells the
// guard to judge by the real client IP (first X-Forwarded-For entry) instead,
// which closes the loopback grace period for proxied REMOTE callers while
// keeping it for genuinely-local clients (no X-Forwarded-For). trustProxy
// defaults false, so existing deployments are unaffected.
// =========================================================================

describe("requireEdgeAuth — trustProxy loopback fallback", () => {
  test("trustProxy=true: proxied remote caller (XFF non-loopback) is NOT granted the fallback → 401", async () => {
    const { requireEdgeAuth } = makeMiddleware(true);
    const res = await requireEdgeAuth(
      makeReq({ "x-forwarded-for": "203.0.113.5" }),
      makeLoopbackServer(),
    );
    expect(res?.status).toBe(401);
  });

  test("trustProxy=true: direct-local caller (no XFF, loopback socket) still gets the fallback → null", async () => {
    const { requireEdgeAuth } = makeMiddleware(true);
    const res = await requireEdgeAuth(makeReq(), makeLoopbackServer());
    expect(res).toBeNull();
  });

  test("trustProxy=true: caller proxied from localhost (XFF=127.0.0.1) still gets the fallback → null", async () => {
    const { requireEdgeAuth } = makeMiddleware(true);
    const res = await requireEdgeAuth(
      makeReq({ "x-forwarded-for": "127.0.0.1" }),
      makeLoopbackServer(),
    );
    expect(res).toBeNull();
  });

  test("trustProxy=true: direct non-loopback peer cannot spoof XFF=127.0.0.1 → 401", async () => {
    // Raw socket peer is NOT loopback (e.g. gateway port exposed directly), so
    // X-Forwarded-For is not trusted and the fallback is refused.
    const { requireEdgeAuth } = makeMiddleware(true);
    const res = await requireEdgeAuth(
      makeReq({ "x-forwarded-for": "127.0.0.1" }),
      makeLoopbackServer("203.0.113.9"),
    );
    expect(res?.status).toBe(401);
  });

  test("trustProxy=false (default): X-Forwarded-For is ignored, loopback socket still gets the fallback → null", async () => {
    const { requireEdgeAuth } = makeMiddleware(false);
    const res = await requireEdgeAuth(
      makeReq({ "x-forwarded-for": "203.0.113.5" }),
      makeLoopbackServer(),
    );
    expect(res).toBeNull();
  });

  test("platform bypass short-circuits before the fallback regardless of trustProxy", async () => {
    process.env.DISABLE_HTTP_AUTH = "true";
    process.env.IS_PLATFORM = "true";
    const { requireEdgeAuth } = makeMiddleware(true);
    // Missing X-Vellum-User-Id, loopback socket, trustProxy on: still the
    // platform 401 (missing user header), NOT a loopback free pass.
    const res = await requireEdgeAuth(makeReq(), makeLoopbackServer());
    expect(res?.status).toBe(401);
  });
});

// =========================================================================
// Device last-used stamping: the edge allow path records activity for the
// presenting device so the "Paired devices" list can show it.
// =========================================================================

describe("requireEdgeAuth: device last-used stamping", () => {
  // Every seeded row belongs to the same device, so a stamp routed through the
  // device lands on whichever row is active.
  function seedTokenRow(rawToken: string, status: "active" | "revoked") {
    const now = Date.now();
    getGatewayDb()
      .insert(actorTokenRecords)
      .values({
        id: `row-${rawToken}`,
        tokenHash: actorTokenRecordHash(rawToken),
        guardianPrincipalId: "guardian-001",
        hashedDeviceId: "hashed-device-web",
        platform: "web",
        status,
        issuedAt: now,
        expiresAt: now + 86_400_000,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  function readLastUsedAt(rawToken: string) {
    return getGatewayDb()
      .select({ lastUsedAt: actorTokenRecords.lastUsedAt })
      .from(actorTokenRecords)
      .where(eq(actorTokenRecords.tokenHash, actorTokenRecordHash(rawToken)))
      .get()?.lastUsedAt;
  }

  // Own the security dir: the shared preload's env vars are already restored by
  // the time this file runs as part of the full suite.
  let savedSecurityDir: string | undefined;
  let dbRoot: string;

  beforeEach(async () => {
    savedSecurityDir = process.env.GATEWAY_SECURITY_DIR;
    dbRoot = mkdtempSync(join(tmpdir(), "edge-auth-last-used-"));
    const securityDir = join(dbRoot, "protected");
    mkdirSync(securityDir, { recursive: true });
    process.env.GATEWAY_SECURITY_DIR = securityDir;
    await initGatewayDb();
    __resetLastUsedDebounceForTests();
    mockValidateEdgeToken = mock(() => ({
      ok: true,
      claims: { sub: "actor:asst:123", scope_profile: "actor_client_v1" },
    }));
  });

  afterEach(() => {
    resetGatewayDb();
    if (savedSecurityDir === undefined) {
      delete process.env.GATEWAY_SECURITY_DIR;
    } else {
      process.env.GATEWAY_SECURITY_DIR = savedSecurityDir;
    }
    try {
      rmSync(dbRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test("stamps last_used_at on the device's active row", async () => {
    seedTokenRow("live-token", "active");
    expect(readLastUsedAt("live-token")).toBeNull();

    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({ authorization: "Bearer live-token" }),
    );

    expect(res).toBeNull();
    expect(readLastUsedAt("live-token")).toBeGreaterThan(0);
  });

  test("a revoked token 401s and stamps nothing", async () => {
    seedTokenRow("dead-token", "revoked");
    seedTokenRow("live-token", "active");

    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({ authorization: "Bearer dead-token" }),
    );

    expect(res?.status).toBe(401);
    expect(readLastUsedAt("live-token")).toBeNull();
    expect(readLastUsedAt("dead-token")).toBeNull();
  });
});

// =========================================================================
// handleCreateToken: derived actor-token rows carry device identity forward
// =========================================================================

const { handleCreateToken } = await import("../http/routes/auth-token.js");
const { initSigningKey, mintToken } =
  await import("../auth/token-service.js");
const { CURRENT_POLICY_EPOCH } = await import("../auth/policy.js");
const { contacts } = await import("../db/schema.js");
const { bustGuardianIntegrityCache } =
  await import("../auth/guardian-integrity.js");

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

describe("handleCreateToken: derived actor-token identity carry-forward", () => {
  const GUARDIAN_PRINCIPAL = "guardian-derived-001";
  const DERIVED_ORIGIN = "http://localhost:5173";

  let dbRoot: string;
  let savedSecurityDir: string | undefined;

  function makeTokenReq(bearerToken: string): Request {
    return new Request("http://gateway.local/auth/token", {
      method: "POST",
      headers: {
        origin: DERIVED_ORIGIN,
        authorization: `Bearer ${bearerToken}`,
      },
    });
  }

  function mintSourceToken(): string {
    return mintToken({
      aud: "vellum-gateway",
      sub: `actor:self:${GUARDIAN_PRINCIPAL}`,
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: 3600,
    });
  }

  function seedSourceActorToken(
    rawToken: string,
    identity: {
      pairingUserAgent: string | null;
      clientReportedName: string | null;
    },
  ) {
    const now = Date.now();
    getGatewayDb()
      .insert(actorTokenRecords)
      .values({
        id: `row-${rawToken}`,
        tokenHash: actorTokenRecordHash(rawToken),
        guardianPrincipalId: GUARDIAN_PRINCIPAL,
        hashedDeviceId: "hashed-device-derived",
        platform: "macos",
        pairingUserAgent: identity.pairingUserAgent,
        clientReportedName: identity.clientReportedName,
        status: "active",
        issuedAt: now,
        expiresAt: now + 86_400_000,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  function findDerivedRow() {
    return getGatewayDb()
      .select()
      .from(actorTokenRecords)
      .where(eq(actorTokenRecords.status, "derived"))
      .get();
  }

  beforeEach(async () => {
    savedSecurityDir = process.env.GATEWAY_SECURITY_DIR;
    dbRoot = mkdtempSync(join(tmpdir(), "auth-token-derived-"));
    const securityDir = join(dbRoot, "protected");
    mkdirSync(securityDir, { recursive: true });
    process.env.GATEWAY_SECURITY_DIR = securityDir;
    await initGatewayDb();

    // Seed a guardian contact so guardianIntegrityState() reads "ok"; a
    // missing guardian row would 401 before the mint is ever reached.
    const now = Date.now();
    getGatewayDb()
      .insert(contacts)
      .values({
        id: "contact-guardian",
        displayName: "guardian",
        role: "guardian",
        principalId: GUARDIAN_PRINCIPAL,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    bustGuardianIntegrityCache();
  });

  afterEach(() => {
    resetGatewayDb();
    bustGuardianIntegrityCache();
    if (savedSecurityDir === undefined) {
      delete process.env.GATEWAY_SECURITY_DIR;
    } else {
      process.env.GATEWAY_SECURITY_DIR = savedSecurityDir;
    }
    try {
      rmSync(dbRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test("copies both identity fields from a source row onto the derived row", async () => {
    const sourceToken = mintSourceToken();
    seedSourceActorToken(sourceToken, {
      pairingUserAgent: "Vellum/1.2 (Macintosh; Intel Mac OS X 10_15_7)",
      clientReportedName: "Alice's MacBook Pro",
    });

    const res = await handleCreateToken(
      makeTokenReq(sourceToken),
      makeLoopbackServer(),
    );

    expect(res.status).toBe(200);
    const derived = findDerivedRow();
    expect(derived?.platform).toBe("macos");
    expect(derived?.pairingUserAgent).toBe(
      "Vellum/1.2 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    expect(derived?.clientReportedName).toBe("Alice's MacBook Pro");
  });

  test("a null-identity source row produces a derived row with nulls and does not throw", async () => {
    const sourceToken = mintSourceToken();
    seedSourceActorToken(sourceToken, {
      pairingUserAgent: null,
      clientReportedName: null,
    });

    const res = await handleCreateToken(
      makeTokenReq(sourceToken),
      makeLoopbackServer(),
    );

    expect(res.status).toBe(200);
    const derived = findDerivedRow();
    expect(derived?.pairingUserAgent).toBeNull();
    expect(derived?.clientReportedName).toBeNull();
  });
});
