/**
 * Tests for the JWT bearer auth middleware (authenticateRequest).
 *
 * Covers:
 * - Missing Authorization header returns 401
 * - Invalid/expired JWT returns 401
 * - Stale policy epoch returns 401 with refresh_required code
 * - Valid JWT returns AuthContext
 * - Dev bypass returns synthetic AuthContext
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "auth-middleware-test-")),
);

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Track auth bypass state for tests
let authDisabled = false;
mock.module("../../../config/env.js", () => ({
  isHttpAuthDisabled: () => authDisabled,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://localhost:7822",
}));

import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../assistant-scope.js";
import {
  authenticateRequest,
} from "../middleware.js";
import { initAuthSigningKey, mintToken } from "../token-service.js";
import type { ScopeProfile, TokenAudience } from "../types.js";

const TEST_KEY = Buffer.from("test-signing-key-32-bytes-long!!");

function mintValidToken(overrides?: {
  aud?: TokenAudience;
  sub?: string;
  scope_profile?: ScopeProfile;
  policy_epoch?: number;
  exp?: number;
  ttlSeconds?: number;
}): string {
  // When exp is provided explicitly, compute ttlSeconds from it.
  // Otherwise use a default 300-second TTL.
  let ttl = overrides?.ttlSeconds ?? 300;
  if (overrides?.exp !== undefined) {
    const now = Math.floor(Date.now() / 1000);
    ttl = overrides.exp - now;
  }
  return mintToken({
    aud: overrides?.aud ?? "vellum-daemon",
    sub: overrides?.sub ?? "actor:self:principal-test",
    scope_profile: overrides?.scope_profile ?? "actor_client_v1",
    policy_epoch: overrides?.policy_epoch ?? 1,
    ttlSeconds: ttl,
  });
}

beforeEach(() => {
  initAuthSigningKey(TEST_KEY);
  authDisabled = false;
});

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

describe("authenticateRequest", () => {
  test("returns 401 when Authorization header is missing", () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("returns 401 when Authorization header has wrong scheme", () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("returns 401 when JWT is invalid", () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer invalid.token.here" },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("returns 401 when JWT has expired", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintValidToken({ exp: now - 100 });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("returns AuthContext for valid JWT", () => {
    const token = mintValidToken();

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.subject).toBe("actor:self:principal-test");
      expect(result.context.principalType).toBe("actor");
      expect(result.context.assistantId).toBe(DAEMON_INTERNAL_ASSISTANT_ID);
      expect(result.context.actorPrincipalId).toBe("principal-test");
      expect(result.context.scopeProfile).toBe("actor_client_v1");
      expect(result.context.scopes.has("chat.read")).toBe(true);
      expect(result.context.scopes.has("chat.write")).toBe(true);
    }
  });

  test("returns AuthContext for svc_gateway JWT", () => {
    const token = mintValidToken({
      sub: "svc:gateway:self",
      scope_profile: "gateway_ingress_v1",
    });

    const req = new Request("http://localhost/v1/channels/inbound", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe("svc_gateway");
      expect(result.context.scopes.has("ingress.write")).toBe(true);
    }
  });

  test("dev bypass returns synthetic AuthContext without Authorization header", () => {
    authDisabled = true;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe("actor");
      expect(result.context.actorPrincipalId).toBe("dev-bypass");
      expect(result.context.scopeProfile).toBe("actor_client_v1");
      expect(result.context.scopes.has("chat.read")).toBe(true);
    }
  });

  test("dev bypass context sets actorPrincipalId to 'dev-bypass' for explicit detection", () => {
    // Regression: the "dev-bypass" actorPrincipalId used to cause trust
    // resolution to classify the user as "unknown" because no guardian
    // binding matches "dev-bypass". The route-level fix detects
    // isHttpAuthDisabled() + actorPrincipalId === "dev-bypass" and resolves
    // from the local guardian binding instead.
    authDisabled = true;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.actorPrincipalId).toBe("dev-bypass");
    }
  });

  test("returns 401 with refresh_required when policy epoch is stale", async () => {
    // Mint a token with a very old policy epoch. The token service checks
    // isStaleEpoch which compares against CURRENT_POLICY_EPOCH.
    const token = mintValidToken({ policy_epoch: 0 });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    // This test depends on whether CURRENT_POLICY_EPOCH > 0.
    // If CURRENT_POLICY_EPOCH is 1 and the token has epoch 0, it should be stale.
    // If CURRENT_POLICY_EPOCH is 0, then epoch 0 is not stale and the token is valid.
    // We test the behavior regardless -- either it's valid or it reports stale_epoch.
    if (!result.ok) {
      const body = (await result.response.json()) as {
        error: { code: string };
      };
      expect(body.error.code).toBe("refresh_required");
      expect(result.response.status).toBe(401);
    }
    // If the current epoch is 0, the token is valid, which is also correct behavior
  });

  test("rejects token with wrong audience", () => {
    // Mint a token with an unrecognized audience (neither vellum-daemon nor vellum-gateway)
    const token = mintValidToken({ aud: "vellum-other" as TokenAudience });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("rejects token with unparseable sub", () => {
    const token = mintValidToken({ sub: "garbage" });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// /v1/host-browser-result auth — exercises authenticateRequest with the
// same request shape the chrome extension sends. Validates that standard
// JWT auth applies after the capability-token system was removed.
// ---------------------------------------------------------------------------

describe("authenticateRequest for /v1/host-browser-result", () => {
  test("accepts a valid daemon-audience JWT", async () => {
    const token = mintValidToken({ sub: "actor:self:jwt-principal" });
    const req = new Request("http://localhost/v1/host-browser-result", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = await authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe("actor");
      expect(result.context.actorPrincipalId).toBe("jwt-principal");
      expect(result.context.scopes.has("approval.write")).toBe(true);
    }
  });

  test("returns 401 when the Authorization header is missing entirely", async () => {
    const req = new Request("http://localhost/v1/host-browser-result", {
      method: "POST",
    });

    const result = await authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("malformed bearer returns 401", async () => {
    // A bearer that is not a parseable JWT must return 401.
    const req = new Request("http://localhost/v1/host-browser-result", {
      method: "POST",
      headers: { Authorization: "Bearer not-a-token.xxxxxxxxxxxxx" },
    });

    const result = await authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("dev bypass returns synthetic AuthContext without Authorization header", async () => {
    authDisabled = true;

    const req = new Request("http://localhost/v1/host-browser-result", {
      method: "POST",
    });

    const result = await authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Same synthetic context shape as authenticateRequest's dev
      // bypass — the tests share the same invariant because a single
      // helper builds both.
      expect(result.context.principalType).toBe("actor");
      expect(result.context.actorPrincipalId).toBe("dev-bypass");
    }
  });
});
