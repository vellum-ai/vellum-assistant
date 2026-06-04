/**
 * Tests for the `requireEdgeGuardianAuth` middleware — both modes:
 *
 *  1. Platform-managed (DISABLE_HTTP_AUTH=true + IS_PLATFORM=true): identity
 *     asserted via `X-Vellum-User-Id` header cross-referenced against the
 *     stored `vellum:platform_user_id` credential.
 *  2. Default (laptop / docker / bare-metal): edge JWT validated, then
 *     actor principal is matched against the bound vellum guardian.
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

let mockFindVellumGuardian = mock(
  async (): Promise<{ principalId: string } | null> => null,
);
mock.module("../auth/guardian-bootstrap.js", () => ({
  findVellumGuardian: () => mockFindVellumGuardian(),
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
const { createAuthMiddleware, loopbackFallbackCountTracker } =
  await import("../http/middleware/auth.js");

const PLATFORM_USER_ID = "user-abc-123";
const GUARDIAN_PRINCIPAL = "actor-guardian-xyz";

function makeMiddleware() {
  const rl = new AuthRateLimiter();
  return createAuthMiddleware(rl, () => "1.2.3.4");
}

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request("http://gateway.local/v1/contact-channels/abc/verify", {
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
  mockFindVellumGuardian = mock(async () => null);
  mockValidateEdgeToken = mock(() => ({ ok: false, reason: "noop" }));
  loopbackFallbackCountTracker.reset();
});

afterEach(() => {
  delete process.env.DISABLE_HTTP_AUTH;
  delete process.env.IS_PLATFORM;
});

// =========================================================================
// Platform-managed mode (DISABLE_HTTP_AUTH=true + IS_PLATFORM=true)
// =========================================================================

describe("requireEdgeGuardianAuth — platform header mode", () => {
  beforeEach(() => {
    process.env.DISABLE_HTTP_AUTH = "true";
    process.env.IS_PLATFORM = "true";
  });

  test("returns 401 when X-Vellum-User-Id header is missing", async () => {
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(makeReq());
    expect(res?.status).toBe(401);
  });

  test("returns 503 when readCredential throws (transient cred-store outage)", async () => {
    mockReadCredential = mock(async () => {
      throw new Error("simulated lookup failure");
    });
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(
      makeReq({ "x-vellum-user-id": PLATFORM_USER_ID }),
    );
    expect(res?.status).toBe(503);
  });

  test("returns 403 when no platform_user_id is stored", async () => {
    mockReadCredential = mock(async () => undefined);
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(
      makeReq({ "x-vellum-user-id": PLATFORM_USER_ID }),
    );
    expect(res?.status).toBe(403);
  });

  test("returns 403 when header does not match stored platform_user_id", async () => {
    mockReadCredential = mock(async () => PLATFORM_USER_ID);
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(
      makeReq({ "x-vellum-user-id": "different-user" }),
    );
    expect(res?.status).toBe(403);
  });

  test("returns null (auth ok) when header matches stored platform_user_id", async () => {
    mockReadCredential = mock(async () => PLATFORM_USER_ID);
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(
      makeReq({ "x-vellum-user-id": PLATFORM_USER_ID }),
    );
    expect(res).toBeNull();
  });

  test("uses platform header check before tokenless loopback fallback", async () => {
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(makeReq(), makeLoopbackServer());
    expect(res?.status).toBe(401);
    expect(mockReadCredential).not.toHaveBeenCalled();
    expect(mockValidateEdgeToken).not.toHaveBeenCalled();
    expect(mockFindVellumGuardian).not.toHaveBeenCalled();
  });

  test("uses platform header check when a platform bearer is also forwarded", async () => {
    mockReadCredential = mock(async () => PLATFORM_USER_ID);
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(
      makeReq({
        "x-vellum-user-id": PLATFORM_USER_ID,
        authorization: "Bearer vak_platform_key",
      }),
    );
    expect(res).toBeNull();
    expect(mockValidateEdgeToken).not.toHaveBeenCalled();
    expect(mockFindVellumGuardian).not.toHaveBeenCalled();
  });

  test("falls through to JWT mode when IS_PLATFORM is false (rejects missing bearer token)", async () => {
    // DISABLE_HTTP_AUTH=true but IS_PLATFORM=false → should use JWT path, not
    // platform header path. No JWT provided, so expect 401.
    process.env.IS_PLATFORM = "false";
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(
      makeReq({ "x-vellum-user-id": PLATFORM_USER_ID }),
    );
    expect(res?.status).toBe(401);
  });
});

// =========================================================================
// Default mode (JWT actor-principal == bound guardian)
// =========================================================================

describe("requireEdgeGuardianAuth — actor principal mode", () => {
  test("falls back to loopback when Authorization header is absent", async () => {
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(makeReq(), makeLoopbackServer());
    expect(res).toBeNull();
    expect(mockValidateEdgeToken).not.toHaveBeenCalled();
    expect(mockFindVellumGuardian).not.toHaveBeenCalled();
  });

  test("invalid bearer token falls back to loopback", async () => {
    mockValidateEdgeToken = mock(() => ({ ok: false, reason: "expired" }));
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(
      makeReq({ authorization: "Bearer bad-jwt" }),
      makeLoopbackServer(),
    );
    expect(res).toBeNull();
    expect(mockFindVellumGuardian).not.toHaveBeenCalled();
  });

  test("a guardian loopback fallback is counted under the edge-guardian guard", async () => {
    const { requireEdgeGuardianAuth } = makeMiddleware();
    await requireEdgeGuardianAuth(makeReq(), makeLoopbackServer());
    expect(loopbackFallbackCountTracker.snapshot()).toEqual([
      {
        guard: "edge-guardian",
        path: "/v1/contact-channels/abc/verify",
        failureKind: "missing_authorization",
        count: 1,
      },
    ]);
  });

  test("returns 503 when findVellumGuardian throws (transient assistant DB outage)", async () => {
    mockValidateEdgeToken = mock(() => ({
      ok: true,
      claims: {
        sub: `actor:test-assistant:${GUARDIAN_PRINCIPAL}`,
        scope_profile: "actor_client_v1",
      },
    }));
    mockFindVellumGuardian = mock(async () => {
      throw new Error("assistant DB IPC failed");
    });
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(
      makeReq({ authorization: "Bearer fake-jwt" }),
    );
    expect(res?.status).toBe(503);
  });

  test("guardian mismatch falls back to loopback", async () => {
    mockValidateEdgeToken = mock(() => ({
      ok: true,
      claims: {
        sub: `actor:test-assistant:some-other-actor`,
        scope_profile: "actor_client_v1",
      },
    }));
    mockFindVellumGuardian = mock(async () => ({
      principalId: GUARDIAN_PRINCIPAL,
    }));
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(
      makeReq({ authorization: "Bearer fake-jwt" }),
      makeLoopbackServer(),
    );
    expect(res).toBeNull();
  });

  test("non-actor principal falls back to loopback", async () => {
    mockValidateEdgeToken = mock(() => ({
      ok: true,
      claims: {
        sub: "user:test-user",
        scope_profile: "actor_client_v1",
      },
    }));
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(
      makeReq({ authorization: "Bearer fake-jwt" }),
      makeLoopbackServer(),
    );
    expect(res).toBeNull();
    expect(mockFindVellumGuardian).not.toHaveBeenCalled();
  });

  test("returns 403 when actor principal does not match the bound guardian", async () => {
    mockValidateEdgeToken = mock(() => ({
      ok: true,
      claims: {
        sub: `actor:test-assistant:some-other-actor`,
        scope_profile: "actor_client_v1",
      },
    }));
    mockFindVellumGuardian = mock(async () => ({
      principalId: GUARDIAN_PRINCIPAL,
    }));
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(
      makeReq({ authorization: "Bearer fake-jwt" }),
    );
    expect(res?.status).toBe(403);
  });

  test("returns null (auth ok) when actor principal matches the bound guardian", async () => {
    mockValidateEdgeToken = mock(() => ({
      ok: true,
      claims: {
        sub: `actor:test-assistant:${GUARDIAN_PRINCIPAL}`,
        scope_profile: "actor_client_v1",
      },
    }));
    mockFindVellumGuardian = mock(async () => ({
      principalId: GUARDIAN_PRINCIPAL,
    }));
    const { requireEdgeGuardianAuth } = makeMiddleware();
    const res = await requireEdgeGuardianAuth(
      makeReq({ authorization: "Bearer fake-jwt" }),
    );
    expect(res).toBeNull();
  });
});
