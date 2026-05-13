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

import "./test-preload.js";

// --- Mocks (set BEFORE importing the module under test) -------------------

let mockReadCredential = mock(
  async (_key: string): Promise<string | undefined> => undefined,
);
mock.module("../credential-reader.js", () => ({
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
mock.module("../auth/token-exchange.js", () => ({
  validateEdgeToken: (token: string) => mockValidateEdgeToken(token),
}));

const { AuthRateLimiter } = await import("../auth-rate-limiter.js");
const { createAuthMiddleware } = await import("../http/middleware/auth.js");

const PLATFORM_USER_ID = "user-abc-123";

function makeMiddleware() {
  const rl = new AuthRateLimiter();
  return createAuthMiddleware(rl, () => "1.2.3.4");
}

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request("http://gateway.local/v1/something", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  mockReadCredential = mock(async () => undefined);
  mockValidateEdgeToken = mock(() => ({ ok: false, reason: "noop" }));
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

  test("401 on invalid bearer token", async () => {
    mockValidateEdgeToken = mock(() => ({ ok: false, reason: "expired" }));
    const { requireEdgeAuth } = makeMiddleware();
    const res = await requireEdgeAuth(
      makeReq({ authorization: "Bearer bad.jwt.here" }),
    );
    expect(res?.status).toBe(401);
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

  test("401 when X-Vellum-User-Id missing under bypass", async () => {
    const { requireEdgeAuthWithScope } = makeMiddleware();
    const res = await requireEdgeAuthWithScope(makeReq(), "ingress.write");
    expect(res?.status).toBe(401);
  });
});

describe("requireEdgeAuthWithScope — JWT mode", () => {
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
